import { resolveAgentLlm, type MyClawConfig } from "../core/config.ts";
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
import type { VoiceManager, SttPipeline } from "../voice/index.ts";

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
  ) {
    this.preprocessor = new MessagePreprocessor(voiceManager, sttPipeline);
    this.home = overrides?.home ?? new AgentBridge(
      config, toolRegistry, skillRegistry, voiceManager, sttPipeline,
      0, undefined, undefined, undefined, this.preprocessor,
    );
    this.sdk = overrides?.sdk ?? new ClaudeSdkBackend(
      config, toolRegistry, skillRegistry, voiceManager, sttPipeline,
      0, undefined, undefined, undefined, this.preprocessor,
    );
  }

  private backendFor(message: UnifiedMessage, session: SessionData): AgentBackend {
    const hasImages = message.attachments.some((a) => a.type === "image" && Boolean(a.path));
    // Stale per-session override after a config edit: a removed *model* falls through the
    // resolver silently (default provider + unknown id sent to the API), a removed
    // *provider* throws on every message. Both self-heal to the default model.
    const models = this.config.llm.models;
    if (session.modelOverride && models?.length && !models.some((m) => m.id === session.modelOverride)) {
      void log("warn", "session modelOverride no longer in config; falling back to default", {
        sessionId: session.id,
        modelOverride: session.modelOverride,
      });
      delete session.modelOverride;
    }
    // The engine is picked from the model that will actually run, so the agent's configured
    // default has to be merged in here too: resolving without it would route a claude-sdk model
    // configured for cron into the home loop, which then quietly ran a different model.
    const agentLlm = resolveAgentLlm(this.config, message.platform === "cron" ? "cron" : "main");
    let resolved;
    try {
      resolved = resolveLlmConfigForAgentMessage(this.config.llm, agentLlm, session.modelOverride, hasImages);
    } catch (err) {
      if (!session.modelOverride) throw err;
      void log("warn", "session modelOverride no longer resolves; falling back to default", {
        sessionId: session.id,
        modelOverride: session.modelOverride,
        error: String(err),
      });
      delete session.modelOverride;
      resolved = resolveLlmConfigForAgentMessage(this.config.llm, agentLlm, undefined, hasImages);
    }
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

  transcriptOf(messageId: string): string | undefined {
    return this.preprocessor.transcriptOf(messageId);
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
    return this.backendFor(message, session).handleMessage(message, session, signal);
  }

  handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: TokenCallback,
    onToolUse?: ToolUseCallback,
    signal?: AbortSignal,
    onTurnSwitch?: TurnSwitchCallback,
  ): Promise<string> {
    return this.backendFor(message, session).handleMessageStreaming(message, session, onToken, onToolUse, signal, onTurnSwitch);
  }
}
