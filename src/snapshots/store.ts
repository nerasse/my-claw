/**
 * Per-run snapshot store -- the *before* state of the workspace, tied to a run, for `/undo`.
 *
 * Both the conversation branch and the file state belong to the same "undo point". The
 * conversation side is `meta.undo`; the file side is a snapshot recorded at the start of the
 * run that produced the turn being undone. `undo` reads both: branch the log, and restore the
 * files to the snapshot of the run that wrote them.
 *
 * Snapshots live under `$MY_CLAW_DIR/snapshots/session/<sessionId>/<runId>.json`, named after the
 * run id the log's `run_start` marker carries: that is how `/undo` finds the snapshots of the turn
 * it takes back, rather than the newest of the session. The git trees they reference live in the
 * shared shadow store, and only this module names its directory: `/undo` used to pass the diff and
 * the restore a root one level off the capture's, so every diff it showed was +0/-0 and no hard
 * undo ever restored a file (2026-10-02).
 */

import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../utils/logger.ts";
import type { DepotDiff, WorkspaceSnapshot } from "./capture.ts";
import { captureWorkspace, diffSnapshots, restoreDepot } from "./capture.ts";
import { MY_CLAW_DIR } from "../core/config.ts";

const execFileAsync = promisify(execFile);

/** How long a snapshot stays restorable. The shadow prune uses the same window, by construction. */
const SNAPSHOT_RETENTION_DAYS = 30;
const SNAPSHOT_RETENTION_MS = SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** Kept per session whatever their age, so a busy conversation cannot bury its own recent undo. */
export const MAX_SNAPSHOTS_PER_SESSION = 20;
const SHADOW_GC_TIMEOUT_MS = 120_000;

export interface RunSnapshot {
  runId: string;
  sessionId: string;
  /** The workspace as it was before this run's first tool touched it. */
  before: WorkspaceSnapshot;
  ts: number;
}

export function snapshotsRoot(): string {
  return join(MY_CLAW_DIR, "snapshots");
}

function sessionDir(sessionId: string): string {
  return join(snapshotsRoot(), "session", sessionId);
}

function shadowRoot(): string {
  return join(snapshotsRoot(), "shadow");
}

/**
 * Captures the workspace and records it as this run's *before* snapshot, under the run id the log
 * marks the run with. A run that already has one keeps it: the earliest state is the one a restore
 * goes back to.
 */
export async function recordRunStart(sessionId: string, workspace: string, runId: string): Promise<RunSnapshot> {
  const dir = sessionDir(sessionId);
  const file = join(dir, `${runId}.json`);
  const existing = await readSnapshot(file);
  if (existing) return existing;
  const entry: RunSnapshot = {
    runId,
    sessionId,
    before: await captureWorkspace(workspace, shadowRoot()),
    ts: Date.now(),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(entry), "utf8");
  // Retention lives here now that the end of the run records nothing: it used to ride on the
  // after-state capture, so dropping that capture would have let these files accumulate for good.
  await pruneSessionSnapshots(sessionId);
  return entry;
}

/**
/**
 * Drops what `/undo` can no longer reach for: a snapshot older than the retention, and anything
 * past the most recent runs of a session.
 *
 * Nothing used to delete these. They are small on their own -- the weight is in the shadow object
 * stores -- but they are the index of what those objects are for, so the retention has to be
 * decided here and the object prune follows it.
 */
export async function pruneSessionSnapshots(sessionId: string): Promise<void> {
  const dir = sessionDir(sessionId);
  const files = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
  if (files.length === 0) return;
  const dated = await Promise.all(
    files.map(async (name) => {
      const entry = await readFile(join(dir, name), "utf8")
        .then((text) => JSON.parse(text) as RunSnapshot)
        .catch(() => null);
      return { name, ts: entry?.ts ?? 0 };
    }),
  );
  dated.sort((a, b) => b.ts - a.ts);
  const cutoff = Date.now() - SNAPSHOT_RETENTION_MS;
  const doomed = dated.filter((entry, rank) => rank >= MAX_SNAPSHOTS_PER_SESSION || entry.ts < cutoff);
  for (const entry of doomed) {
    await rm(join(dir, entry.name), { force: true }).catch(() => {});
  }
}

