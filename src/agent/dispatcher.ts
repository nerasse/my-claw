import { resolveAgentLlm, tagNameOf, providerRetryDelays, type MyClawConfig, type ResolvedLlmConfig } from "../core/config.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import type { AgentBackend, ReasoningSink, TokenCallback, ToolStartCallback, ToolUseCallback, TurnSwitchCallback, MediaStoreHook } from "./backend.ts";
import { AgentBridge } from "./bridge.ts";
import { MessagePreprocessor } from "./preprocess.ts";
import { resolveLlmConfigForAgentMessage } from "../llm/resolver.ts";
import { resolveRunModel, type RunModel, type RunModelOverride } from "../llm/run-model.ts";
import { withoutEndpoint } from "../llm/model-ref.ts";
import { announceModelFallback } from "../llm/fallback-notice.ts";
import { availabilityWorld } from "../llm/world.ts";
import { log } from "../utils/logger.ts";
import { sleep } from "../core/aborted.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import type { VoiceManager, SttPipeline } from "../voice/index.ts";

// A failure of the *provider itself* — outage-class statuses (server errors, payment required,
// rate limited) and network/transient errors — is reroutable. Other 4xx are request-specific
// (a malformed request, a bad key, a policy refusal): rerouting would mask a config mistake,
// exactly like the retry loop refuses to count them toward the circuit breaker.
const OUTAGE_STATUSES = new Set([402, 408, 425, 429, 500, 502, 503, 504, 529]);
const OUTAGE_TEXT = /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR_|fetch failed|overloaded|rate limit|quota|credit|balance|subscription/i;
/**
 * The body saying, in its own words, that the fault is on the far side.
 *
 * A gateway has no status of its own for "my upstream answered with something that was not JSON",
 * so it reaches for whatever its edge returns -- OpenCode Go sends a **403** for exactly that, and
 * 403 is where this predicate used to stop reading. The message is the evidence and the status is
 * an accident of the edge, so the message wins. Measured 2026-09-20: a ten-minute run with
 * twenty-six tool calls died on it while a healthy second route candidate sat unused.
 */
const UPSTREAM_FAULT = /\[server_error\]|upstream response was not valid json|upstream request failed|bad gateway|invalid upstream|upstream (?:error|failure|timeout)/i;

