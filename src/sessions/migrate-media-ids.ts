/**
 * One pass, at boot, pairing each run's pictures with the store id that names them --
 * docs/attachments.md.
 *
 * A media ref is a path; what a device fetches is an id, and the id was not written when these
 * markers were made. The display therefore matched copies by filename inside one thread directory:
 * it cannot see the copy a sub-agent's run left in its parent's thread, and it sees nothing at all
 * in a window that never listed a directory (2026-09-15).
 *
 * The ids are derivable. A stored file is `<id>__<name>`, so a readdir of the file tree pairs every
 * name with the copies that carry it -- and the one a marker wants is the copy written closest to
 * the moment the run ended, which is how a name two threads both generated still resolves to the
 * right bytes. The session's own thread is tried first, exactly the scope the old match used, so a
 * marker that resolved before resolves to the same file now; only a name that is nowhere in that
 * thread falls back to the owner's whole tree, which is what a sub-agent's marker needs.
 *
 * The rewrite is line by line and touches nothing else: a line this pass has nothing to pair keeps
 * its exact bytes, a line that does not parse is left where it is, and the ids are added beside the
 * paths rather than replacing them (a server on `prev` still knows only the paths). The file is
 * copied beside itself first and the write goes through `writeFileAtomically` -- the same trade
 * `migrate-run-markers.ts` makes, for the same reason. The pass runs before any reader opens a
 * session.
 *
 * A marker whose copy is nowhere keeps a null hole: the display still resolves it by filename when
 * it can, and names it without a picture when it cannot.
 *
 * The stamp is what keeps this from re-reading every log at every boot (211 MB of them here). It
 * is honest as long as the reader still falls back: a marker written *after* the sweep names its
 * pictures by path, and the filename match resolves it -- which is the behaviour every window had
 * before this pass, and what the writer half of this change will retire, one marker at a time.
 * Sweeping again by hand is `bun run scripts/migrate-media-ids.ts --apply`, which ignores the
 * stamp on purpose.
 */

import { copyFile, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { ENTRIES_FILE, parseEntryLine, sessionDir, type Entry } from "./log.ts";

export const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");
export const FILES_DIR = join(MY_CLAW_DIR, "files", "my-claw-app");
export const STAMP_FILE = join(MY_CLAW_DIR, ".media-ids-swept");

const STORED_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__(.+)$/;

/** Where to look for a session's copies: its own thread first, then the fallback scope. */
export interface MediaScope {
  own: readonly string[];
  fallback: readonly string[];
}

interface Copy {
  id: string;
  mtimeMs: number;
}

/** name -> every copy of it in these directories, under the name the device knows. */
export async function copiesIn(dirs: readonly string[]): Promise<Map<string, Copy[]>> {
  const byName = new Map<string, Copy[]>();
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const parsed = STORED_NAME.exec(name);
      if (!parsed) continue;
      const stats = await stat(join(dir, name)).catch(() => null);
      if (!stats) continue;
      const copy: Copy = { id: parsed[1]!, mtimeMs: stats.mtimeMs };
      const key = parsed[2]!;
      byName.set(key, [...(byName.get(key) ?? []), copy]);
    }
  }
  return byName;
}

/** The copy a marker wants: the one written closest to the moment the run ended. */
function nearest(copies: Copy[] | undefined, ts: number): Copy | undefined {
  if (!copies || copies.length === 0) return undefined;
  return copies.reduce((best, copy) =>
    Math.abs(copy.mtimeMs - ts) < Math.abs(best.mtimeMs - ts) ? copy : best,
  );
}

/** What a session's sweep found. */
export interface MediaMigrationReport {
  sessionId: string;
  markers: number;
  paired: number;
  holes: number;
  /** The names nothing could be paired with: a picture the store never received. */
  missing: string[];
  backup?: string;
}

/**
 * Pairs one session's markers with their ids, in place. Null when there is nothing to do, so a
 * sweep that finds nothing rewrites nothing. `dryRun` resolves without touching a byte, which is
 * what the script reports with. Exported for that script.
 */
