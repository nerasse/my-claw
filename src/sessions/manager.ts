import type { UnifiedMessage } from "../channels/types.ts";
import {
  loadSession,
  deleteSession as deleteSessionFile,
  deleteSessionArchives,
  archiveSession,
  listSessionIdsByPrefix,
  cronThreadToSession,
  subagentThreadToSession,
  isSessionDirty,
  clearSessionDirty,
  markSessionDirty,
  type SessionData,
} from "./store.ts";
import { LruMap } from "../utils/lru-map.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { openSessionLog, sessionDir, type SessionLog } from "./log.ts";
import { metaOf, readMeta, writeMeta } from "./meta.ts";
import { sweepOrphanToolOutput } from "./tool-output.ts";
import { rm } from "node:fs/promises";

const MAX_CACHED_SESSIONS = 100;
/**
 * Open logs held at once. Lower than the session cap because a log is the expensive half: a
 * `SessionData` is a small settings object, a `SessionLog` is every entry of a conversation.
 */
const MAX_OPEN_LOGS = 24;
/**
 * How much of a running turn can be in memory only. A run writes when it ends, so without a
 * timer a kill, a crash or a restart mid-turn takes every message it produced with it.
 */
const AUTOSAVE_INTERVAL_MS = 2000;

export class SessionManager {
  private sessions: LruMap<string, SessionData>;
  /** Message count at each session's last write: what tells a dirty session from a clean one. */
  private autosaveTimer?: ReturnType<typeof setInterval>;
  /**
   * Eviction writes still in flight. The evicted entry leaves the map before its file is
   * renamed, so a read that raced it used to load the pre-eviction file and the run that
   * followed wrote that truncated history back over the fresh one.
   */
  private pendingWrites = new Map<string, Promise<void>>();
  /**
   * The append-only half of each cached session -- docs/session-log.md.
   *
   * Held beside the session rather than on it, because a `SessionData` is serialised whole and a
   * log is a file handle with a write queue: putting one inside the other is how the settings
   * would end up carrying the history again, which is the split this exists to make.
   *
   * Bounded on its own, and not only by the session LRU that drops alongside it: `logOf` opens a
   * log without touching the session cache, so a caller that walks every conversation -- the
   * drawer used to -- filled this map with entries nothing would ever evict. Each one holds a
   * whole parsed JSONL file; that is how the process reached 451 MB resident.
   */
  private logs = new LruMap<string, SessionLog>(MAX_OPEN_LOGS, (_key, value) => {
    // The queued appends are drained before the handle goes, exactly as on session eviction.
    void value.flush().catch(() => {});
  });
  /** Opens in flight, so two callers asking at once share one read rather than racing it. */
  private opening = new Map<string, Promise<SessionLog>>();
  /**
   * Every log instance still referenced somewhere in the process, cache or not. Weak on purpose:
   * this holds nothing alive, it only answers "is there already one".
   *
   * A run holds the log it opened for its whole duration and appends through that reference, so
   * the cache above never sees it again until the run ends. Anything that opens two dozen other
   * logs meanwhile (a reload asks for the cron runs, which opens one per run) evicts it, and the
   * next `logOf` used to read the file back and resume at the leaf the meta last persisted, which
   * is the leaf from before the run. Two instances, two leaves: the reload was served the thread
   * as it stood before the question, the failure entry and the next turn attached to that old
   * leaf, and the whole run, question included, became a dead branch. One instance per session
   * per process is the invariant; the cache is only what keeps idle ones warm.
   */
  private liveLogs = new Map<string, WeakRef<SessionLog>>();

  constructor() {
    this.sessions = new LruMap<string, SessionData>(MAX_CACHED_SESSIONS, (key, value) => {
      hooks.emit("session:evicted", { sessionId: key });
      // The queued appends are drained before the handle goes, or the last entries of an evicted
      // conversation would be dropped on the floor. Nothing waits on this: the writes are already
      // ordered among themselves, and the next open re-reads the file.
      const evictedLog = this.logs.get(key);
      if (evictedLog) {
        this.logs.delete(key);
        void evictedLog.flush().catch(() => {});
      }
      void this.queueWrite(key, async () => {
        await this.writeSettings(key, value);
      }).catch((err) => {
        void log("error", "session eviction save failed", { sessionId: key, error: String(err) });
      });
    });
  }

  /** Serializes writes per session, so a lifecycle snapshot cannot overtake the next turn snapshot. */
  private queueWrite(sessionId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.pendingWrites.get(sessionId) ?? Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(work)
      .finally(() => {
        if (this.pendingWrites.get(sessionId) === write) this.pendingWrites.delete(sessionId);
      });
    this.pendingWrites.set(sessionId, write);
    return write;
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
      hooks.emit("session:loaded", { sessionId });
      return session;
    }

