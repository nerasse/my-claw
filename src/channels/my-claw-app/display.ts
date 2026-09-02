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

import { basename } from "node:path";
import { extractMediaRefs, stripMediaRefs } from "../../utils/media.ts";
import { splitAttachmentBlock, stripLocationBlock, type AttachmentBlockEntry } from "../../agent/preprocess.ts";
import { toolDisplayName } from "../../agent/tools/display.ts";
import { toolCardId } from "./types.ts";
import { parseStoredName, type SessionFile } from "./files.ts";
import type { Entry } from "../../sessions/log.ts";
import type { SessionAttachment, SessionSubAgentState } from "../../sessions/store.ts";
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
  /** Files read back out of the `[Attachments]` block the stored turn keeps. */
  attachmentsOfBlock(entries: AttachmentBlockEntry[]): MyClawAppHistoryAttachment[];
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

/**
 * Turns a sync delta's `spawn_state` entries into the cards they revise.
 *
 * A delta is what the client has not seen, and a state entry on its own is not something it can
 * draw: the card it annotates may have arrived pages ago, when the child was still running. Such a
 * state becomes its tool entry, whole -- the client replaces a card by id, and `displayOf` fills in
 * the state from the fold over the entire log, so what it gets back is current rather than a copy
 * of what it already had.
 *
 * **Only when the delta does not already carry that card.** This is where a first version was
 * wrong, and it shipped: `spawn` awaits its child, so the states are written *before* the tool
 * entry and arrive first in the same delta. Materialising the card on the state and then letting
 * the real entry through emitted it twice, and the client keeps both -- it replaces by id against
 * what it already holds, not within one delta. The card came back doubled on every reload.
 *
 * So a tool entry always passes through at its own position, and a state only stands in for a card
 * that is absent. A state whose call never settled is dropped: there is no card yet, and the live
 * frames are still carrying that one.
 */
export function withSpawnCards(delta: readonly Entry[], all: readonly Entry[]): Entry[] {
  if (!delta.some((entry) => entry.type === "spawn_state")) return [...delta];

  // The cards the delta already carries. Their state travels with them, at their own position:
  // nothing has to stand in for them, and standing in is what doubled them.
  const present = new Set<string>();
  for (const entry of delta) if (entry.type === "tool") present.add(entry.callId);

  // Indexed once. Scanning the log per state entry is linear in a conversation that only grows,
  // and a delta is capped at 500: measured at 28 ms on a 4 667-entry session, against 0.1 ms here.
  const cards = new Map<string, Entry>();
  for (const entry of all) if (entry.type === "tool" && !cards.has(entry.callId)) cards.set(entry.callId, entry);

  const out: Entry[] = [];
  for (const entry of delta) {
    if (entry.type !== "spawn_state") {
      out.push(entry);
      continue;
    }
    if (present.has(entry.callId)) continue;
    const card = cards.get(entry.callId);
    if (!card) continue;
    // Once per card, however many states revised it in this delta.
    present.add(entry.callId);
    out.push(card);
  }
  return out;
}

/** The app speaks ISO timestamps; the log stores the millisecond it was written. */
function tsOf(entry: Entry): string {
  return new Date(entry.ts).toISOString();
}

/** `1234 ms` in the block details. The recorder measured it; the server never decodes the file. */
function durationFrom(details: string[]): number | undefined {
  for (const detail of details) {
    const match = /^(\d+) ms$/.exec(detail.trim());
    if (match) return Number(match[1]);
  }
  return undefined;
}

/**
 * The transcript is written into the turn as `[Audio]: "..."` so the model reads words rather
 * than a file. Replayed as-is it would print that marker in the bubble, where the live message
 * showed the sentence under its player. Pulled back out here, a reopened thread renders the
 * same thing it did when it was sent.
 */
function splitTranscript(text: string): string {
  const paragraphs = text.split("\n\n");
  const rest: string[] = [];
  for (const paragraph of paragraphs) {
    // Only the quoted form: a failed take reads `[Audio]: [Transcription failed: ...]`, and that
    // is a fact about the turn the owner needs to keep seeing.
    if (/^\[Audio(?: \d+)?\]: "[\s\S]*"$/.exec(paragraph.trim())) continue;
    rest.push(paragraph);
  }
  return rest.join("\n\n").trim();
}

/**
 * The recorder keys transcripts by server path (that is what it transcribed); the app knows its
 * recordings by attachment id. The id sits in the stored file name, so the mapping is a parse.
 */
function transcriptsById(
  transcripts: Record<string, string>,
  files: SessionFile[],
): Record<string, string> {
  const byName = new Map(files.map((file) => [file.storedName, file.id]));
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(transcripts)) {
    const name = basename(path);
    const id = byName.get(name) ?? parseStoredName(name)?.id;
    if (id) out[id] = text;
  }
  return out;
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
  spawn?: ReadonlyMap<string, SessionSubAgentState>,
  files: SessionFile[] = [],
): MyClawAppHistoryEntry[] {
  const out: MyClawAppHistoryEntry[] = [];

  for (const entry of entries) {
    const ts = tsOf(entry);

    if (entry.type === "user") {
      // A stored turn keeps the LLM-facing rendering (the `[Audio]:` marker and the `[Attachments]`
      // block of server paths) because that is what the model must read; the screen strips it back
      // out. The block is the complete listing (audio, video, files), so it wins over the
      // structured `entry.attachments`, which carries only the images the provider needs.
      const block = splitAttachmentBlock(entry.text);
      const stripped = stripLocationBlock(block.text);
      const text = splitTranscript(stripped);
      const attachments =
        block.attachments.length > 0
          ? resolvers.attachmentsOfBlock(block.attachments)
          : entry.attachments
            ? resolvers.attachmentsOf(entry.attachments)
            : [];
      const transcripts = entry.transcripts ? transcriptsById(entry.transcripts, files) : undefined;
      out.push({
        // The entry's own id, which is the id the live bubble already had. That is what makes a
        // page mergeable with what a device shows instead of duplicating the question of a run in
        // flight, and it replaces `sourceId` outright -- docs/session-log.md annexe A.
        id: entry.id,
        role: "user",
        text,
        ts,
        ...(transcripts && Object.keys(transcripts).length > 0 ? { transcripts } : {}),
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

    // No bubble of its own: it is an annotation on the card named by its `callId`, and it reaches
    // the screen through the `spawn` map -- which is folded from the whole log, not from this page,
    // because a child launched fifty entries ago finishes here.
    if (entry.type === "spawn_state") continue;

    if (entry.type === "tool") {
      const output = entry.output;
      const truncated = entry.truncated || output.length > outputLimit;
      const state = spawn?.get(entry.callId) ?? entry.spawn;
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
        // The tool itself never spins here -- an entry exists only once the call has settled, and a
        // call in flight is carried by the live frames and by `chat.history.activeRun` (commit
        // 48f084d). The sub-agent behind it can, though: `spawn` returns while the child works, so
        // a `running` state on a settled card is the honest reading of a background child.
        ...(state ? { spawn: state } : {}),
        ts,
      });
      continue;
    }

    if (entry.type === "command") {
      // A command entry has one log id but produces two bubbles. Prefer the chat.send id so both
      // replayed bubbles match the live input and `cmd-<send id>` result; old entries keep the
      // generated-id fallback. A quiet command (undo, retry, branches) replays its result only:
      // the input line was never shown live, so it must not reappear on a refresh.
      const sourceId = entry.sourceId || entry.id;
      if (!entry.quiet) {
        out.push({ id: sourceId, role: "user", text: entry.input, ts });
      }
      out.push({
        id: `cmd-${sourceId}`,
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