export async function migrateMediaIdsForSession(
  sessionId: string,
  scopes: MediaScope,
  dryRun = false,
): Promise<MediaMigrationReport | null> {
  const dir = sessionDir(sessionId);
  const file = join(dir, ENTRIES_FILE);
  const raw = await readFile(file, "utf-8");
  const lines = raw.split("\n");

  const parsed: Array<Entry | null> = lines.map((line, i) => parseEntryLine(line, sessionId, i + 1));
  const pending = parsed.filter(
    (entry): entry is Extract<Entry, { type: "run_end" }> =>
      entry?.type === "run_end" && (entry.media?.length ?? 0) > 0 && entry.mediaIds === undefined,
  );
  if (pending.length === 0) return null;

  let ownCopies: Map<string, Copy[]> | undefined;
  let fallbackCopies: Map<string, Copy[]> | undefined;
  const ids = new Map<string, Array<string | null>>();
  const missing = new Set<string>();
  for (const entry of pending) {
    ownCopies ??= await copiesIn(scopes.own);
    const resolved: Array<string | null> = [];
    for (const path of entry.media ?? []) {
      const name = basename(path);
      let copy = nearest(ownCopies.get(name), entry.ts);
      if (!copy && scopes.fallback.length > 0) {
        fallbackCopies ??= await copiesIn(scopes.fallback);
        copy = nearest(fallbackCopies.get(name), entry.ts);
      }
      if (!copy) missing.add(name);
      resolved.push(copy?.id ?? null);
    }
    ids.set(entry.id, resolved);
  }

  const paired = [...ids.values()].flat().filter(Boolean).length;
  const holes = [...ids.values()].flat().filter((id) => id === null).length;
  const report: MediaMigrationReport = {
    sessionId,
    markers: ids.size,
    paired,
    holes,
    missing: [...missing].sort(),
  };
  if (dryRun) return report;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(dir, `${ENTRIES_FILE}.mediaids-${stamp}.bak`);
  await copyFile(file, backup);

  const out = lines.map((line, i) => {
    const entry = parsed[i];
    const resolved = entry ? ids.get(entry.id) : undefined;
    return resolved ? JSON.stringify({ ...entry, mediaIds: resolved }) : line;
  });

  await writeFileAtomically(file, out.join("\n"));
  void log("info", "media ids migrated", { ...report, backup });
  return { ...report, backup };
}

/** Every thread directory of an owner. */
export async function ownerThreadDirs(owner: string): Promise<string[]> {
  const root = join(FILES_DIR, owner);
  const names = await readdir(root, { withFileTypes: true }).catch(() => []);
  return names.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

/** Every owner the file tree holds. */
export async function owners(): Promise<string[]> {
  const names = await readdir(FILES_DIR, { withFileTypes: true }).catch(() => []);
  return names.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * The owner a session id names: `my-claw-app/thread/<owner>/<threadId>`. A sub-agent session
 * (`subagent/run-<id>`) names none, which is exactly the case this pass exists for.
 */
export function ownerOfSessionId(sessionId: string): string | undefined {
  const segments = sessionId.split("/");
  if (segments[0] === "my-claw-app" && segments.length >= 4) return segments[segments.length - 2];
  return undefined;
}

/** The session directory of every log under the sessions root. */
export async function sessionDirs(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      const inner = await readdir(path).catch(() => [] as string[]);
      if (inner.includes(ENTRIES_FILE)) found.push(path);
      else if (inner.length > 0) await walk(path);
    }
  };
  await walk(SESSIONS_DIR);
  return found;
}

/**
 * Sweeps every session once. `force` ignores the stamp, which is what the script uses after a
 * session was written by a build that still named its pictures by path alone.
 */
export async function migrateMediaIds(force = false): Promise<void> {
  if (!force) {
    const done = await stat(STAMP_FILE).catch(() => null);
    if (done) return;
  }
  const allOwners = await owners();
  const trees = new Map<string, string[]>();
  const treeOf = async (owner: string): Promise<string[]> => {
    const cached = trees.get(owner);
    if (cached) return cached;
    const dirs = await ownerThreadDirs(owner);
    trees.set(owner, dirs);
    return dirs;
  };

  let migrated = 0;
  let failed = 0;
  for (const dir of await sessionDirs()) {
    const sessionId = dir.slice(SESSIONS_DIR.length + 1).replace(/\\/g, "/");
    try {
      const owner = ownerOfSessionId(sessionId);
      const thread = sessionId.split("/").pop() ?? "";
      // A sub-agent's session names no owner, and its pictures were copied into its parent's
      // thread: its fallback is every owner's tree. Anything else starts in its own thread.
      const scopes: MediaScope = owner
        ? { own: [join(FILES_DIR, owner, thread)], fallback: await treeOf(owner) }
        : { own: [], fallback: (await Promise.all(allOwners.map(treeOf))).flat() };
      if (await migrateMediaIdsForSession(sessionId, scopes)) migrated += 1;
    } catch (err) {
      failed += 1;
      void log("warn", "media id migration failed, left as is", { sessionId, error: String(err) });
    }
  }
  if (failed === 0) await writeFileAtomically(STAMP_FILE, `${new Date().toISOString()}\n`);
  if (migrated > 0 || failed > 0) void log("info", "media id migration done", { migrated, failed });
}
