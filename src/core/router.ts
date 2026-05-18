import type { ToolApprovalHandler, UnifiedMessage } from "../channels/types.ts";
import { SessionManager } from "../sessions/manager.ts";
import type { AgentBridge } from "../agent/bridge.ts";
import { log } from "../utils/logger.ts";

export interface RouteResult {
  text: string;
  attachments?: import("../channels/types.ts").Attachment[];
}

interface RouteOptions {
  onToken?: (token: string) => Promise<void>;
  onToolUse?: (tools: Array<{ name: string; arguments: Record<string, unknown>; durationMs: number }>, verbose: boolean) => Promise<void>;
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

function errorLogData(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return String(err);
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

export class MessageRouter {
  private sessionLocks = new Map<string, Promise<unknown>>();
  private rateBuckets = new Map<string, number[]>();

  constructor(
    private sessionManager: SessionManager,
    private agent: AgentBridge,
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

  async route(message: UnifiedMessage, options: RouteOptions = {}): Promise<RouteResult | undefined> {
    const streaming = Boolean(options.onToken);

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

    try {
      const session = await this.sessionManager.getOrCreate(sessionId, message);
      void log("info", "routing message", {
        ...messageLogData(message),
        sessionId,
        streaming,
        sessionMessageCount: session.messages.length,
        modelOverride: session.modelOverride,
      });

      const text = options.onToken
        ? await this.agent.handleMessageStreaming(message, session, options.onToken, options.onToolUse)
        : await this.agent.handleMessage(message, session);
      const attachments = this.agent.getResponseAttachments();
      await this.sessionManager.persist(sessionId);

      void log("info", "response completed", {
        ...messageLogData(message),
        sessionId,
        streaming,
        responseChars: text?.length ?? 0,
        attachmentCount: attachments?.length ?? 0,
        sessionMessageCount: session.messages.length,
        durationMs: Date.now() - startedAt,
      });

      return text === undefined ? undefined : { text, attachments };
    } catch (err) {
      void log("error", "routing failed", {
        ...messageLogData(message),
        sessionId,
        streaming,
        durationMs: Date.now() - startedAt,
        error: errorLogData(err),
      });
      throw err;
    }
  }
}
