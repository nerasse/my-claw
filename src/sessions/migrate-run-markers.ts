/**
 * One pass, at boot, adding `run_start`/`run_end` markers to sessions written before the markers
 * existed -- docs/run-grouping.md.
 *
 * A run marker is written by the code that runs every run, so everything from the first run of
 * this version on is already marked. A session that predates it has no way to know where one run's
 * work ends and the next begins, and the app cannot fold what it cannot see delimited. This pass
 * deduces the runs from the structure that was already there and rewrites each file once.
 *
 * The rewrite is what the append-only rule normally forbids, and this is the one place it is
 * allowed: the pass runs before anything opens a session, it copies the original next to the
 * rewritten file, and the only fields it touches are the two parent links that thread a marker
 * into the branch (the marker's own, and the first work entry's -- which is exactly the shape the
 * live writer produces by appending in order). Every entry keeps its id, its text and its
 * timestamp; a client that holds a cursor into the file still finds it. From the moment the pass
 * is done, the file is only ever appended to again.
 *
 * The deduction is a heuristic, and it is the closest the historical format can come to the
 * truth. On the current branch, every `user` turn after the first either opens a run or was
 * injected into the one in flight, and the log cannot tell the two apart by structure alone: both
 * chain a user entry under run content. The deciding signal is what that content was. A run only
 * ends on a phase (the final answer, or the summary a `handleMaxIterations` writes), so a user
 * turn whose parent is a phase closed the previous run and opens the next; a user turn whose
 * parent is a tool call is a mid-run steering message or a question answer, which by construction
 * only ever land right after a tool round. A `failure` closes its run with an error, and a
 * trailing unfinished run closes as `done`: a crash can leave that shape, and an undead "running"
 * group is worse than a completed one.
 *
 * Dead branches are left unmarked. They hold abandoned work, reachable through the branch
 * picker, and rewinding a branch mid-run is exactly the case where guessing a boundary could put
 * the markers in the wrong order -- what they keep is the old flat display, which nothing here
 * breaks.
 */

import { copyFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { ENTRIES_FILE, newEntryId, parseEntryLine, pathOf, sessionDir } from "./log.ts";
import { readMeta } from "./meta.ts";
import type { Entry } from "./log.ts";

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");

/** The entry types a run's work is made of. A marker goes around them, nothing else. */
function isRunContent(type: Entry["type"]): boolean {
  return type === "phase" || type === "tool" || type === "spawn_state";
}

interface MigratedRun {
  /** The user turn that opened this run, when there is one (a run can also open at its work). */
  triggerId?: string;
  /** Id of the path entry the `run_start` marker is inserted before: the first work entry. */
  startBeforeId: string;
  /** Id of the path entry the `run_end` marker is inserted after: the last work entry. */
  endAfterId: string;
  /** Assigned when the run closes; `done` is the fallback for a trailing unfinished run. */
  reason: "done" | "error";
}

/**
 * Deduces the runs of one branch.
 *
 * Walks the path in order; the previous entry decides what a user turn is (see the module
 * comment). A run is only kept when it holds work: a user turn alone (a question whose run never
 * answered, an error that rewound everything) has nothing to fold, and an empty group would show
 * a header with nothing under it.
 */
function deduceRuns(path: Entry[]): { runs: MigratedRun[]; prevById: Map<string, string> } {
  const runs: MigratedRun[] = [];
  const prevById = new Map<string, string>();
  let current: { triggerId?: string; startBeforeId: string | null; endAfterId: string } | null = null;
  let hasContent = false;

  for (let i = 0; i < path.length; i++) {
    const entry = path[i]!;
    const prev = i > 0 ? path[i - 1]! : null;
    if (prev) prevById.set(entry.id, prev.id);

    if (entry.type === "user") {
      // A user chained under a tool is a mid-run injection (steering or a question answer), which
      // by construction only ever lands right after a tool round. A user after a phase closed
      // the previous run -- a run only ends on a phase -- and opens the next one.
      if (current && prev && prev.type === "tool") continue;
      if (current) {
        if (hasContent) runs.push({ ...current, reason: "done", startBeforeId: current.startBeforeId! });
        current = null;
        hasContent = false;
      }
      current = { triggerId: entry.id, startBeforeId: null, endAfterId: entry.id };
      continue;
    }

    if (entry.type === "failure") {
      if (current) {
        if (hasContent) runs.push({ ...current, reason: "error", startBeforeId: current.startBeforeId! });
        current = null;
        hasContent = false;
      }
      continue;
    }

    if (isRunContent(entry.type)) {
      if (!current) current = { startBeforeId: null, endAfterId: entry.id };
      if (!current.startBeforeId) current.startBeforeId = entry.id;
      current.endAfterId = entry.id;
      hasContent = true;
    }
  }

  if (current && hasContent) runs.push({ ...current, reason: "done", startBeforeId: current.startBeforeId! });
  return { runs, prevById };
}

/**
 * Rewrites one session's log with its run markers inserted, after backing the file up.
 *
 * The markers take their place in the file order (a `run_start` just before the first entry of
 * its run, a `run_end` just after the last), with fresh seq numbers over the whole file so cursor
 * arithmetic keeps working. The parent links are rewired the way the live writer leaves them --
 * a marker sits between its anchor and the entry that follows it -- so the branch walked from the
 * leaf crosses every marker it delimits.
 */
export async function migrateRunMarkersForSession(sessionId: string): Promise<boolean> {
  const dir = sessionDir(sessionId);
  const file = join(dir, ENTRIES_FILE);
  const raw = await readFile(file, "utf-8");
  const entries: Entry[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const entry = parseEntryLine(lines[i]!, sessionId, i + 1);
    if (entry) entries.push(entry);
  }
  if (entries.length < 2) return false;
  // Already migrated, or nothing a marker could delimit: the pass would rewrite for a no-op.
  if (entries.some((entry) => entry.type === "run_start" || entry.type === "run_end")) return false;
  if (!entries.some((entry) => isRunContent(entry.type))) return false;

  const meta = await readMeta(sessionId).catch(() => null);
  const leaf = meta?.leafId ?? entries[entries.length - 1]!.id;
  const path = pathOf(entries, leaf);
  const { runs, prevById } = deduceRuns(path);
  if (runs.length === 0) return false;

  // Backup before a single byte changes: the original is the only copy of the conversation
  // until the rewrite is proven, exactly the trade `migrate.ts` makes when it archives a file.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(dir, `${ENTRIES_FILE}.runmarkers-${stamp}.bak`);
  await copyFile(file, backup);

  // File index of each entry id, and where the markers sit relative to the entries they delimit.
  const indexOf = new Map(entries.map((entry, i) => [entry.id, i]));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const startAt = new Map<number, { id: string; ts: number; parentId: string | null }>(); // file index -> run_start
  const endAfter = new Map<number, { id: string; reason: "done" | "error" }>(); // file index -> run_end
  // Entry -> the parent link that threads a marker into the branch: the run_start hangs off the
  // trigger turn and the first work entry chains under it; the entry after a run_end chains under
  // the run_end. This is exactly the chain sequential appends produce -- docs/run-grouping.md.
  const rewire = new Map<string, string>();
  let lastEnd: { index: number; id: string } | null = null;

  for (const run of runs) {
    const startIndex = indexOf.get(run.startBeforeId);
    const endIndex = indexOf.get(run.endAfterId);
    if (startIndex === undefined || endIndex === undefined) continue;
    const startEntry = byId.get(run.startBeforeId) ?? entries[startIndex]!;
    // The marker is the trigger's child and carries its time; a run without a trigger (it opened
    // at its work) hangs off the work's path predecessor instead -- or off the preceding run_end,
    // when the two runs are adjacent in the file with nothing between.
    const trigger = run.triggerId ? byId.get(run.triggerId) : undefined;
    const startId = newEntryId((trigger ?? startEntry).ts);
    const endId = newEntryId((byId.get(run.endAfterId) ?? entries[endIndex]!).ts);
    const adjacentToEnd = lastEnd !== null && startIndex === lastEnd.index + 1;
    startAt.set(startIndex, {
      id: startId,
      ts: (trigger ?? startEntry).ts,
      parentId: run.triggerId ?? (adjacentToEnd ? lastEnd!.id : (prevById.get(startEntry.id) ?? null)),
    });
    endAfter.set(endIndex, { id: endId, reason: run.reason });
    lastEnd = { index: endIndex, id: endId };
    // The first work entry chains under the marker.
    rewire.set(run.startBeforeId, startId);
    const nextId = path[path.findIndex((entry) => entry.id === run.endAfterId) + 1]?.id;
    if (nextId) rewire.set(nextId, endId);
  }

  let seq = 0;
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const start = startAt.get(i);
    if (start) {
      out.push(JSON.stringify({
        type: "run_start",
        prompt: false,
        id: start.id,
        seq: seq++,
        parentId: start.parentId,
        ts: start.ts,
      }));
    }
    const newParent = rewire.get(entry.id);
    out.push(JSON.stringify(
      newParent && newParent !== entry.parentId ? { ...entry, seq: seq++, parentId: newParent } : { ...entry, seq: seq++ },
    ));
    const end = endAfter.get(i);
    if (end) {
      out.push(JSON.stringify({
        type: "run_end",
        prompt: false,
        id: end.id,
        seq: seq++,
        parentId: entry.id,
        ts: entry.ts,
        reason: end.reason,
      }));
    }
  }

  // fsync + rename: a crash mid-rewrite leaves either the backup or the old file, never a torn one.
  await writeFileAtomically(file, `${out.join("\n")}\n`);
  void log("info", "run markers migrated", { sessionId, runs: runs.length, backup });
  return true;
}

/**
 * Migrates every session that still lacks run markers.
 *
 * One failure does not stop the pass, and a session that fails is left exactly as it is: it still
 * reads fine, it just shows the old flat layout until a later boot retries it.
 */
export async function migrateRunMarkers(): Promise<void> {
  const candidates: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: { name: string; isDirectory: () => boolean }[] = [];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // A directory read while a session is being created: skipped, next boot retries it.
    }
    for (const entry of names) {
      const path = join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      // Sessions nest (`my-claw-app/thread/<owner>/<id>`, `cron/<jobId>/<runId>`): a directory
      // that holds a log is the session itself, anything deeper is walked.
      const inner: string[] = await readdir(path).catch(() => []);
      if (inner.includes(ENTRIES_FILE)) {
        candidates.push(path);
      } else if (inner.length > 0) {
        await walk(path);
      }
    }
  };
  try {
    await walk(SESSIONS_DIR);
  } catch {
    return;
  }
  let migrated = 0;
  let failed = 0;
  for (const dir of candidates) {
    try {
      const sessionId = dir.slice(SESSIONS_DIR.length + 1).replace(/\\/g, "/");
      if (await migrateRunMarkersForSession(sessionId)) migrated += 1;
    } catch (err) {
      failed += 1;
      void log("warn", "run marker migration failed, left as is", { sessionId: dir, error: String(err) });
    }
  }
  if (migrated > 0 || failed > 0) {
    void log("info", "run marker migration done", { migrated, failed });
  }
}