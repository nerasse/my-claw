import type { ToolApprovalHandler, UnifiedMessage } from "../channels/types.ts";
import { SessionManager } from "../sessions/manager.ts";
import type { AgentBridge } from "../agent/bridge.ts";
import { log } from "../utils/logger.ts";

interface RouteOptions {
  onToken?: (token: string) => Promise<void>;
  onToolUse?: () => Promise<void>;
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

export class MessageRouter {
  constructor(
    _whitelist: string[],
    private sessionManager: SessionManager,
    private agent: AgentBridge,
  ) {}

  setApprovalHandler(handler: ToolApprovalHandler | undefined): void {
    this.agent.setApprovalHandler(handler);
  }

  async route(message: UnifiedMessage, options: RouteOptions = {}): Promise<string | undefined> {
    const streaming = Boolean(options.onToken);
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

      const response = options.onToken
        ? await this.agent.handleMessageStreaming(message, session, options.onToken, options.onToolUse)
        : await this.agent.handleMessage(message, session);
      await this.sessionManager.persist(sessionId);

      void log("info", "response completed", {
        ...messageLogData(message),
        sessionId,
        streaming,
        responseChars: response?.length ?? 0,
        sessionMessageCount: session.messages.length,
        durationMs: Date.now() - startedAt,
      });

      return response;
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