/**
 * Compacts the shadow object stores.
 *
 * A capture is `add --all` then `write-tree`: it writes blobs and trees and **no commit**, so
 * every object is unreachable from any ref and an ordinary `git gc` would delete the lot. What
 * keeps a snapshot readable is the prune window, which is why it is the same window as the
 * retention above: an object older than that belongs to a snapshot that is already gone.
 *
 * 247 MB here, from 22 shadows nothing had ever pruned.
 */
export async function gcShadows(): Promise<void> {
  const root = join(shadowRoot(), "shadow");
  const shadows = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const shadow of shadows) {
    if (!shadow.isDirectory()) continue;
    const dir = join(root, shadow.name);
    await execFileAsync("git", ["--git-dir", dir, "gc", "--quiet", `--prune=${SNAPSHOT_RETENTION_DAYS}.days.ago`], {
      timeout: SHADOW_GC_TIMEOUT_MS,
    }).catch((err: unknown) => {
      void log("warn", "snapshot shadow gc failed", { shadow: shadow.name, error: String(err) });
    });
  }
}

function readSnapshot(file: string): Promise<RunSnapshot | null> {
  return readFile(file, "utf8").then((text) => JSON.parse(text) as RunSnapshot).catch(() => null);
}

/**
 * The run ids a session still holds a snapshot for, read from the directory once.
 *
 * For a surface that asks about a whole conversation rather than one turn: `/undo list` shows
 * where the hard mode still reaches, and asking per turn would open the directory once per row.
 * A run with a snapshot file is a run whose files can come back; the file's *content* is not read
 * here, so a damaged one still counts until `snapshotOfRuns` refuses it at restore time.
 */
export async function sessionSnapshotRunIds(sessionId: string): Promise<Set<string>> {
  const files = await readdir(sessionDir(sessionId)).catch(() => [] as string[]);
  return new Set(files.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)));
}

/**
 * The snapshot of the state before a turn: the earliest of those its runs recorded. A turn picked
 * back up with Continue has two runs, and the files go back to before the first.
 */
export async function snapshotOfRuns(sessionId: string, runIds: readonly string[]): Promise<RunSnapshot | null> {
  const dir = sessionDir(sessionId);
  const found = await Promise.all(runIds.map((runId) => readSnapshot(join(dir, `${runId}.json`))));
  const recorded = found.filter((snapshot): snapshot is RunSnapshot => snapshot !== null);
  if (recorded.length === 0) return null;
  return recorded.reduce((earliest, snapshot) => (snapshot.ts < earliest.ts ? snapshot : earliest));
}

/**
 * What restoring the snapshot would change in the workspace as it stands now, per depot.
 *
 * Against now rather than against the run's own end: a hard undo writes the *before* state over
 * the current files, and a run that /undo stopped never reached its end -- while the files it wrote
 * are still there. Nothing records a run's end state: this is the reader that never existed, and
 * the second capture it needed was half the file I/O of every run.
 */
export async function changesSince(snapshot: RunSnapshot): Promise<DepotDiff[]> {
  const now = await captureWorkspace(snapshot.before.root, shadowRoot());
  return diffSnapshots(snapshot.before, now, shadowRoot());
}

/** Puts every depot of the snapshot back as it was. */
export async function restoreSnapshot(snapshot: RunSnapshot): Promise<void> {
  for (const depot of snapshot.before.depots) {
    await restoreDepot(depot, shadowRoot());
  }
}

/** Removes a session's snapshots (session deleted, or a fork made it stale). */
export async function clearSessionSnapshots(sessionId: string): Promise<void> {
  await rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
}