function isOutageClass(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  const message = String((err as Error | undefined)?.message ?? err ?? "");
  if (UPSTREAM_FAULT.test(message)) return true;
  if (typeof status === "number") {
    if (OUTAGE_STATUSES.has(status) || (status >= 500 && status < 600)) return true;
    if (status === 401) return true;
    if (status === 403) return /auth|unauthori[sz]ed|credential|api[- ]?key|permission|forbidden/i.test(message);
    if (status === 404) return /model|endpoint|no endpoints|not found/i.test(message);
    return false;
  }
  return /LLM circuit breaker open|circuit breaker is open|timeout|timed out|stalled|stream.*closed|empty (?:response|completion)|no (?:content|output)|auth|unauthori[sz]ed|credential|api[- ]?key|no endpoints|model.*not found/i.test(message) || OUTAGE_TEXT.test(message);
}

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

  // The pair of resolutions that matters for a run: the model it will actually use, and the
  // model the default provider would run — the target of an outage fallback. `forcedModelId`
  // carries the reroute target on the fallback run itself; the session is never mutated, so
  // the next message resolves the user's own choice again.
  private resolvePair(
    message: UnifiedMessage,
    session: SessionData,
    forcedModelId?: string,
  ): { resolved: RunModel; defaultResolved: ResolvedLlmConfig; globalDefaultResolved: ResolvedLlmConfig } {
    const hasImages = message.attachments.some((a) => a.type === "image" && Boolean(a.path));
    const agent = message.platform === "cron" ? "cron" : "main";
    const agentLlm = resolveAgentLlm(this.config, agent);
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
    // Route preflight notices are emitted by runWithFallback with the route transition. The
    // legacy source-chain notice remains here, where the run-level dedupe can cover bridge re-resolution.
    const hasRoutePreflight = Boolean(resolved.route) || resolved.skipped.some((entry) => entry.origin.startsWith("tags.") && entry.origin.includes(".route["));
    if (!hasRoutePreflight) announceModelFallback(resolved, message, agent);
    const defaultResolved = resolveLlmConfigForAgentMessage(this.config.llm, agentLlm, undefined, hasImages);
    const globalDefaultResolved = resolveLlmConfigForAgentMessage(this.config.llm, undefined, undefined, hasImages);
    return { resolved, defaultResolved, globalDefaultResolved };
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

  handleMessage(message: UnifiedMessage, session: SessionData, signal?: AbortSignal): Promise<string> {
    return this.runWithFallback(message, session, (backend, modelId, modelOverride, replay) =>
      backend.handleMessage(message, session, signal, modelId, modelOverride, replay), { signal });
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
    // A reroute replays the run from scratch, which would duplicate text, reasoning or a tool
    // invocation already delivered; the fallback only fires before any of those starts.
    let outputStarted = false;
    const gate = async (token: string): Promise<void> => {
      outputStarted = true;
      await onToken(token);
    };
    const guardedReasoning = reasoning
      ? {
          onText: async (delta: string): Promise<void> => { outputStarted = true; await reasoning.onText?.(delta); },
          onTokens: async (estimated: number): Promise<void> => { outputStarted = true; await reasoning.onTokens?.(estimated); },
        }
      : undefined;
    const guardedToolStart = onToolStart
      ? async (tool: Parameters<ToolStartCallback>[0]): Promise<void> => { outputStarted = true; await onToolStart(tool); }
      : undefined;
    return this.runWithFallback(
      message,
      session,
      (backend, resolvedModelId, modelOverride, replay) =>
        backend.handleMessageStreaming(message, session, gate, onToolUse, signal, onTurnSwitch, resolvedModelId, guardedReasoning, guardedToolStart, modelOverride, replay),
      {
        signal,
        anyOutputStarted: () => outputStarted,
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
    run: (backend: AgentBackend, modelId?: string, modelOverride?: RunModelOverride, userEntryWritten?: boolean) => Promise<string>,
    options: { signal?: AbortSignal; anyOutputStarted?: () => boolean; onFallbackNote?: (note: string) => Promise<void> } = {},
  ): Promise<string> {
    const { resolved, defaultResolved, globalDefaultResolved } = this.resolvePair(message, session);
    const notes: string[] = [];
    const preflightRouteEntries = resolved.skipped.filter(entry => entry.origin.startsWith("tags.") && entry.origin.includes(".route["));
    if (resolved.route || preflightRouteEntries.length > 0) {
      const routeName = resolved.route?.tag ?? preflightRouteEntries[0]?.origin.split(".")[1] ?? "route";
      for (const skipped of resolved.route
        ? resolved.skipped.filter(entry => entry.origin.startsWith(`tags.${resolved.route!.tag}.route[`))
        : preflightRouteEntries) {
        const note = `[fallback] ${routeName}: ${skipped.model} was unavailable before the run (${skipped.availability.state}); using ${resolved.model} instead.`;
        notes.push(note);
        void log("warn", "model route preflight fallback", {
          sessionId: session.id,
          messageId: message.id,
          requestedModel: resolved.requestedModel ?? `tag:${routeName}`,
          failedModel: skipped.model,
          targetModel: resolved.model,
          reason: skipped.availability.state,
        });
        if (options.onFallbackNote) await options.onFallbackNote(note);
      }
    }
    const attempted = new Set<string>();
    const route = resolved.route;
    let nextRouteIndex = route ? route.selectedIndex + 1 : Number.POSITIVE_INFINITY;
    let currentModel = resolved.model;
    let currentProvider = resolved.provider;

    const candidateOverride = (candidate: { effort?: RunModelOverride["effort"]; contextCap?: number }): RunModelOverride | undefined => {
      if (candidate.effort === undefined && candidate.contextCap === undefined) return undefined;
      return {
        ...(candidate.effort !== undefined ? { effort: candidate.effort } : {}),
        ...(candidate.contextCap !== undefined ? { contextCap: candidate.contextCap } : {}),
      };
    };

    const runCandidate = async (
      modelId: string | undefined,
      override: RunModelOverride | undefined,
      resolvedConfig: ResolvedLlmConfig,
      /**
       * A replay, so the first attempt already wrote the owner's turn to the log. Without this the
       * second run appends it again under the same bubble id, the log refuses a duplicate id, and
       * the reroute dies in ten milliseconds reporting `Entry id already exists` -- an error about
       * our own bookkeeping, standing where the provider outage that caused the reroute should be.
       */
      replay = false,
    ): Promise<string> => {
      if (modelId) attempted.add(modelId);
      return run(this.engineFor(resolvedConfig), modelId, override, replay);
    };
    const fail = (error: unknown): never => {
      if (route && notes.length > 0 && !options.onFallbackNote) {
        const message = String((error as Error | undefined)?.message ?? error);
        const decorated = new Error(`${notes.join("\n\n")}\n\n${message}`);
        if (typeof error === "object" && error !== null && "status" in error) {
          (decorated as Error & { status?: unknown }).status = (error as { status?: unknown }).status;
        }
        throw decorated;
      }
      throw error;
    };

    let result: string;
    try {
      const firstCandidate = route?.candidates[route.selectedIndex];
      result = await runCandidate(
        route ? resolved.model : undefined,
        route ? candidateOverride(firstCandidate ?? {}) : undefined,
        resolved,
      );
      return notes.length > 0 ? `${notes.join("\n\n")}\n\n${result}` : result;
    } catch (firstError) {
      let error: unknown = firstError;
      // The waits this run still owes a far-side failure, and the target each one goes back to.
      // One budget per run: a schedule that rearmed at every candidate would be a loop.
      const waits = providerRetryDelays(this.config.llm);
      let target: { model: string | undefined; override: RunModelOverride | undefined; config: ResolvedLlmConfig } = {
        model: route ? resolved.model : undefined,
        override: route ? candidateOverride(route.candidates[route.selectedIndex] ?? {}) : undefined,
        config: resolved,
      };
      while (true) {
        if (options.anyOutputStarted?.() || !isOutageClass(error)) fail(error);

        // The same target first, on the owner's schedule. A far-side fault usually clears on its
        // own, and moving on costs the prompt cache this conversation has been building at that
        // endpoint and lands on a different, more expensive model. The turn is already in the log,
        // hence the replay flag: without it the second attempt appends it under the same id and
        // dies on our own bookkeeping.
        if (waits.length > 0) {
          const delay = waits.shift()!;
          const reason = String((error as Error | undefined)?.message ?? error).slice(0, 200);
          const note = `[retry] ${currentModel} failed on the provider's side (${reason}); trying again in ${Math.round(delay / 1000)}s.`;
          notes.push(note);
          void log("warn", "provider retry scheduled", {
            sessionId: session.id,
            messageId: message.id,
            model: currentModel,
            provider: currentProvider,
            delayMs: delay,
            waitsLeft: waits.length,
            reason,
          });
          if (options.onFallbackNote) await options.onFallbackNote(note);
          await sleep(delay, options.signal);
          try {
            result = await runCandidate(target.model, target.override, target.config, true);
            return notes.length > 0 ? `${notes.join("\n\n")}\n\n${result}` : result;
          } catch (retryError) {
            error = retryError;
            continue;
          }
        }

        let nextModel: string | undefined;
        let nextOverride: RunModelOverride | undefined;
        let targetConfig: ResolvedLlmConfig = resolved;
        let transitionLabel = "route candidate";

        if (route) {
          while (nextRouteIndex < route.candidates.length) {
            const index = nextRouteIndex++;
            const candidate = route.candidates[index]!;
            if (route.unavailableIndices?.includes(index) || attempted.has(candidate.model)) continue;
            nextModel = candidate.model;
            nextOverride = candidateOverride(candidate);
            try {
              targetConfig = resolveLlmConfigForAgentMessage(
                this.config.llm,
                undefined,
                candidate.model,
                message.attachments.some((attachment) => attachment.type === "image" && Boolean(attachment.path)),
                candidate.effort,
              );
            } catch {
              targetConfig = resolved;
            }
            transitionLabel = `${route.tag} route candidate ${index + 1}`;
            break;
          }
          if (!nextModel && route.fallbackToGlobalDefault && !attempted.has(globalDefaultResolved.apiModel ?? globalDefaultResolved.model)) {
            nextModel = globalDefaultResolved.model;
            targetConfig = globalDefaultResolved;
            transitionLabel = `${route.tag} global default`;
          }
          if (!nextModel) fail(error);
        } else {
          if (resolved.provider === defaultResolved.provider || resolved.model === defaultResolved.model || attempted.has(defaultResolved.model)) fail(error);
          nextModel = defaultResolved.model;
          targetConfig = defaultResolved;
          transitionLabel = "configured default";
        }

        target = { model: nextModel, override: nextOverride, config: targetConfig };
        const failedModel = currentModel;
        const failedProvider = currentProvider;
        const reason = String((error as Error | undefined)?.message ?? error).slice(0, 200);
        const note = route
          ? `[fallback] ${route.tag}: ${failedModel} via ${failedProvider ?? "provider"} failed (${reason}); using ${nextModel} (${transitionLabel}).`
          : `[fallback] ${failedModel} via ${failedProvider ?? "provider"} is unavailable (${reason}). This run used ${nextModel} instead; it returns to ${failedModel} once the provider recovers.`;
        notes.push(note);
        void log("warn", "model route fallback", {
          sessionId: session.id,
          messageId: message.id,
          requestedModel: resolved.requestedModel ?? resolved.model,
          failedModel,
          failedProvider,
          targetModel: nextModel,
          targetProvider: targetConfig.provider,
          transition: transitionLabel,
          reason,
        });
        if (options.onFallbackNote) await options.onFallbackNote(note);

        try {
          currentModel = nextModel!;
          currentProvider = targetConfig.provider;
          result = await runCandidate(nextModel, nextOverride, targetConfig, true);
          return notes.length > 0 ? `${notes.join("\n\n")}\n\n${result}` : result;
        } catch (nextError) {
          error = nextError;
        }
      }
    }
  }
}
