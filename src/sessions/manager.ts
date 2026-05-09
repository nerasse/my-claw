import type { UnifiedMessage } from "../channels/types.ts";
import { loadSession, saveSession, deleteSession, archiveSession, purgeSessionArchives, type SessionData } from "./store.ts";

export class SessionManager {
  private sessions = new Map<string, SessionData>();

  private createSession(sessionId: string, platform: string, chatType: string): SessionData {
    return {
      id: sessionId,
      platform,
      chatType,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messages: [],
    };
  }

  static resolveSessionId(
    platform: string,
    chatType: "dm" | "group",
    chatId: string,
    userId: string,
    meta?: { roomId?: string; threadId?: string; sessionScope?: "per-user" | "per-room" | "per-chat" },
  ): string {
    if (platform === "matrix") {
      const roomId = meta?.roomId ?? chatId;
      const threadId = meta?.threadId?.trim();
      if (threadId) {
        return `matrix/thread/${roomId}/${threadId}`;
      }
      if (chatType === "dm") {
        if (meta?.sessionScope === "per-room") {
          return `matrix/dm-room/${roomId}`;
        }
        return `matrix/dm/${userId}`;
      }
      return `matrix/room/${roomId}`;
    }

    if (platform === "telegram") {
      const threadId = meta?.threadId?.trim();
      if (threadId) {
        return `telegram/thread/${chatId}/${threadId}`;
      }
      if (chatType === "dm") {
        if (meta?.sessionScope === "per-chat") {
          return `telegram/dm-chat/${chatId}`;
        }
        return `telegram/dm/${userId}`;
      }
      return `telegram/group/${chatId}`;
    }

    if (chatType === "dm") return `${platform}/dm/${userId}`;
    return `${platform}/group/${chatId}`;
  }

  async getOrCreate(sessionId: string, message: UnifiedMessage): Promise<SessionData> {
    return this.getOrCreateWithMeta(sessionId, message.platform, message.chatType);
  }

  async getOrCreateWithMeta(sessionId: string, platform: string, chatType: string): Promise<SessionData> {
    let session = this.sessions.get(sessionId);
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      return session;
    }

    session = await loadSession(sessionId) ?? undefined;
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      this.sessions.set(sessionId, session);
      return session;
    }

    session = this.createSession(sessionId, platform, chatType);
    this.sessions.set(sessionId, session);
    return session;
  }

  async peek(sessionId: string): Promise<SessionData | null> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const loaded = await loadSession(sessionId);
    if (!loaded) return null;
    this.sessions.set(sessionId, loaded);
    return loaded;
  }

  async resetSession(sessionId: string, platform: string, chatType: string): Promise<void> {
    this.sessions.delete(sessionId);
    const archived = await archiveSession(sessionId);
    if (!archived) {
      await deleteSession(sessionId);
    }
    this.sessions.set(sessionId, this.createSession(sessionId, platform, chatType));
  }

  async purgeArchives(options: { before?: Date; all?: boolean }): Promise<number> {
    return purgeSessionArchives(options);
  }

  clearHistory(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = [];
      session.lastActiveAt = new Date().toISOString();
    }
  }

  getInfo(sessionId: string): { messageCount: number; createdAt: string; lastActiveAt: string } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      messageCount: session.messages.length,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    };
  }

  async persist(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await saveSession(sessionId, session);
    }
  }
}
