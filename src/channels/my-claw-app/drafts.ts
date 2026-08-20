import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../core/config.ts";
import { hooks } from "../../hooks/index.ts";
import { listSessionIdsByPrefix } from "../../sessions/store.ts";
import { writeJsonFileAtomically } from "../../utils/atomic-write.ts";
import { log } from "../../utils/logger.ts";

/**
 * What the owner has typed and not sent, per conversation, shared by every device they own.
 *
 * Keyed by session id and not by thread id: the wire speaks thread ids because that is what a
 * device knows, and this speaks session ids because that is what `session:deleted` carries, which
 * makes the lifecycle a single key delete instead of a lookup that can miss.
 *
 * Deliberately not a field of `SessionData`: a session file reaches megabytes and is rewritten
 * whole, so a draft there would mean rewriting all of it per burst of typing -- docs/draft-sync.md.
 */

/** Longest draft that crosses the wire. The device holds the same constant and stops before it. */
export const DRAFT_TEXT_LIMIT = 64 * 1024;

/** Past this, the oldest by `ts` are dropped: an older draft is not a thought in progress. */
const MAX_DRAFTS = 200;

/** One write per second of typing at most. */
const FLUSH_DELAY_MS = 1000;

/**
 * How long a draft outlives a conversation that has no session file.
 *
 * A brand new thread has no session until its first message is sent, which is exactly when the
 * owner is writing the longest text they will ever put in that composer. Sweeping on "no session
 * file" alone threw that draft away on the next restart, which is the one thing this store exists
 * to prevent. A deleted conversation does not wait for this: the `session:deleted` hook drops it at
 * once. This only bounds what a hook can never see, a draft on a thread that was abandoned before
 * it ever became a session.
 */
const ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SESSION_PREFIX = "my-claw-app/thread/";

interface DraftEntry {
  text: string;
  /** Server clock. Device clocks drift, and last-write-wins on a drifting clock loses the wrong write. */
  ts: number;
}

interface DraftFile {
  version: 1;
  drafts: Record<string, DraftEntry>;
}

export interface DraftWrite {
  changed: boolean;
  ts: number;
}

export class DraftStore {
  private entries = new Map<string, DraftEntry>();
  private loaded?: Promise<void>;
  private dirty = false;
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly onSessionDeleted = ({ sessionId }: { sessionId: string }): void => {
    if (this.entries.delete(sessionId)) this.markDirty();
  };

  constructor(path?: string) {
    this.path = path ?? join(MY_CLAW_DIR, "my-claw-app", "drafts.json");
    hooks.on("session:deleted", this.onSessionDeleted);
  }

  /** The session ids holding a draft. One await for a caller that then tests many ids. */
  async drafted(): Promise<ReadonlySet<string>> {
    await this.ready();
    return new Set(this.entries.keys());
  }

  async textOf(sessionId: string): Promise<string> {
    await this.ready();
    return this.entries.get(sessionId)?.text ?? "";
  }

  /**
   * Stores a draft, or clears it when the text is empty. An unchanged text reports `changed: false`
   * and touches neither the map nor the disk: a device that reconnects and re-sends its draft is
   * free, and the caller uses the same answer to decide whether anything is worth broadcasting.
   */
  async set(sessionId: string, text: string): Promise<DraftWrite> {
    await this.ready();
    const existing = this.entries.get(sessionId);
    if (text.length > DRAFT_TEXT_LIMIT) {
      void log("warn", "draft over the wire limit ignored", { chars: text.length, limit: DRAFT_TEXT_LIMIT });
      return { changed: false, ts: existing?.ts ?? 0 };
    }
    if (!text) return { changed: this.clearEntry(sessionId), ts: Date.now() };
    if (existing?.text === text) return { changed: false, ts: existing.ts };
    const ts = Date.now();
    this.entries.set(sessionId, { text, ts });
    this.evict();
    this.markDirty();
    return { changed: true, ts };
  }

  async clear(sessionId: string): Promise<boolean> {
    await this.ready();
    return this.clearEntry(sessionId);
  }

  /** Writes what is pending and cancels the timer. Awaited by the adapter's own shutdown. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const payload: DraftFile = { version: 1, drafts: Object.fromEntries(this.entries) };
    this.writing = this.writing
      .then(() => writeJsonFileAtomically(this.path, payload))
      .catch((err) => {
        void log("error", "draft store write failed", { error: String(err) });
      });
    return this.writing;
  }

  /** Drops the hook subscription and any pending timer. Tests build several of these. */
  close(): void {
    hooks.off("session:deleted", this.onSessionDeleted);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clearEntry(sessionId: string): boolean {
    if (!this.entries.delete(sessionId)) return false;
    this.markDirty();
    return true;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.timer.unref?.();
  }

  private evict(): void {
    if (this.entries.size <= MAX_DRAFTS) return;
    const oldestFirst = [...this.entries.entries()].sort((left, right) => left[1].ts - right[1].ts);
    for (const [sessionId] of oldestFirst.slice(0, this.entries.size - MAX_DRAFTS)) this.entries.delete(sessionId);
  }

  private ready(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  /**
   * Reads the file, then drops every draft whose conversation is gone. The sweep is not redundant
   * with the `session:deleted` hook: a draft is unsent text whose only reference is a key in this
   * map, so one delete path that forgot to prune would leave it on disk forever with nothing
   * pointing at it. One readdir at boot closes that hole.
   */
  private async load(): Promise<void> {
    const parsed = await this.read();
    if (!parsed) return;
    const live = new Set(await listSessionIdsByPrefix(SESSION_PREFIX, Number.MAX_SAFE_INTEGER));
    const cutoff = Date.now() - ORPHAN_TTL_MS;
    let swept = 0;
    for (const [sessionId, entry] of Object.entries(parsed.drafts)) {
      if (typeof entry?.text !== "string" || !entry.text) continue;
      const ts = typeof entry.ts === "number" ? entry.ts : Date.now();
      if (!live.has(sessionId) && ts < cutoff) {
        swept += 1;
        continue;
      }
      this.entries.set(sessionId, { text: entry.text, ts });
    }
    this.evict();
    if (swept > 0) {
      this.dirty = true;
      void log("info", "swept drafts of deleted conversations", { swept, kept: this.entries.size });
    }
  }

  private async read(): Promise<DraftFile | undefined> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as DraftFile;
      if (!parsed || typeof parsed !== "object" || typeof parsed.drafts !== "object") return undefined;
      return parsed;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") void log("warn", "draft store unreadable, starting empty", { error: String(err) });
      return undefined;
    }
  }
}
