import { tagNameOf, type MyClawConfig, type ResolvedLlmConfig } from "../core/config.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import { agentTypeOf, type SessionData } from "../sessions/store.ts";
import type { AgentBackend, ReasoningSink, TokenCallback, ToolStartCallback, ToolUseCallback, TurnSwitchCallback, MediaStoreHook } from "./backend.ts";
import { AgentBridge } from "./bridge.ts";
import { MessagePreprocessor } from "./preprocess.ts";
import { resolveRunModel, type RunModel, type RunModelOverride } from "../llm/run-model.ts";
import { withoutEndpoint } from "../llm/model-ref.ts";
import { announceModelFallback } from "../llm/fallback-notice.ts";
import { hooks } from "../hooks/index.ts";
import { availabilityWorld } from "../llm/world.ts";
import { log } from "../utils/logger.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import type { VoiceManager, SttPipeline } from "../voice/index.ts";

/**
 * Routes each run to the home OpenAI-compatible loop. The engine is picked per run,
 * driven by `providers[].type` and the session's `modelOverride`, so `/model` flips a
 * chat between engines with zero process state. A single preprocessor keeps echoes and
 * response attachments retrievable.
 */
export class BackendDispatcher implements AgentBackend {
  private preprocessor: MessagePreprocessor;
  private home: AgentBridge;

  constructor(
    private config: MyClawConfig,
    toolRegistry: ToolRegistry,
    skillRegistry: SkillRegistry,
    voiceManager?: VoiceManager,
    sttPipeline?: SttPipeline,
    // Test seam: routing behavior is observable without spinning a real engine.
    overrides?: { home?: AgentBridge },
    agentRegistry?: AgentRegistry,
  ) {
    this.preprocessor = new MessagePreprocessor(voiceManager, sttPipeline);
    this.home = overrides?.home ?? new AgentBridge(
      config, toolRegistry, skillRegistry, voiceManager, sttPipeline,
      0, undefined, undefined, undefined, this.preprocessor, agentRegistry,
    );
  }
  /**
   * The model this run will actually use, and the route that chose it.
   *
   * The failure handling does not live here: the bridge makes every model call, so it is the only
   * place that knows whether the failing call had already written something, and the only one that
   * can move the run to another provider *without* replaying the work it already did. This method
   * decides where the run starts and which engine serves it; src/llm/provider-fallback.ts decides
   * where it goes when the provider falls.
   */
  private resolveRun(message: UnifiedMessage, session: SessionData, forcedModelId?: string): RunModel {
    const hasImages = message.attachments.some((a) => a.type === "image" && Boolean(a.path));
    // A root run, so cron or main -- read off the session like every other place that asks.
    const agent = agentTypeOf(session) === "cron" ? "cron" : "main";
    // Stale per-session override after a config edit: a removed *model* falls through the
    // resolver silently (default provider + unknown id sent to the API), a removed
    // *provider* throws on every message. Both self-heal to the default model. A forced
    // reroute id comes from the resolver, so it is always real.
    const models = this.config.llm.models;
    // A tag reference stays live even though it is absent from `llm.models`: it resolves through
    // config.tags, which the llm view carries (see docs/tags.md). A deleted tag is deliberately
    // kept as a live reference too: the resolver falls it back to the virtual Default tag, and
    // recreating the same name later reactivates the alias without rewriting the session.
    // The pin is a route on top of a model, not a model: judge the model under it, or every
    // pinned override reads as removed and is wiped on the first message (docs/model-identity.md).
    const pick = withoutEndpoint(session.modelOverride ?? "");
    const tagName = tagNameOf(pick);
    const tagReference = tagName !== undefined;
    if (!forcedModelId && session.modelOverride && models?.length && !tagReference && !models.some((m) => m.id === pick)) {
      void log("warn", "session modelOverride no longer in config; falling back to default", {
        sessionId: session.id,
        modelOverride: session.modelOverride,
      });
      delete session.modelOverride;
    }
    // One resolution for the run, and it is this one: the engine below is picked from it, so a
    // second chain computed anywhere else would choose the process for a model it did not pick.
    const request = {
      agent,
      ...(forcedModelId ? { forcedModel: forcedModelId } : {}),
      ...(session.modelOverride ? { sessionModel: session.modelOverride } : {}),
      ...(session.effortOverride ? { sessionEffort: session.effortOverride } : {}),
      ...(session.scopeEffort ? { sessionScopeEffort: session.scopeEffort } : {}),
      hasImages,
    };
    let resolved: RunModel;
    try {
      resolved = resolveRunModel(this.config, request, availabilityWorld());
    } catch (err) {
      if (!session.modelOverride || forcedModelId) throw err;
      void log("warn", "session modelOverride no longer resolves; falling back to default", {
        sessionId: session.id,
        modelOverride: session.modelOverride,
        error: String(err),
      });
      delete session.modelOverride;
      resolved = resolveRunModel(this.config, { ...request, sessionModel: undefined }, availabilityWorld());
    }
    // Route preflight notices are emitted by runResolved with the route transition. The
    // legacy source-chain notice remains here, where the run-level dedupe can cover bridge re-resolution.
    const hasRoutePreflight = Boolean(resolved.route) || resolved.skipped.some((entry) => entry.origin.startsWith("tags.") && entry.origin.includes(".route["));
    if (!hasRoutePreflight) announceModelFallback(resolved, message, agent);
    return resolved;
  }

