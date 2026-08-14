/**
 * Reading back what the SDK wrote. The compaction summary is the one piece of a compaction the
 * owner may want to read, and the SDK does not hand it to the caller: `compact_boundary` carries
 * counters only, and the summary lands in the transcript as the continuation message that opens
 * the compacted session. So it is read from there, after the fact.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../core/config.ts";

/** Where the CLI keeps its sessions, one directory per project (cwd-derived, opaque here). */
const PROJECTS_DIR = join(MY_CLAW_DIR, "claude-sdk", "projects");

/** The preamble the CLI writes above the summary, and the instructions it writes below it. */
const SUMMARY_START = /^Summary:\s*$/m;
const SUMMARY_END = /\n\nIf you need specific details from before compaction/;

/**
 * Pulls the summary out of the continuation message that follows the last compaction boundary.
 * A file with no boundary, or one whose boundary is not followed by a continuation, yields
 * nothing: the caller then says the compaction happened without pretending to quote it.
 */
export function extractCompactSummary(lines: string[]): string | undefined {
  let lastBoundary = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.includes('"compact_boundary"')) lastBoundary = i;
  }
  if (lastBoundary < 0) return undefined;

  for (let i = lastBoundary + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = parsed as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== "user" || entry.message?.role !== "user") continue;
    const content = entry.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
            .join("")
        : "";
    if (!text) continue;
    // The first user message after the boundary is the continuation; anything else means the
    // conversation had already moved on and the summary is not ours to quote.
    const start = SUMMARY_START.exec(text);
    if (!start) return undefined;
    const body = text.slice(start.index + start[0].length);
    const end = SUMMARY_END.exec(body);
    return (end ? body.slice(0, end.index) : body).trim() || undefined;
  }
  return undefined;
}

/**
 * The transcript of a session, found by id rather than by path: the CLI files a session under the
 * project of the cwd that created it, and a compaction runs without one, so the location is not
 * derivable from anything this process knows.
 */
async function transcriptPath(sessionId: string): Promise<string | undefined> {
  let projects: string[];
  try {
    projects = await readdir(PROJECTS_DIR);
  } catch {
    return undefined;
  }
  for (const project of projects) {
    const candidate = join(PROJECTS_DIR, project, `${sessionId}.jsonl`);
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
}

/** The last compaction summary of a session, or nothing when it cannot be read. */
export async function readCompactSummary(sessionId: string): Promise<string | undefined> {
  const path = await transcriptPath(sessionId);
  if (!path) return undefined;
  try {
    const text = await Bun.file(path).text();
    return extractCompactSummary(text.split("\n"));
  } catch {
    return undefined;
  }
}
