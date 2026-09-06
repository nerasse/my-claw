/**
 * Per-run snapshot store -- the *before* state of the workspace, tied to a run, for `/undo`.
 *
 * Both the conversation branch and the file state belong to the same "undo point". The
 * conversation side is `meta.undo`; the file side is a snapshot recorded at the start of the
 * run that produced the turn being undone. `undo` reads both: branch the log, and restore the
 * files to the snapshot of the run that wrote them.
 *
 * Snapshots live under `$MY_CLAW_DIR/snapshots/<sessionId>/<runId>.json`; the git trees they
 * reference live in the shared shadow store (`snapshots/shadow`). A session keeps its snapshots
 * until the next run replaces them: `/undo` restores the *previous* run's snapshot, so the last
 * run's snapshot must still be there when the owner asks.
 */

import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../utils/logger.ts";
import type { WorkspaceSnapshot } from "./capture.ts";
import { captureWorkspace } from "./capture.ts";
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

/** Captures the workspace and records it as this run's *before* snapshot. */
export async function recordRunStart(sessionId: string, workspace: string): Promise<RunSnapshot> {
  const run = await captureWorkspace(workspace, shadowRoot());
  const entry: RunSnapshot = {
    runId: randomUUID(),
    sessionId,
    before: run,
    after: null,
    ts: Date.now(),
  };
  const dir = sessionDir(sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${entry.runId}.json`), JSON.stringify(entry), "utf8");
  return entry;
}

/** Records the *after* state of the run (same runId), for the diff shown by `/undo`. */
export async function recordRunEnd(sessionId: string, runId: string, workspace: string): Promise<void> {
  const dir = sessionDir(sessionId);
  const file = join(dir, `${runId}.json`);
  const existing = await readFile(file, "utf8").then((t) => JSON.parse(t) as RunSnapshot).catch(() => null);
  if (!existing) return;
  const after = await captureWorkspace(workspace, shadowRoot());
  existing.after = after;
  await writeFile(file, JSON.stringify(existing), "utf8");
  await pruneSessionSnapshots(sessionId);
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

/** The most recent recorded snapshot for the session, if any. */
export async function latestSnapshot(sessionId: string): Promise<RunSnapshot | null> {
  const dir = sessionDir(sessionId);
  const files = await readdir(dir).catch(() => [] as string[]);
  if (files.length === 0) return null;
  const entries = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        const t = await readFile(join(dir, f), "utf8").then((s) => JSON.parse(s) as RunSnapshot).catch(() => null);
        return t;
      }),
  );
  const valid = entries.filter((e): e is RunSnapshot => e !== null);
  if (valid.length === 0) return null;
  valid.sort((a, b) => b.ts - a.ts);
  return valid[0]!;
}

/** Removes a session's snapshots (session deleted, or a fork made it stale). */
export async function clearSessionSnapshots(sessionId: string): Promise<void> {
  await rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
}