  // The engine is picked from the model that will actually run, so the agent's configured
  // default has to be merged in here too.
  private engineFor(_resolved: ResolvedLlmConfig): AgentBackend {
    return this.home;
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
  }

  setMediaStore(store: MediaStoreHook | undefined): void {
    this.home.setMediaStore(store);
  }

  setConversationQuotaRetry(enabled: boolean): void {
    this.home.setConversationQuotaRetry(enabled);
  }

  handleMessage(message: UnifiedMessage, session: SessionData, signal?: AbortSignal): Promise<string> {
    const resolved = this.resolveRun(message, session);
    return this.runResolved(resolved, message, session, (backend, modelId, modelOverride) =>
      backend.handleMessage(message, session, signal, modelId, modelOverride), { signal });
  }

  handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: TokenCallback,
    onToolUse?: ToolUseCallback,
    signal?: AbortSignal,
    onTurnSwitch?: TurnSwitchCallback,
    modelId?: string,
    reasoning?: ReasoningSink,
    onToolStart?: ToolStartCallback,
  ): Promise<string> {
    const resolved = this.resolveRun(message, session, modelId);
    return this.runResolved(
      resolved,
      message,
      session,
      (backend, resolvedModelId, modelOverride) =>
        backend.handleMessageStreaming(message, session, onToken, onToolUse, signal, onTurnSwitch, resolvedModelId, reasoning, onToolStart, modelOverride),
      {
        signal,
      },
    );
  }

  /**
   * One run on the model that resolution picked, with the notices a route owes before it starts.
   *
   * Nothing here retries or reroutes: a provider that falls mid-run is handled where the call is
   * made (the bridge), because only that layer knows what the run had already done and what the
   * failing call had already written.
   */
  private async runResolved(
    resolved: RunModel,
    message: UnifiedMessage,
    session: SessionData,
    run: (backend: AgentBackend, modelId?: string, modelOverride?: RunModelOverride) => Promise<string>,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const preflightRouteEntries = resolved.skipped.filter(entry => entry.origin.startsWith("tags.") && entry.origin.includes(".route["));
    if (resolved.route || preflightRouteEntries.length > 0) {
      const routeName = resolved.route?.tag ?? preflightRouteEntries[0]?.origin.split(".")[1] ?? "route";
      for (const skipped of resolved.route
        ? resolved.skipped.filter(entry => entry.origin.startsWith(`tags.${resolved.route!.tag}.route[`))
        : preflightRouteEntries) {
        const note = `[fallback] ${routeName}: ${skipped.model} was unavailable before the run (${skipped.availability.state}); using ${resolved.model} instead.`;
        void log("warn", "model route preflight fallback", {
          sessionId: session.id,
          messageId: message.id,
          requestedModel: resolved.requestedModel ?? `tag:${routeName}`,
          failedModel: skipped.model,
          targetModel: resolved.model,
          reason: skipped.availability.state,
        });
        // Out of band, like the bridge's own notes: the app draws a notice, the answer stays the
        // answer. It used to ride the token stream -- see the event's own note.
        hooks.emit("provider:notice", {
          platform: message.platform,
          chatId: message.chatId,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          sessionId: session.id,
          note,
        });
      }
    }

    const candidateOverride = (candidate: { effort?: RunModelOverride["effort"]; contextCap?: number }): RunModelOverride | undefined => {
      if (candidate.effort === undefined && candidate.contextCap === undefined) return undefined;
      return {
        ...(candidate.effort !== undefined ? { effort: candidate.effort } : {}),
        ...(candidate.contextCap !== undefined ? { contextCap: candidate.contextCap } : {}),
      };
    };

    try {
      const firstCandidate = resolved.route?.candidates[resolved.route.selectedIndex];
      return await run(
        this.engineFor(resolved),
        resolved.route ? resolved.model : undefined,
        resolved.route ? candidateOverride(firstCandidate ?? {}) : undefined,
      );
    } catch (error) {
      // The notes were delivered as notices before the run started, so the failure travels as
      // itself: an error bubble prefixed with three `[fallback]` lines reads as four errors.
      throw error;
    }
  }
}
