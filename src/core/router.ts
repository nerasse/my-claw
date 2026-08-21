import type { ToolApprovalHandler, UnifiedMessage } from "../channels/types.ts";
import type { MyClawConfig } from "./config.ts";
import { injectionEnabled, resolveAgentWorkspace } from "./config.ts";
import { SessionManager } from "../sessions/manager.ts";
import type { AgentBackend, ReasoningSink, TokenCallback, ToolStartCallback, ToolUseCallback, TurnSwitchCallback } from "../agent/backend.ts";
import { log } from "../utils/logger.ts";
import { errorLogData } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";
import { isAbort } from "./aborted.ts";
import { runRegistry } from "./run-registry.ts";
import { withRunContext, setRunSession } from "../utils/run-context.ts";
import { cleanupGeneratedTempFiles } from "../utils/media.ts";
import { archiveAssistantMessage, archiveChannelMessage } from "../conversations/store.ts";

export interface RouteResult {
  text: string;
  attachments?: import("../channels/types.ts").Attachment[];
}

interface RouteOptions {
  onToken?: TokenCallback;
  onToolUse?: ToolUseCallback;
  onToolStart?: ToolStartCallback;
  /** Called when the run switches to address a mid-run injected message, so the output layer
   *  can finalize the current bubble and open a fresh reply to that message. */
  onTurnSwitch?: TurnSwitchCallback;
  /** Where the run reports what the model is thinking. Only the app channel provides one, so the
   *  chat channels are unaffected -- docs/reasoning-visibility.md. */
  reasoning?: ReasoningSink;
  /** Force a normal new run, never inject (used when re-routing a rerouted injection). */
  noInject?: boolean;
}

