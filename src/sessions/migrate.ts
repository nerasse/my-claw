/**
 * One pass, at boot, from `<id>.json` to `<id>/` -- docs/session-log.md annexe A.
 *
 * Idempotent: a session that already has a directory is left alone, so a boot interrupted halfway
 * resumes where it stopped and a second boot does nothing. That property is what makes this safe
 * to run unconditionally rather than behind a flag someone has to remember to flip.
 *
 * The legacy file is archived, not deleted. It is the only copy of the conversation until the new
 * one is proven, and `sessions-archive/` is already where a session goes when it is replaced.
 */

import { readdir, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { openSessionLog, sessionDir, holdsSession } from "./log.ts";
import { importSession } from "./import.ts";
import { metaOf, writeMeta } from "./meta.ts";
import type { SessionData } from "./store.ts";

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");
const ARCHIVES_DIR = join(MY_CLAW_DIR, "sessions-archive");

/**
 * Session ids that still live in a `<id>.json` file.
 *
 * The three families share this directory and all three are migrated: `my-claw-app/thread/*`,
 * `subagent/*` and `cron/*`. Cron sessions are not deleted after a run -- `pruneSessions` keeps
 * 25 per job -- so skipping them would strand every run the app can still open as a chat.
 */
export async function legacySessionIds(dir = SESSIONS_DIR, prefix = ""): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  // A session id can nest (`cron/<jobId>/<runId>`), so a directory is walked rather than skipped.
  // But a migrated session is *also* a directory, holding `meta.json`: walked blindly it yields
  // `<id>/meta` as a session that does not exist, which the pass then counts as a failure forever.
  if (holdsSession(entries.map((entry) => entry.name))) return [];

  const ids: string[] = [];
  for (const entry of entries) {
    const id = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      ids.push(...(await legacySessionIds(join(dir, entry.name), id)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      ids.push(id.slice(0, -".json".length));
    }
  }
  return ids;
}

/**
 * True once `<id>/` holds a session: the pass has already been here.
 *
 * Keyed on either half, not on the log alone. An empty conversation produced a directory with
 * settings and no log, so this read "not migrated" every boot: the pass re-migrated it, archived
 * the flat file `persist` had rewritten, and left `<id>/meta` behind as a legacy id to fail on.
 */
async function alreadyMigrated(sessionId: string): Promise<boolean> {
  const names = await readdir(sessionDir(sessionId)).catch(() => null);
  return names !== null && holdsSession(names);
}

export interface MigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
}

/**
 * Writes one session's directory from its legacy file.
 *
 * The two halves are written in the order that survives an interruption: entries first, then meta,
 * then the archive rename. A crash between them leaves a directory with a log and no settings,
 * which reopens as a conversation whose title is missing -- recoverable. The reverse order would
 * leave settings pointing at a leaf that was never written.
 */
export async function migrateSession(sessionId: string, session: SessionData): Promise<void> {
  await mkdir(sessionDir(sessionId), { recursive: true });
  const { entries: imported, boundaryIndex } = importSession(session);

  const logFile = await openSessionLog(sessionId);
  // `appendAll` rather than a loop of `append`: the boundary sits before the entries it keeps, so
  // the id it has to carry does not exist yet when its own turn comes. The batch hands the whole
  // chain over with its ids assigned and nothing written, which is the one moment a
  // cross-reference can be resolved without ever rewriting a line.
  logFile.appendAll(imported, (entries) => {
    if (boundaryIndex < 0 || !entries[boundaryIndex]) return;
    const boundary = [...entries].reverse().find((entry) => entry.type === "compaction");
    if (boundary) (boundary as { firstKeptEntryId: string }).firstKeptEntryId = entries[boundaryIndex]!.id;
  });
  await logFile.flush();

  await writeMeta(sessionId, metaOf(session, logFile.leaf()));
}

/** Moves the legacy file out of the way, under the name the archive store already uses. */
async function archiveLegacy(sessionId: string): Promise<void> {
  const source = join(SESSIONS_DIR, `${sessionId}.json`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(ARCHIVES_DIR, sessionId, `${stamp}.json`);
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
}

/**
 * Migrates every legacy session found, and reports what it did.
 *
 * One failure does not stop the pass: a session whose file is corrupt is left exactly as it is,
 * with its legacy file in place, so a later boot can retry it once the file is fixed. Taking the
 * whole boot down over one unreadable conversation would be the worse failure by far.
 */
export async function migrateSessions(
  read: (sessionId: string) => Promise<SessionData | null>,
): Promise<MigrationResult> {
  const ids = await legacySessionIds();
  const result: MigrationResult = { migrated: 0, skipped: 0, failed: 0 };
  if (ids.length === 0) return result;

  const startedAt = Date.now();
  for (const sessionId of ids) {
    try {
      if (await alreadyMigrated(sessionId)) {
        result.skipped += 1;
        continue;
      }
      const session = await read(sessionId);
      if (!session) {
        result.failed += 1;
        continue;
      }
      await migrateSession(sessionId, session);
      await archiveLegacy(sessionId);
      result.migrated += 1;
    } catch (err) {
      result.failed += 1;
      void log("error", "session migration failed, legacy file left in place", { sessionId, error: String(err) });
    }
  }

  if (result.migrated > 0 || result.failed > 0) {
    void log("info", "session migration pass", { ...result, ms: Date.now() - startedAt });
  }
  return result;
}
