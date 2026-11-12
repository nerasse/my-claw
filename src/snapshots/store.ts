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
const MAX_SNAPSHOTS_PER_SESSION = 20;
const SHADOW_GC_TIMEOUT_MS = 120_000;

export interface RunSnapshot {
  runId: string;
  sessionId: string;
  /** The snapshot taken at the start of this run. */
  before: WorkspaceSnapshot;
  /** The snapshot taken at the end of this run, for the diff. */
  after: WorkspaceSnapshot | null;
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
    after: null,
    ts: Date.now(),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(entry), "utf8");
  return entry;
}

/**
 * Records the *after* state of the run (same runId), for the diff shown by `/undo`.
 *
 * Off the run's own path on purpose. The diff `/undo` shows is computed by `changesSince`, which
 * recaptures the workspace when the owner asks -- so what this writes has no reader today. It is
 * kept because it is the record a future surface would read, and it must never cost a run its
 * wind-down: a stop used to wait for a second full capture of a 34 GB workspace (9.3 s measured
 * on 2026-11-12) before it could be reported. One capture per run is the budget.
 */
export function recordRunEnd(sessionId: string, runId: string, workspace: string): void {
  void (async () => {
    const dir = sessionDir(sessionId);
    const file = join(dir, `${runId}.json`);
    const existing = await readSnapshot(file);
    if (!existing) return;
    existing.after = await captureWorkspace(workspace, shadowRoot());
    await writeFile(file, JSON.stringify(existing), "utf8");
    await pruneSessionSnapshots(sessionId);
  })().catch((err: unknown) => {
    void log("warn", "snapshot after-state not recorded", { sessionId, runId, error: String(err) });
  });
}

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
 * the current files, and a run that /undo stopped never reached its end -- its after snapshot does
 * not exist while the files it wrote do.
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


