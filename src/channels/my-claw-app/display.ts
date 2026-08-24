/**
 * The log, read as a thread on a screen -- docs/session-log.md §3.3.
 *
 * One entry, one bubble, in order. That sentence is the whole design, and it is worth stating
 * because the code it replaces could not say it: a page had to re-derive bubbles from a prompt
 * array, so it recollated commands and failures by timestamp, folded them into `asides`, flushed
 * them between messages and derived ids from `entries.length`. None of that survives here, because
 * the thing being read is now the thing that was written.
 *
 * This lives in the channel and not in `sessions/` on purpose: it resolves attachments and media
 * refs against a thread's file store and renames tools for display, all of which belong to a
 * channel. `sessions/` does not depend on `channels/`.
 */

import { extractMediaRefs, stripMediaRefs } from "../../utils/media.ts";
import { toolDisplayName } from "../../agent/tools/display.ts";
import { toolCardId } from "./types.ts";
import type { Entry } from "../../sessions/log.ts";
import type { SessionAttachment } from "../../sessions/store.ts";
import type { MyClawAppHistoryAttachment, MyClawAppHistoryEntry } from "./types.ts";

/**
 * How the two kinds of attachment become the ones the app draws.
 *
 * Injected rather than imported: both need the thread's file listing, which is I/O, and keeping it
 * out is what lets this whole module be tested with plain data.
 */
export interface DisplayResolvers {
  /** Files the owner attached to a question, already structured on the entry. */
  attachmentsOf(attachments: SessionAttachment[]): MyClawAppHistoryAttachment[];
  /** Files the agent named with a `MEDIA:` ref in its own text. */
  mediaOf(refs: Array<{ path: string }>): MyClawAppHistoryAttachment[];
}

/**
 * A page of a branch, counted in entries and aligned on a turn.
 *
 * `before` counts back from the newest entry, so page N ends where page N-1 began. The start is
 * then walked back to the `user` entry that opened its turn: a page is a count, a conversation is
 * read in turns, and one agentic turn is easily fifty tool results, so a fixed cut lands in the
 * middle of the work and leaves the question that caused it on the page above -- which reads as a
 * lost message rather than as pagination. The walk is bounded, so one pathological turn cannot
 * drag a whole session in.
 */
export function pageOf(
  path: readonly Entry[],
  limit: number,
  before: number,
  lookback = MAX_TURN_LOOKBACK,
): { window: Entry[]; hasMore: boolean; nextBefore: number } {
  const total = path.length;
  const end = Math.max(total - Math.max(before, 0), 0);
  const rawStart = Math.max(end - Math.max(limit, 0), 0);
  const floor = Math.max(rawStart - Math.max(lookback, 0), 0);
  let start = rawStart;
  while (start > floor && path[start]!.type !== "user") start -= 1;
  return { window: path.slice(start, end), hasMore: start > 0, nextBefore: total - start };
}

/** Long enough for a real turn, short enough that one runaway turn does not pull in the session. */
const MAX_TURN_LOOKBACK = 400;

/** The app speaks ISO timestamps; the log stores the millisecond it was written. */
function tsOf(entry: Entry): string {
  return new Date(entry.ts).toISOString();
}

/**
 * Entries in, bubbles out.
 *
 * `outputLimit` clips a tool card: a thread would otherwise carry every byte every tool ever
 * printed, on every reconnect, for the sake of the few a reader opens. `toolOutput` serves the
 * rest on demand.
 */
export function displayOf(
  entries: readonly Entry[],
  resolvers: DisplayResolvers,
  outputLimit: number,
): MyClawAppHistoryEntry[] {
  const out: MyClawAppHistoryEntry[] = [];

  for (const entry of entries) {
    const ts = tsOf(entry);

    if (entry.type === "user") {
      const attachments = entry.attachments ? resolvers.attachmentsOf(entry.attachments) : [];
      out.push({
        // The entry's own id, which is the id the live bubble already had. That is what makes a
        // page mergeable with what a device shows instead of duplicating the question of a run in
        // flight, and it replaces `sourceId` outright -- docs/session-log.md annexe A.
        id: entry.id,
        role: "user",
        text: entry.text,
        ts,
        ...(entry.transcripts && Object.keys(entry.transcripts).length > 0 ? { transcripts: entry.transcripts } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(entry.location ? { location: entry.location } : {}),
      });
      continue;
    }

    if (entry.type === "phase") {
      // The agent names its files with `MEDIA:` refs; a replayed turn must show real attachments.
      const refs = extractMediaRefs(entry.text);
      const text = stripMediaRefs(entry.text).trim();
      const media = refs.length > 0 ? resolvers.mediaOf(refs) : [];
      // A phase that only thought before calling a tool wrote no prose, and the bubble the reader
      // saw was that thought: dropping it is what made a reopened thread jump from the question
      // straight to a tool card. A phase with nothing at all is not a bubble.
      if (!text && media.length === 0 && !entry.reasoning?.trim() && !entry.reasoningTokens) continue;
      out.push({
        id: entry.id,
        role: "assistant",
        text,
        ts,
        ...(media.length > 0 ? { attachments: media } : {}),
        ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
        ...(entry.reasoningTokens ? { reasoningTokens: entry.reasoningTokens } : {}),
      });
      continue;
    }

    if (entry.type === "tool") {
      const output = entry.output;
      const truncated = entry.truncated || output.length > outputLimit;
      out.push({
        // Keyed on the model's own call id, so this card and the live one are one card. They used
        // to differ, and a tool finishing after a reload appended a second card beside the first.
        id: toolCardId(entry.callId) ?? entry.id,
        role: "tool",
        // Sessions written before the mirror was cleaned hold `mcp__myclaw__bash`, the name the
        // SDK gives our own tools; the card shows the tool, not the plumbing.
        name: toolDisplayName(entry.name),
        args: entry.args,
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
        ok: entry.ok,
        output: truncated ? output.slice(0, outputLimit) : output,
        truncated,
        // No `running` here, ever: an entry exists only once the call has settled. A card still
        // spinning is carried by the live frames and by `chat.history.activeRun` (commit 48f084d).
        ...(entry.spawn ? { spawn: entry.spawn } : {}),
        ts,
      });
      continue;
    }

    if (entry.type === "command") {
      // Two bubbles, the same two the device drew live: what was typed, and the answer under it.
      out.push({ id: `${entry.id}-in`, role: "user", text: entry.input, ts });
      out.push({
        id: `${entry.id}-out`,
        role: "assistant",
        text: entry.output,
        ts,
        command: true,
        ...(entry.details ? { details: entry.details } : {}),
      });
      continue;
    }

    if (entry.type === "failure") {
      // The error bubble the owner saw live, under the question it never answered. A question with
      // nothing under it reads as a message the agent ignored.
      out.push({ id: entry.id, role: "assistant", text: "", ts, error: entry.error });
      continue;
    }

    if (entry.type === "compaction") {
      // Stored as a user turn because that is the role the prompt needs it in; drawn as a boundary
      // because replayed as a user turn it reads as a wall of `[Prior context summarized]` in the
      // owner's own voice. The turns it stands for are still above it, in full.
      out.push({ id: entry.id, role: "user", text: entry.summary, ts, summaryOf: entry.count });
      continue;
    }

    if (entry.type === "note") {
      out.push({ id: entry.id, role: "assistant", text: entry.text, ts });
      continue;
    }

    if (entry.type === "model_change") {
      const label = [entry.model, entry.effort].filter(Boolean).join(" ");
      out.push({ id: entry.id, role: "assistant", text: label, ts, command: true });
    }
  }

  return out;
}
