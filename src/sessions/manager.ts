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
/**
 * How much of a running turn can be in memory only. A run writes when it ends, so without a
 * timer a kill, a crash or a restart mid-turn takes every message it produced with it.
 */
const AUTOSAVE_INTERVAL_MS = 2000;

export class SessionManager {
  private sessions: LruMap<string, SessionData>;
  /** Message count at each session's last write: what tells a dirty session from a clean one. */
  private savedCounts = new Map<string, number>();
  private autosaveTimer?: ReturnType<typeof setInterval>;
  /**
   * Eviction writes still in flight. The evicted entry leaves the map before its file is
   * renamed, so a read that raced it used to load the pre-eviction file and the run that
   * followed wrote that truncated history back over the fresh one.
   */
  private pendingWrites = new Map<string, Promise<void>>();

  constructor() {
    this.sessions = new LruMap<string, SessionData>(MAX_CACHED_SESSIONS, (key, value) => {
      hooks.emit("session:evicted", { sessionId: key });
      this.savedCounts.delete(key);
      const write = saveSession(key, value)
        .catch((err) => {
          void log("error", "session eviction save failed", { sessionId: key, error: String(err) });
        })
        .finally(() => {
          if (this.pendingWrites.get(key) === write) this.pendingWrites.delete(key);
        });
      this.pendingWrites.set(key, write);
    });
  }

  /** Every disk read of a session goes through here, so none of them can overtake an eviction. */
  private async loadSettled(sessionId: string): Promise<SessionData | null> {
    const pending = this.pendingWrites.get(sessionId);
    if (pending) await pending;
    return loadSession(sessionId);
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

    session = await this.loadSettled(sessionId) ?? undefined;
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      this.cache(sessionId, session);
      hooks.emit("session:loaded", { sessionId, messageCount: session.messages.length });
      return session;
    }

    session = this.createSession(sessionId, platform, chatType, workspace);
    this.cache(sessionId, session);
    hooks.emit("session:created", { sessionId, platform, chatType, workspace });
    return session;
  }

  /** Caches a session that matches its file, so the autosave only writes what a run changed. */
  private cache(sessionId: string, session: SessionData): void {
    this.sessions.set(sessionId, session);
    this.savedCounts.set(sessionId, session.messages.length);
  }

  async peek(sessionId: string): Promise<SessionData | null> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const loaded = await this.loadSettled(sessionId);
    if (!loaded) return null;
    this.cache(sessionId, loaded);
    return loaded;
  }

  /**
   * The session as it stands right now: the cached copy while a run mutates it, the file
   * otherwise. Reading the file alone shows a turn in flight as if nothing had happened, since
   * a run only reaches the disk on the autosave tick or when it ends.
   *
   * A miss is deliberately not cached, unlike `peek`: a caller that walks every conversation (a
   * thread list) would churn the LRU and evict the sessions that are actually live.
   */
  async read(sessionId: string): Promise<SessionData | null> {
    return this.sessions.get(sessionId) ?? await this.loadSettled(sessionId);
  }

  /**
   * Switches a session to another workspace key, or back to the default one (undefined). The
   * change is persisted immediately: workspace resolution reads the session per run, so it
   * applies from the next run onward.
   */
  async setWorkspace(sessionId: string, workspace: string | undefined): Promise<SessionData> {
    const session = this.sessions.get(sessionId) ?? await this.loadSettled(sessionId);
    if (!session) throw new Error("conversation not found");
    if (workspace) session.workspace = workspace;
    else delete session.workspace;
    await saveSession(sessionId, session);
    this.cache(sessionId, session);
    hooks.emit("session:workspace", { sessionId, workspace });
    return session;
  }

  async resetSession(sessionId: string, platform: string, chatType: string): Promise<void> {
    const gate = await hooks.check("gate:session:reset", { sessionId });
    if (!gate.allowed) return;
    const previous = this.sessions.get(sessionId) ?? await this.loadSettled(sessionId);
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
    await saveSession(sessionId, session);
    this.cache(sessionId, session);
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
    this.savedCounts.delete(sessionId);
    await deleteSessionFile(sessionId);
    await deleteSessionArchives(sessionId);
    hooks.emit("session:deleted", { sessionId });
  }

  clearHistory(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const previousMessageCount = session.messages.length;
      session.messages = [];
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
      this.savedCounts.set(sessionId, session.messages.length);
      hooks.emit("session:persisted", { sessionId, messageCount: session.messages.length });
    }
  }

  /** Starts writing what running turns accumulate. Idempotent: a second call is a no-op. */
  startAutosave(intervalMs = AUTOSAVE_INTERVAL_MS): void {
    if (this.autosaveTimer) return;
    this.autosaveTimer = setInterval(() => void this.flushDirty(), intervalMs);
    this.autosaveTimer.unref?.();
  }

  stopAutosave(): void {
    if (!this.autosaveTimer) return;
    clearInterval(this.autosaveTimer);
    this.autosaveTimer = undefined;
  }

  /**
   * Writes every cached session whose message count moved since its last write. A failure is
   * logged and skipped rather than thrown: the tick is fire-and-forget, and the next one retries.
   */
  async flushDirty(): Promise<void> {
    for (const [sessionId, session] of [...this.sessions.entries()]) {
      if (this.savedCounts.get(sessionId) === session.messages.length) continue;
      try {
        await saveSession(sessionId, session);
        this.savedCounts.set(sessionId, session.messages.length);
      } catch (err) {
        void log("error", "session autosave failed", { sessionId, error: String(err) });
      }
    }
  }

  /** Writes every cached session, dirty or not. The last thing to run before the process exits. */
  async flushAll(): Promise<void> {
    const cached = [...this.sessions.entries()];
    await Promise.allSettled(
      cached.map(async ([sessionId, session]) => {
        await saveSession(sessionId, session);
        this.savedCounts.set(sessionId, session.messages.length);
      }),
    );
  }
}
