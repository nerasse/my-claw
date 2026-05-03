import type { UnifiedMessage } from "../channels/types.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { AuthGuard } from "./auth.ts";

export class MessageRouter {
  private authGuard: AuthGuard;

  constructor(
    whitelist: string[],
    private sessionManager: SessionManager,
  ) {
    this.authGuard = new AuthGuard(whitelist);
  }

  async route(message: UnifiedMessage): Promise<void> {
    if (!this.authGuard.isAuthorized(message.userId)) {
      return;
    }

    const sessionId = this.resolveSessionId(message);
    const session = await this.sessionManager.getOrCreate(sessionId, message);

    // TODO: forward to agent bridge
  }

  private resolveSessionId(message: UnifiedMessage): string {
    const { platform, chatType, chatId, userId } = message;
    if (chatType === "dm") {
      return `${platform}/dm/${userId}`;
    }
    return `${platform}/group/${chatId}`;
  }
}