function messageLogData(message: UnifiedMessage): Record<string, unknown> {
  return {
    messageId: message.id,
    platform: message.platform,
    userId: message.userId,
    chatId: message.chatId,
    chatType: message.chatType,
    threadId: message.threadId,
    replyToId: message.replyToId,
    sessionScope: message.sessionScope,
    attachmentCount: message.attachments.length,
    textChars: message.text.length,
  };
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

/**
 * Drives one message into an existing sub-agent. Injected rather than imported: the runner owns
 * the per-agent queue, the agent-type scoping and the workspace, and `core/` must not reach into
 * `subagents/` to get at them. See docs/subagent-navigation.md.
 */
export type SubAgentSend = (
  sessionId: string,
  message: UnifiedMessage,
  options: { onToken?: TokenCallback; onToolUse?: ToolUseCallback; onToolStart?: ToolStartCallback; onTurnSwitch?: TurnSwitchCallback; reasoning?: ReasoningSink; signal?: AbortSignal },
) => Promise<string>;

export class MessageRouter {
  private sessionLocks = new Map<string, Promise<unknown>>();
  private rateBuckets = new Map<string, number[]>();
  private subagentSend?: SubAgentSend;

  constructor(
    private sessionManager: SessionManager,
    private agent: AgentBackend,
    private config?: MyClawConfig,
  ) {}

  onSubAgentSend(send: SubAgentSend): void {
    this.subagentSend = send;
  }

  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const timestamps = this.rateBuckets.get(userId) ?? [];
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX) {
      this.rateBuckets.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.rateBuckets.set(userId, recent);
    return true;
  }

  setApprovalHandler(handler: ToolApprovalHandler | undefined): void {
    this.agent.setApprovalHandler(handler);
  }

  stop(sessionId: string): boolean {
    return runRegistry.stop(sessionId);
  }

  // Cron bypass gate:message:incoming and rate limits -- internal messages, not user-originated
  async routeCron(message: UnifiedMessage, sessionId: string, options: RouteOptions = {}): Promise<RouteResult | undefined> {
    return withRunContext({ platform: message.platform, sessionId }, () => this.routeCronTraced(message, sessionId, options));
  }

  private async routeCronTraced(message: UnifiedMessage, sessionId: string, options: RouteOptions = {}): Promise<RouteResult | undefined> {
    archiveChannelMessage(message);
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.routeInternal(message, sessionId, false, options));
    this.sessionLocks.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.sessionLocks.get(sessionId) === current) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  /** Everything one inbound message triggers shares a run id, stamped on every log line. */
  async route(message: UnifiedMessage, options: RouteOptions = {}): Promise<RouteResult | undefined> {
    return withRunContext({ platform: message.platform }, () => this.routeTraced(message, options));
  }

  private async routeTraced(message: UnifiedMessage, options: RouteOptions = {}): Promise<RouteResult | undefined> {
    const streaming = Boolean(options.onToken);

    const gate = await hooks.check("gate:message:incoming", { message });
    if (!gate.allowed) {
      void log("warn", "message blocked by gate", { reason: gate.reason, userId: message.userId });
      return undefined;
    }

    hooks.emit("message:received", { message });
    archiveChannelMessage(message);

    if (!this.checkRateLimit(message.userId)) {
      void log("warn", "rate limit exceeded", { userId: message.userId, platform: message.platform });
      return { text: "Rate limit exceeded. Please wait a moment before sending more messages." };
    }

    void log("info", "message received", {
      ...messageLogData(message),
      streaming,
    });

    const sessionId = SessionManager.resolveSessionId(
      message.platform,
      message.chatType,
      message.chatId,
      message.userId,
      {
        roomId: undefined,
        threadId: message.threadId,
        sessionScope: message.sessionScope,
      },
    );
    setRunSession(sessionId);

    // A compaction is rewriting the history this run would resume: starting now would both race
    // it on the session file and answer from a transcript that is about to be replaced, which is
    // how a compaction ends up written and then ignored. Waiting is the whole point: the run that
    // follows is the one that benefits from it.
    if (runRegistry.isCompacting(sessionId)) {
      void log("info", "waiting for compaction before routing", { ...messageLogData(message), sessionId });
      hooks.emit("message:queued", { message, sessionId, reason: "compaction" });
      await runRegistry.waitForCompaction(sessionId);
    }

    // A sub-agent's session must never be run from here. This path would give it depth 0, and with
    // it the spawn/send/kill tools that SUBAGENT_EXCLUDED_TOOLS removes on purpose, the default
    // prompt and model instead of the ones its agent type resolves to, and no place in the
    // per-agent queue -- so it would race a parent-driven run on the same session file. The runner
    // owns all of that, hence the delegation. Refused outright when nothing is wired, because
    // falling through is the dangerous half of this branch.
    if (sessionId.startsWith("subagent/")) {
      if (!this.subagentSend) {
        void log("error", "sub-agent session reached the router with no sub-agent sender", { sessionId });
        return { text: "Error: sub-agents cannot be driven from here." };
      }
      // Mid-run steering, same contract as the root path: if the sub-agent has an open mailbox
      // (a run of its own, app-driven or parent-driven), the message goes into that run instead of
      // waiting in the per-agent queue. RerouteSignal propagates to routeWithReroute, which reruns
      // this branch with noInject -- falling through to a queued, freshly streamed send.
      if (!options.noInject && runRegistry.canInject(sessionId)) {
        const injected = runRegistry.enqueueInjection(sessionId, message);
        if (injected) {
          void log("info", "message queued for injection into active sub-agent run", { ...messageLogData(message), sessionId });
          hooks.emit("message:injection:queued", { message, sessionId });
          await injected;
          return undefined;
        }
      }
      const { signal, end } = runRegistry.startRoot(sessionId);
      try {
        const text = await this.subagentSend(sessionId, message, {
          onToken: options.onToken,
          onToolUse: options.onToolUse,
          onTurnSwitch: options.onTurnSwitch,
          reasoning: options.reasoning,
          signal,
        });
        return { text };
      } finally {
        end();
      }
    }

    // Mid-run steering: if a run for this session is already in progress, inject this message into
    // it (addressed at the next iteration boundary) instead of queueing a whole new run behind it.
    // The returned promise resolves when the run finishes addressing it -> the adapter's existing
    // reaction/typing/commit lifecycle (which awaits this) just works.
    if (this.config && injectionEnabled(this.config) && !options.noInject && runRegistry.isRunning(sessionId)) {
      const injected = runRegistry.enqueueInjection(sessionId, message);
      if (injected) {
        void log("info", "message queued for injection into active run", { ...messageLogData(message), sessionId });
        hooks.emit("message:injection:queued", { message, sessionId });
        await injected;
        return undefined;
      }
    }

    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.routeInternal(message, sessionId, streaming, options));
    this.sessionLocks.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.sessionLocks.get(sessionId) === current) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  private async routeInternal(
    message: UnifiedMessage,
    sessionId: string,
    streaming: boolean,
    options: RouteOptions,
  ): Promise<RouteResult | undefined> {
    const startedAt = Date.now();
    const { signal, end } = runRegistry.startRoot(sessionId);

    try {
      // The orchestrator's configured workspace applies to conversations, and only at creation:
      // an existing thread keeps the workspace it was born in. See docs/multi-workspace.md.
      const session = await this.sessionManager.getOrCreateWithMeta(
        sessionId,
        message.platform,
        message.chatType,
        this.config ? resolveAgentWorkspace(this.config, "main") : undefined,
      );
      hooks.emit("message:route:start", { message, sessionId });
      void log("info", "routing message", {
        ...messageLogData(message),
        sessionId,
        streaming,
        sessionMessageCount: session.messages.length,
        modelOverride: session.modelOverride,
      });

      const text = options.onToken
        ? await this.agent.handleMessageStreaming(
            message,
            session,
            options.onToken,
            options.onToolUse,
            signal,
            options.onTurnSwitch,
            undefined,
            options.reasoning,
            options.onToolStart,
          )
        : await this.agent.handleMessage(message, session, signal);
      const attachments = this.agent.getResponseAttachments(message.id);
      await this.sessionManager.persist(sessionId);
      archiveAssistantMessage(message, sessionId, text ?? "");
      runRegistry.settleMailbox(sessionId, "resolve");

      const durationMs = Date.now() - startedAt;
      hooks.emit("message:route:complete", { message, sessionId, response: text ?? "", durationMs });
      void log("info", "response completed", {
        ...messageLogData(message),
        sessionId,
        streaming,
        responseChars: text?.length ?? 0,
        attachmentCount: attachments?.length ?? 0,
        sessionMessageCount: session.messages.length,
        durationMs,
      });

      return text === undefined ? undefined : { text, attachments };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      // The run may already have produced generated files (TTS/screenshots); on the error/abort
      // path nothing delivers them, so drain and delete them here or they leak in /tmp and linger
      // in the per-message buffer for a later run to mis-deliver.
      const orphaned = this.agent.getResponseAttachments(message.id);
      if (orphaned?.length) await cleanupGeneratedTempFiles(orphaned).catch(() => {});
      if (isAbort(err, signal)) {
        await this.sessionManager.persist(sessionId).catch(() => {});
        runRegistry.settleMailbox(sessionId, "reject", err);
        void log("info", "run stopped by user", { ...messageLogData(message), sessionId, streaming, durationMs });
        return undefined;
      }
      // A failed run still happened: the question and whatever the agent got through before the
      // error are in memory, and only this write keeps them past the next restart.
      await this.sessionManager.persist(sessionId).catch(() => {});
      runRegistry.settleMailbox(sessionId, "reject", err);
      hooks.emit("message:route:error", { message, sessionId, error: err, durationMs });
      void log("error", "routing failed", {
        ...messageLogData(message),
        sessionId,
        streaming,
        durationMs,
        error: errorLogData(err),
      });
      throw err;
    } finally {
      end();
    }
  }
}
