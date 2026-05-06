import type { UnifiedMessage } from "../channels/types.ts";
import { SessionManager } from "../sessions/manager.ts";
import type { AgentBridge } from "../agent/bridge.ts";
import { AuthGuard } from "./auth.ts";

interface RouteOptions {
  onToken?: (token: string) => Promise<void>;
  onToolUse?: () => Promise<void>;
}

export class MessageRouter {
  private authGuard: AuthGuard;

  constructor(
    whitelist: string[],
    private sessionManager: SessionManager,
    private agent: AgentBridge,
  ) {
    this.authGuard = new AuthGuard(whitelist);
  }

  async route(message: UnifiedMessage, options: RouteOptions = {}): Promise<string | undefined> {
    if (!this.authGuard.isAuthorized(message.userId)) return;

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
    const session = await this.sessionManager.getOrCreate(sessionId, message);
    const response = options.onToken
      ? await this.agent.handleMessageStreaming(message, session, options.onToken, options.onToolUse)
      : await this.agent.handleMessage(message, session);
    await this.sessionManager.persist(sessionId);
    return response;
  }
}
