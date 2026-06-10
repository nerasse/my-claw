import type { ToolApprovalHandler, UnifiedMessage } from "../channels/types.ts";
import type { MyClawConfig } from "./config.ts";
import { injectionEnabled } from "./config.ts";
import { SessionManager } from "../sessions/manager.ts";
import type { AgentBridge } from "../agent/bridge.ts";
import { log } from "../utils/logger.ts";
import { errorLogData } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";
import { isAbort } from "./aborted.ts";
import { runRegistry } from "./run-registry.ts";

export interface RouteResult {
  text: string;
  attachments?: import("../channels/types.ts").Attachment[];
}

interface RouteOptions {
  onToken?: (token: string) => Promise<void>;
  onToolUse?: (tools: Array<{ name: string; arguments: Record<string, unknown>; durationMs: number }>, verbose: boolean) => Promise<void>;
  /** Called when the run switches to address a mid-run injected message, so the output layer
   *  can finalize the current bubble and open a fresh reply to that message. */
  onTurnSwitch?: (message: UnifiedMessage) => Promise<void>;
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

export class MessageRouter {
  private sessionLocks = new Map<string, Promise<unknown>>();
  private rateBuckets = new Map<string, number[]>();

  constructor(
    private sessionManager: SessionManager,
    private agent: AgentBridge,
    private config?: MyClawConfig,
  ) {}

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

  async route(message: UnifiedMessage, options: RouteOptions = {}): Promise<RouteResult | undefined> {
    const streaming = Boolean(options.onToken);

    const gate = await hooks.check("gate:message:incoming", { message });
    if (!gate.allowed) {
      void log("warn", "message blocked by gate", { reason: gate.reason, userId: message.userId });
      return undefined;
    }

    hooks.emit("message:received", { message });

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
        roomId: message.platform === "matrix" ? message.chatId : undefined,
        threadId: message.threadId,
        sessionScope: message.sessionScope,
      },
    );

    // Mid-run steering: if a run for this session is already in progress, inject this message into
    // it (addressed at the next iteration boundary) instead of queueing a whole new run behind it.
    // The returned promise resolves when the run finishes addressing it -> the adapter's existing
    // reaction/typing/commit lifecycle (which awaits this) just works.
    if (this.config && injectionEnabled(this.config) && !options.noInject && runRegistry.isRunning(sessionId)) {
      const injected = runRegistry.enqueueInjection(sessionId, message);
      if (injected) {
        void log("info", "message injected into active run", { ...messageLogData(message), sessionId });
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
      const session = await this.sessionManager.getOrCreate(sessionId, message);
      hooks.emit("message:route:start", { message, sessionId });
      void log("info", "routing message", {
        ...messageLogData(message),
        sessionId,
        streaming,
        sessionMessageCount: session.messages.length,
        modelOverride: session.modelOverride,
      });

      const text = options.onToken
        ? await this.agent.handleMessageStreaming(message, session, options.onToken, options.onToolUse, signal, options.onTurnSwitch)
        : await this.agent.handleMessage(message, session, signal);
      const attachments = this.agent.getResponseAttachments();
      await this.sessionManager.persist(sessionId);
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
      if (isAbort(err, signal)) {
        await this.sessionManager.persist(sessionId).catch(() => {});
        runRegistry.settleMailbox(sessionId, "reject", err);
        void log("info", "run stopped by user", { ...messageLogData(message), sessionId, streaming, durationMs });
        return undefined;
      }
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
