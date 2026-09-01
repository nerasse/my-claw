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
import type { WorkspaceSnapshot } from "./capture.ts";
import { captureWorkspace } from "./capture.ts";
import { MY_CLAW_DIR } from "../core/config.ts";

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