    session = this.createSession(sessionId, platform, chatType, workspace);
    this.cache(sessionId, session);
    hooks.emit("session:created", { sessionId, platform, chatType, workspace });
    return session;
  }

  private cache(sessionId: string, session: SessionData): void {
    this.sessions.set(sessionId, session);
  }

  /**
   * Registers a session already written by someone else (the sub-agent runner) into this
   * manager's cache, so the app channel's history/peek sees the live object while it runs
   * instead of the frozen file. Subsequent persist() calls then keep the cache in place.
   */
  adopt(session: SessionData): void {
    this.sessions.set(session.id, session);
  }

  /**
   * Removes a session from the cache only, without touching its file or archives. Used when
   * someone else (the sub-agent runner) deletes the file: the cache must not keep a ghost
   * that the autosave would rewrite, nor resurrect a killed session.
   */
  drop(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.pendingWrites.delete(sessionId);
    this.logs.delete(sessionId);
    this.liveLogs.delete(sessionId);
  }

  /** Test seam: whether the cache is keeping this log warm. The bound on memory is on the cache. */
  hasCachedLog(sessionId: string): boolean {
    return this.logs.has(sessionId);
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
    this.adopt(session);
    await this.persist(sessionId);
    hooks.emit("session:workspace", { sessionId, workspace });
    return session;
  }

  /**
   * A session's log, opened once and kept for as long as the session is cached.
   *
   * The leaf comes from `meta.json`, not from the end of the file: those two differ exactly when
   * the conversation sits on a branch that is not the newest thing written, which is the whole
   * point of having a cursor. A session with no meta yet is a new conversation, and the log's own
   * fallback (the last entry) is the right answer for it.
   */
  async logOf(sessionId: string): Promise<SessionLog> {
    const cached = this.logs.get(sessionId);
    if (cached) return cached;
    // Evicted from the cache but still held by a run: the same instance goes back in, never a
    // second one read off the disk.
    const alive = this.liveLogs.get(sessionId)?.deref();
    if (alive) {
      this.logs.set(sessionId, alive);
      return alive;
    }
    this.liveLogs.delete(sessionId);
    const inFlight = this.opening.get(sessionId);
    if (inFlight) return inFlight;

    const open = (async () => {
      const meta = await readMeta(sessionId).catch((err) => {
        // A storage version from the future. Refusing to read is the point; refusing to *run* is
        // not, so the conversation opens on an empty log and the settings stay untouched on disk.
        void log("error", "session log: meta refused, opening without a cursor", { sessionId, error: String(err) });
        return null;
      });
      const opened = await openSessionLog(sessionId, meta?.leafId ?? null);
      // The open adopted a dead tail: the meta says so at once, or the next open does it again.
      if (opened.repaired?.adoptedTail && meta) {
        await writeMeta(sessionId, { ...meta, leafId: opened.leaf() }).catch((err) => {
          void log("error", "session log: could not persist the adopted leaf", { sessionId, error: String(err) });
        });
      }
      // Every move of the leaf dirties the session, so the autosave carries it to the meta within
      // its tick; a process killed mid-run then reopens the log at most one tick behind, instead
      // of at the leaf of the last model call.
      opened.onAppend = () => {
        const session = this.sessions.get(sessionId);
        if (session) markSessionDirty(session);
      };
      this.liveLogs.set(sessionId, new WeakRef(opened));
      this.logs.set(sessionId, opened);
      return opened;
    })().finally(() => this.opening.delete(sessionId));

    this.opening.set(sessionId, open);
    return open;
  }

  /** The open log of a session, without opening one. For a caller that must not do I/O. */
  peekLog(sessionId: string): SessionLog | undefined {
    return this.logs.get(sessionId) ?? this.liveLogs.get(sessionId)?.deref();
  }

  /** Persisted session ids under a prefix, most recently active first. */
  async listSessions(prefix: string, limit = 50): Promise<string[]> {
    return listSessionIdsByPrefix(prefix, limit);
  }

  /** Hard delete: drain queued writes, evict from cache, then drop the session file and archives. */
  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    const pending = this.pendingWrites.get(sessionId);
    if (pending) await pending.catch(() => {});
    this.pendingWrites.delete(sessionId);
    // Drained before the directory goes, so no append lands after the delete and recreates the
    // file. The log's own error path deliberately does not recreate a missing directory, but a
    // write already queued would find one that still exists.
    const openLog = this.logs.get(sessionId);
    if (openLog) {
      this.logs.delete(sessionId);
      await openLog.flush().catch(() => {});
    }
    await deleteSessionFile(sessionId);
    // The entries, the settings and the spilled tool outputs go together: a tool output outlives
    // nothing, it belongs to the entry that names it -- docs/session-log.md §2.7.
    await rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
    await deleteSessionArchives(sessionId);
    hooks.emit("session:deleted", { sessionId });
  }

  /**
   * Files the conversation away and forgets it, so whatever is adopted next starts from nothing.
   *
   * The log has to be dropped, not just flushed. It is cached for as long as the session is, and it
   * remembers its leaf: left in place, the next `persist` would write that old leaf into the fresh
   * conversation's settings and `logOf` would keep handing back a log whose file has moved.
   */
  async archiveConversation(sessionId: string): Promise<string | null> {
    const pending = this.pendingWrites.get(sessionId);
    if (pending) await pending.catch(() => {});
    this.pendingWrites.delete(sessionId);
    const openLog = this.logs.get(sessionId);
    if (openLog) {
      this.logs.delete(sessionId);
      await openLog.flush().catch(() => {});
    }
    this.sessions.delete(sessionId);
    return archiveSession(sessionId);
  }

  /**
   * Deletes the spilled tool outputs no entry refers to, for one conversation.
   *
   * The residue of a run killed between writing the file and appending the entry that names it.
   * Called on a session that is already open, so it costs one directory listing.
   */
  async sweepToolOutput(sessionId: string): Promise<number> {
    const openLog = this.logs.get(sessionId);
    if (!openLog) return 0;
    return sweepOrphanToolOutput(sessionId, openLog.entries());
  }



  /** What the cache holds for a session, or null when it holds nothing. */
  getInfo(sessionId: string): { createdAt: string; lastActiveAt: string } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    };
  }

  /**
   * Writes the settings half, resolving the branch cursor without ever inventing one.
   *
   * The open log knows the leaf. With no log open, the stored one is carried over rather than
   * replaced by `null`: a `null` cursor means "start from the end of the log", so writing it over a
   * conversation parked on an older branch would silently move it back to the newest turn.
   *
   * A meta that cannot be read is left alone. It is the only case where refusing to write is
   * safer than writing: a directory from a newer binary holds fields this build does not know,
   * and `metaOf` would drop every one of them.
   */
  private async writeSettings(sessionId: string, session: SessionData): Promise<void> {
    const stored = await readMeta(sessionId).catch((err) => {
      void log("warn", "session meta: unreadable, settings left as they are", { sessionId, error: String(err) });
      return undefined;
    });
    if (stored === undefined) return;
    // The instance a run holds counts as open: its leaf is the truth, whatever the cache holds.
    const openLog = this.logs.get(sessionId) ?? this.liveLogs.get(sessionId)?.deref();
    const leaf = openLog ? openLog.leaf() : stored?.leafId ?? null;
    // Mirrored on every write while the log is in hand, so a conversation list never has to open
    // one to know how long a conversation is or what to call it.
    const fromLog = openLog
      ? {
          promptCount: openLog.promptCount(),
          ...(openLog.firstUserText() === null ? {} : { firstUserText: openLog.firstUserText() as string }),
        }
      : undefined;
    await writeMeta(sessionId, metaOf(session, leaf, stored, fromLog)).catch((err) => {
      void log("error", "session meta: write failed", { sessionId, error: String(err) });
    });
  }

  async persist(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.queueWrite(sessionId, async () => {
      // Cleared before the write, not after: a mutation landing while the file is being written
      // must leave the session dirty for the next tick rather than be marked as saved.
      clearSessionDirty(session);
      // The settings, and only them. The conversation is the entry log, written as it happens; the
      // flat `<id>.json` this used to rewrite alongside held a copy of the settings and an empty
      // `messages`, so it was a second store of the same facts with nothing of its own to say.
      await this.writeSettings(sessionId, session);
      hooks.emit("session:persisted", { sessionId });
    });
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
   * Writes every cached session that moved since its last write. A failure is logged and skipped
   * rather than thrown: the tick is fire-and-forget, and the next one retries.
   *
   * Two signals, because the message count alone is blind to a mutation that does not append: a
   * tool duration written back, a sub-agent state settling, usage accumulated. Those used to
   * survive a clean shutdown (`flushAll` writes regardless) and be lost to a kill.
   */
  async flushDirty(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      if (!isSessionDirty(session)) continue;
      try {
        await this.persist(sessionId);
      } catch (err) {
        void log("error", "session autosave failed", { sessionId, error: String(err) });
      }
    }
  }

  /** Writes every cached session, dirty or not. The last thing to run before the process exits. */
  async flushAll(): Promise<void> {
    const cached = [...this.sessions.keys()];
    await Promise.allSettled(cached.map((sessionId) => this.persist(sessionId)));
    // The appends are fire-and-forget so a file write never sits on the path of a token. That is
    // the one thing an exit has to undo: everything queued must reach the disk before the process
    // goes, or the last entries of every live conversation die with it.
    await Promise.allSettled([...this.logs.values()].map((entries) => entries.flush()));
  }
}
