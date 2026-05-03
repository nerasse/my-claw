import type { UnifiedMessage } from "../channels/types.ts";
import { loadSession, saveSession, type SessionData } from "./store.ts";

export class SessionManager {
  private sessions = new Map<string, SessionData>();

  async getOrCreate(sessionId: string, message: UnifiedMessage): Promise<SessionData> {
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

    session = {
      id: sessionId,
      platform: message.platform,
      chatType: message.chatType,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messages: [],
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  async persist(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await saveSession(sessionId, session);
    }
  }
}
