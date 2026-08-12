import type { UnifiedMessage } from "../channels/types.ts";
import {
  loadSession,
  saveSession,
  deleteSession as deleteSessionFile,
  deleteSessionArchives,
  archiveSession,
  purgeSessionArchives,
  listSessionIdsByPrefix,
  cronThreadToSession,
  subagentThreadToSession,
  type SessionData,
} from "./store.ts";
import { LruMap } from "../utils/lru-map.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";

const MAX_CACHED_SESSIONS = 100;

export class SessionManager {
  private sessions: LruMap<string, SessionData>;

  constructor() {
    this.sessions = new LruMap<string, SessionData>(MAX_CACHED_SESSIONS, (key, value) => {
      hooks.emit("session:evicted", { sessionId: key });
      saveSession(key, value).catch((err) => {
        void log("error", "session eviction save failed", { sessionId: key, error: String(err) });
      });
    });
  }

  private createSession(
    sessionId: string,
    platform: string,
    chatType: string,
    workspace?: string,
  ): SessionData {
    return {
      id: sessionId,
      platform,
      chatType,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messages: [],
      ...(workspace ? { workspace } : {}),
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

    if (platform === "my-claw-app") {
      const threadId = meta?.threadId?.trim();
      if (threadId) {
        // A cron run's thread refers to the run's own session (kept after the run so it can
        // be reopened and chatted on), not to a my-claw-app conversation.
        const cronSession = cronThreadToSession(threadId);
        if (cronSession) return cronSession;
        // Same idea for a sub-agent the app opens as a chat. Unresolvable falls through to a
        // conversation id, which then loads as an empty session: a stale handle must read as
        // "nothing there", never as somebody else's thread.
        const subagentSession = subagentThreadToSession(threadId);
        if (subagentSession) return subagentSession;
        return `my-claw-app/thread/${chatId}/${threadId}`;
      }
      return `my-claw-app/dm/${userId}`;
    }

    if (chatType === "dm") return `${platform}/dm/${userId}`;
    return `${platform}/group/${chatId}`;
  }

  async getOrCreate(sessionId: string, message: UnifiedMessage): Promise<SessionData> {
    return this.getOrCreateWithMeta(sessionId, message.platform, message.chatType);
  }

  async getOrCreateWithMeta(
    sessionId: string,
    platform: string,
    chatType: string,
    workspace?: string,
  ): Promise<SessionData> {
    let session = this.sessions.get(sessionId);
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      return session;
    }

    session = await loadSession(sessionId) ?? undefined;
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      this.sessions.set(sessionId, session);
      hooks.emit("session:loaded", { sessionId, messageCount: session.messages.length });
      return session;
    }

    session = this.createSession(sessionId, platform, chatType, workspace);
    this.sessions.set(sessionId, session);
    hooks.emit("session:created", { sessionId, platform, chatType, workspace });
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
    const gate = await hooks.check("gate:session:reset", { sessionId });
    if (!gate.allowed) return;
    const previous = this.sessions.get(sessionId) ?? await loadSession(sessionId);
    this.sessions.delete(sessionId);
    const archived = await archiveSession(sessionId);
    if (!archived) {
      await deleteSessionFile(sessionId);
    }
    const session = this.createSession(sessionId, platform, chatType);
    if (previous?.modelOverride !== undefined) {
      session.modelOverride = previous.modelOverride;
    }
    // Archiving starts a fresh conversation on the same thread, and the owner named the thread,
    // not the turns inside it: dropping the name here would rename it back to its first sentence.
    if (previous?.title !== undefined) {
      session.title = previous.title;
    }
    this.sessions.set(sessionId, session);
    await saveSession(sessionId, session);
    hooks.emit("session:reset", { sessionId, platform, archived: Boolean(archived) });
  }

  async purgeArchives(options: { before?: Date; all?: boolean }): Promise<number> {
    return purgeSessionArchives(options);
  }

  /** Persisted session ids under a prefix, most recently active first. */
  async listSessions(prefix: string, limit = 50): Promise<string[]> {
    return listSessionIdsByPrefix(prefix, limit);
  }

  /** Hard delete: evict from cache, drop the session file and every archive snapshot. */
  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await deleteSessionFile(sessionId);
    await deleteSessionArchives(sessionId);
    hooks.emit("session:deleted", { sessionId });
  }

  clearHistory(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const previousMessageCount = session.messages.length;
      session.messages = [];
      // On the claude-sdk backend the real history lives in the SDK session; keeping the
      // id would silently resume everything the user just asked to clear.
      delete session.sdkSessionId;
      delete session.sdkSyncedAt;
      delete session.contextTransfer;
      session.lastActiveAt = new Date().toISOString();
      hooks.emit("session:cleared", { sessionId, previousMessageCount });
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
      hooks.emit("session:persisted", { sessionId, messageCount: session.messages.length });
    }
  }
}
