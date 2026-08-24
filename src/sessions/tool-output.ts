/**
 * Where a tool's full output lives -- docs/session-log.md §2.7.
 *
 * A card carries an extract, because a thread would otherwise push every byte every tool ever
 * printed on every reconnect, for the sake of the few a reader opens. The rest goes here, and the
 * entry names it.
 *
 * **No TTL, and that is the design.** opencode expires theirs after seven days
 * (`tool-output-store.ts:15`) because their store is global: a file there has no owner, so the
 * only policy available is a clock. This one lives inside the session, so it has an owner -- the
 * entry that references it -- and no entry is ever deleted. A clock here would delete a file the
 * screen is still offering a "see all" button for, and answer that button with nothing. That is a
 * broken promise, not a retention policy.
 *
 * The file therefore lives exactly as long as its entry: deleted with the session, archived with
 * the session. The sweep below collects orphans only.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../utils/logger.ts";
import { sessionDir, type Entry } from "./log.ts";

/**
 * Above this, the output is spilled and the entry keeps an extract.
 *
 * Well above the 4000 chars a card shows: the point is not to match the card but to keep the log
 * readable. A JSONL line is parsed whole, so a 2 MB output inline would make every read of that
 * conversation pay for it, forever.
 */
export const SPILL_THRESHOLD = 50_000;

export function toolOutputDir(sessionId: string): string {
  return join(sessionDir(sessionId), "tool-output");
}

/**
 * A call id, made safe for a file name.
 *
 * Ids come from a model, so they are not to be trusted as path components even though every one
 * seen so far is alphanumeric. Anything outside the safe set becomes an underscore, which can
 * collide in theory; a collision costs one card the wrong body, where a traversal costs a file
 * outside the session.
 */
function fileNameOf(callId: string): string {
  return callId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unnamed";
}

export function toolOutputPath(sessionId: string, callId: string): string {
  return join(toolOutputDir(sessionId), fileNameOf(callId));
}

export interface SpilledOutput {
  /** What the entry carries inline. */
  output: string;
  /** Where the whole of it went, absent when it fitted. */
  outputPath?: string;
  truncated: boolean;
}

/**
 * Splits an output between the entry and the file, writing the file when there is one.
 *
 * Awaited rather than fired off, unlike an entry append: the entry that names this file is written
 * right after, and an entry pointing at a file that does not exist yet is the one state the "see
 * all" button cannot recover from.
 */
export async function spillToolOutput(sessionId: string, callId: string, output: string, threshold = SPILL_THRESHOLD): Promise<SpilledOutput> {
  if (output.length <= threshold) return { output, truncated: false };
  const path = toolOutputPath(sessionId, callId);
  try {
    await mkdir(toolOutputDir(sessionId), { recursive: true });
    await writeFile(path, output, "utf-8");
  } catch (err) {
    // The extract still reaches the entry: a card with a clipped body and no "see all" is a
    // degraded card, where a failed append would be a lost turn.
    void log("error", "tool output: could not spill, keeping the extract only", { sessionId, callId, error: String(err) });
    return { output: output.slice(0, threshold), truncated: true };
  }
  return { output: output.slice(0, threshold), outputPath: path, truncated: true };
}

/** The whole output of one call, or null when nothing was spilled for it. */
export async function readToolOutput(sessionId: string, callId: string): Promise<string | null> {
  try {
    return await readFile(toolOutputPath(sessionId, callId), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Deletes the spilled outputs no entry refers to, and only those.
 *
 * The residue of a run that was killed between writing the file and appending the entry that
 * names it. Everything else has an owner and is kept: this is a leak collector, not a retention
 * policy, and the difference is that it can never remove something still on screen.
 */
export async function sweepOrphanToolOutput(sessionId: string, entries: readonly Entry[]): Promise<number> {
  const dir = toolOutputDir(sessionId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const owned = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "tool") owned.add(fileNameOf(entry.callId));
  }
  let removed = 0;
  for (const name of names) {
    if (owned.has(name)) continue;
    await rm(join(dir, name), { force: true }).catch(() => {});
    removed += 1;
  }
  if (removed > 0) void log("info", "tool output: orphans swept", { sessionId, removed });
  return removed;
}
