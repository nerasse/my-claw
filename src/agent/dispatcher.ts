import { resolveAgentLlm, tagNameOf, type MyClawConfig, type ResolvedLlmConfig } from "../core/config.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import type { AgentBackend, TokenCallback, ToolUseCallback, TurnSwitchCallback } from "./backend.ts";
import { AgentBridge } from "./bridge.ts";
import { ClaudeSdkBackend } from "./claude-sdk/backend.ts";
import { MessagePreprocessor } from "./preprocess.ts";
import { resolveLlmConfigForAgentMessage } from "../llm/resolver.ts";
import { runRegistry } from "../core/run-registry.ts";
import { log } from "../utils/logger.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import type { VoiceManager, SttPipeline } from "../voice/index.ts";

// A failure of the *provider itself* — outage-class statuses (server errors, quota/credit
// exhausted) and network/transient errors — is reroutable. 4xx that are not quota/credit are
// request-specific (a malformed request, a bad key): rerouting would mask a config mistake,
// exactly like the retry loop refuses to count them toward the circuit breaker.
const OUTAGE_STATUSES = new Set([402, 403, 429]);
const OUTAGE_TEXT = /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR_|fetch failed|overloaded|rate limit|quota|credit|balance|subscription/i;

function isOutageClass(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  if (typeof status === "number") {
    if (OUTAGE_STATUSES.has(status)) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  const message = String((err as Error | undefined)?.message ?? err ?? "");
  // The circuit breaker is global state: when it is open every provider is blocked, so a
  // reroute to the default would fail with the same message and swallow the real one.
  if (/\bLLM circuit breaker open\b/.test(message)) return false;
  return OUTAGE_TEXT.test(message);
}

/**
 * Routes each run to the engine of its resolved model: the home OpenAI-compatible loop
 * or the Claude Agent SDK (docs/claude-sdk-backend.md). The choice is per run, driven by
 * `providers[].type` and the session's `modelOverride`, so `/model` flips a chat between
 * engines with zero process state. Both backends share one preprocessor: echoes and
 * response attachments stay retrievable regardless of which engine handled the message.
 */
export class BackendDispatcher implements AgentBackend {
  private preprocessor: MessagePreprocessor;
  private home: AgentBridge;
  private sdk: ClaudeSdkBackend;

  constructor(
    private config: MyClawConfig,
    toolRegistry: ToolRegistry,
    skillRegistry: SkillRegistry,
    voiceManager?: VoiceManager,
    sttPipeline?: SttPipeline,
    // Test seam: routing behavior is observable without spinning real engines.
    overrides?: { home?: AgentBridge; sdk?: ClaudeSdkBackend },
    agentRegistry?: AgentRegistry,
  ) {
    this.preprocessor = new MessagePreprocessor(voiceManager, sttPipeline);
    this.home = overrides?.home ?? new AgentBridge(
      config, toolRegistry, skillRegistry, voiceManager, sttPipeline,
      0, undefined, undefined, undefined, this.preprocessor, agentRegistry,
    );
    this.sdk = overrides?.sdk ?? new ClaudeSdkBackend(
      config, toolRegistry, skillRegistry, voiceManager, sttPipeline,
      0, undefined, undefined, undefined, this.preprocessor, undefined, agentRegistry,
    );
  }

  // The pair of resolutions that matters for a run: the model it will actually use, and the
  // model the default provider would run — the target of an outage fallback. `forcedModelId`
  // carries the reroute target on the fallback run itself; the session is never mutated, so
  // the next message resolves the user's own choice again.
  private resolvePair(
    message: UnifiedMessage,
    session: SessionData,
    forcedModelId?: string,
  ): { resolved: ResolvedLlmConfig; defaultResolved: ResolvedLlmConfig } {
    const hasImages = message.attachments.some((a) => a.type === "image" && Boolean(a.path));
    const agentLlm = resolveAgentLlm(this.config, message.platform === "cron" ? "cron" : "main");
    // Stale per-session override after a config edit: a removed *model* falls through the
    // resolver silently (default provider + unknown id sent to the API), a removed
    // *provider* throws on every message. Both self-heal to the default model. A forced
    // reroute id comes from the resolver, so it is always real.
    const modelId = forcedModelId ?? session.modelOverride;
    const models = this.config.llm.models;
    // A tag reference stays live even though it is absent from `llm.models`: it resolves
    // through config.tags, which the llm view carries (see docs/tags.md). Only a tag that no
    // longer exists self-heals like a removed model.
    const tagName = tagNameOf(session.modelOverride ?? "");
    const liveTag = tagName !== undefined && (tagName === "Default" || this.config.tags?.[tagName] !== undefined);
    if (!forcedModelId && session.modelOverride && models?.length && !liveTag && !models.some((m) => m.id === session.modelOverride)) {
      void log("warn", "session modelOverride no longer in config; falling back to default", {
        sessionId: session.id,
        modelOverride: session.modelOverride,
      });
      delete session.modelOverride;
    }
    let resolved: ResolvedLlmConfig;
    try {
      resolved = resolveLlmConfigForAgentMessage(this.config.llm, agentLlm, modelId, hasImages);
    } catch (err) {
      if (!session.modelOverride || forcedModelId) throw err;
      void log("warn", "session modelOverride no longer resolves; falling back to default", {
        sessionId: session.id,
        modelOverride: session.modelOverride,
        error: String(err),
      });
      delete session.modelOverride;
      resolved = resolveLlmConfigForAgentMessage(this.config.llm, agentLlm, undefined, hasImages);
    }
    const defaultResolved = resolveLlmConfigForAgentMessage(this.config.llm, agentLlm, undefined, hasImages);
    return { resolved, defaultResolved };
  }

  // The engine is picked from the model that will actually run, so the agent's configured
  // default has to be merged in here too: resolving without it would route a claude-sdk model
  // configured for cron into the home loop, which then quietly ran a different model.
  private engineFor(resolved: ResolvedLlmConfig): AgentBackend {
    return resolved.backend === "claude-sdk" ? this.sdk : this.home;
  }

  preprocessMessage(message: UnifiedMessage): Promise<void> {
    return this.preprocessor.preprocessMessage(message);
  }

  getEchoMessages(messageId: string): OutgoingMessage[] {
    return this.preprocessor.consumeEchoMessages(messageId);
  }

  getResponseAttachments(messageId: string): OutgoingMessage["attachments"] {
    return this.preprocessor.consumeResponseAttachments(messageId);
  }

  hadAudioInbound(messageId: string): boolean {
    return this.preprocessor.inboundHadAudio(messageId);
  }

  transcriptsOf(messageId: string): Array<{ path: string; text: string }> {
    return this.preprocessor.transcriptsOf(messageId);
  }

  setApprovalHandler(handler: ToolApprovalHandler | undefined): void {
    this.home.setApprovalHandler(handler);
    this.sdk.setApprovalHandler(handler);
  }

  /** /compact for a session whose history is owned by the SDK (see ClaudeSdkBackend.compact). */
  async compactSdkSession(session: SessionData): Promise<string> {
    // Meta-commands bypass the router's session lock; two CLI processes resuming the same
    // SDK session would race on its file.
    if (runRegistry.isRunning(session.id)) {
      return "A run is active on this session — try again once it finishes (or /stop first).";
    }
    return this.sdk.compact(session);
  }

  handleMessage(message: UnifiedMessage, session: SessionData, signal?: AbortSignal): Promise<string> {
    return this.runWithFallback(message, session, (backend, modelId) => backend.handleMessage(message, session, signal, modelId));
  }

  handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: TokenCallback,
    onToolUse?: ToolUseCallback,
    signal?: AbortSignal,
    onTurnSwitch?: TurnSwitchCallback,
  ): Promise<string> {
    // A reroute replays the run from scratch, which would duplicate whatever tokens were
    // already delivered; the fallback only ever fires before the first token.
    let tokensDelivered = false;
    const gate = async (token: string): Promise<void> => {
      tokensDelivered = true;
      await onToken(token);
    };
    return this.runWithFallback(
      message,
      session,
      (backend, modelId) => backend.handleMessageStreaming(message, session, gate, onToolUse, signal, onTurnSwitch, modelId),
      {
        anyTokensDelivered: () => tokensDelivered,
        // The streaming channel shows the note live; the returned text (persisted as the
        // reply) carries it too, so the live bubble and the history stay in agreement.
        onFallbackNote: async (note) => onToken(`${note}\n\n`),
      },
    );
  }

  /**
   * One reroute, and only ever one: when the run's provider is not the default provider and it
   * fails with an outage-class error (network, 5xx, quota/credit), the whole run is replayed on
   * the default provider's model. Nothing is persisted — the session's own choice survives, so
   * the next message tries it again and returns to it as soon as the provider recovers. A
   * fallback run failing the same way is the real error and surfaces as such: it cannot recurse
   * because the reroute target is the default provider, and the guard below only fires for
   * non-default providers.
   */
  private async runWithFallback(
    message: UnifiedMessage,
    session: SessionData,
    run: (backend: AgentBackend, modelId?: string) => Promise<string>,
    options: { anyTokensDelivered?: () => boolean; onFallbackNote?: (note: string) => Promise<void> } = {},
  ): Promise<string> {
    const { resolved, defaultResolved } = this.resolvePair(message, session);
    try {
      return await run(this.engineFor(resolved), undefined);
    } catch (err) {
      // The token check must run here, after the failure: it is only meaningful once the run
      // has actually streamed. The provider/model guards are run-time constants per message.
      if (
        options.anyTokensDelivered?.() ||
        !isOutageClass(err) ||
        resolved.provider === defaultResolved.provider ||
        resolved.model === defaultResolved.model
      ) {
        throw err;
      }
      void log("warn", "provider outage; rerouting the run to the default provider", {
        sessionId: session.id,
        failedModel: resolved.model,
        failedProvider: resolved.provider,
        reason: String(err),
        targetModel: defaultResolved.model,
      });
      const note = `[fallback] ${resolved.model} via ${resolved.provider} is unavailable (${String((err as Error | undefined)?.message ?? err).slice(0, 200)}). This run used ${defaultResolved.model} instead; it returns to ${resolved.model} once the provider recovers.`;
      if (options.onFallbackNote) await options.onFallbackNote(note);
      const result = await run(this.engineFor(defaultResolved), defaultResolved.model);
      return `${note}\n\n${result}`;
    }
  }
}
