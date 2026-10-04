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
import type { SpawnView } from "../../sessions/spawn-state.ts";
import type { SessionAttachment } from "../../sessions/store.ts";
import type {
  MyClawAppHistoryAttachment,
  MyClawAppHistoryEntry,
  MyClawAppRunMeta,
  MyClawAppRunSummaryEntry,
} from "./types.ts";

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
  mediaOf(refs: MediaRef[]): MyClawAppHistoryAttachment[];
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
 * Whether `displayId` is one of the ids `displayOf` gives this entry.
 *
 * The inverse of the id assignment in `displayOf`, and it lives in the same file for that
 * reason: paging asks by the id the *client* holds, so every shape the client can hold has to
 * resolve back to its entry. A tool card is keyed by its model call id (`t-<callId>`), a
 * command produces two bubbles (`<sourceId>` and `cmd-<sourceId>`), everything else carries the
 * entry id. Miss one and paging dies on a thread whose oldest held bubble happens to be of that
 * kind -- which is what shipped in 0.4.83: the client's `t-<callId>` matched nothing, the page
 * came back empty, and the app read that as the top of the conversation.
 */
function carriesDisplayId(entry: Entry, displayId: string): boolean {
  if (entry.id === displayId) return true;
  // A folded group travels as one row, `run-<id>`, where the id is the first entry it stands
  // for. The page above it therefore ends exactly there -- and a run cut into segments by an
  // injection has one such row per segment, which keying on the run id could not express.
  if (displayId.startsWith("run-") && entry.id === displayId.slice(4)) return true;
  if (entry.type === "tool") return toolCardId(entry.callId) === displayId;
  if (entry.type === "command") {
    const sourceId = entry.sourceId || entry.id;
    return sourceId === displayId || `cmd-${sourceId}` === displayId;
  }
  return false;
}

/**
 * The page just before the entry `beforeId` -- the id-based counterpart of `pageOf`.
 *
 * The window ends right before the referenced entry (exclusive), which is the client's own
 * oldest held item: its id travels back as the cursor, so nothing has to stay true about counts
 * between requests -- the count drifts when the session grows, the id does not.
 *
 * An id this branch no longer holds (compaction dropped the turn, a fork left it behind) falls
 * back to the count cursor the client sends alongside it. Never to an empty page: "no entries,
 * nothing older" is indistinguishable from the top of the conversation, so the client stops for
 * good on one unresolvable id. Degrading to an approximate cursor is recoverable, dying is not.
 */
export function pageBefore(
  path: readonly Entry[],
  beforeId: string,
  limit: number,
  fallbackBefore: number,
  lookback = MAX_TURN_LOOKBACK,
): { window: Entry[]; hasMore: boolean; nextBefore: number } {
  const total = path.length;
  let end = -1;
  for (let i = total - 1; i >= 0; i -= 1) {
    if (carriesDisplayId(path[i]!, beforeId)) {
      end = i;
      break;
    }
  }
  if (end < 0) return pageOf(path, limit, fallbackBefore, lookback);
  const rawStart = Math.max(end - Math.max(limit, 0), 0);
  const floor = Math.max(rawStart - Math.max(lookback, 0), 0);
  let start = rawStart;
  while (start > floor && path[start]!.type !== "user") start -= 1;
  return { window: path.slice(start, end), hasMore: start > 0, nextBefore: total - start };
}

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
 * that is absent. A state whose card the log does not hold *at all* passes through too: it is the
 * only thing that can draw the card, and `displayOf` draws it from the state. Dropping it here is
 * what made a reload lose a child that had already finished -- the live frames carry those, and a
 * fresh page has none (2026-09-21).
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
    if (!card) {
      // Nowhere in the log: let the state through, `displayOf` draws the card from it.
      out.push(entry);
      present.add(entry.callId);
      continue;
    }
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

/**
 * Walks a branch in order, tagging every entry with the run it belongs to -- docs/run-grouping.md.
 *
 * A `run_start` opens a run, the matching `run_end` closes it with its reason, and everything in
 * between (phases, tools, injected turns) belongs to it. The fold is keyed by entry id so the
 * client can group any window of a page or delta without holding the markers themselves, which
 * stay inside the log where the wire never needs them.
 *
 * A trailing run with no `run_end` stays `running`: the caller decides its terminality from the
 * run registry (`activeRun`), because a crash can leave exactly this shape in a file.
 *
 * A run with no `run_end` that is *not* trailing is dead: only one run is ever in flight on a
 * branch, so the next `run_start` proves the previous one never closed here. A crash leaves that
 * shape, and so did the branch a stale log leaf split (docs/session-log.md, one instance per
 * session). It closes as `done` at its last own entry, the same verdict the app gives a trailing
 * dead run, and the turn that triggers the next run stays out of it: left open, the run rendered
 * as running forever (the app settles only the trailing run) and the new question read as a steer
 * folded into the old work.
 *
 * A run that ended having written nothing -- stopped right after the message was sent, or failed
 * on its first call -- has no entry to carry it, so it would reach the app as nothing at all, and
 * with it the run's signature and the Continue that picks the message back up. Its meta goes on
 * the message that triggered it. So does an end with no start: a Stop before the run wrote its own
 * marker (during the snapshot, the transcription, a compaction ahead of it) leaves exactly that.
 */
export function runFold(path: readonly Entry[]): Map<string, MyClawAppRunMeta> {
  const out = new Map<string, MyClawAppRunMeta>();
  let current: MyClawAppRunMeta | null = null;
  let currentAt = -1;
  let lastTs = "";
  const closeDead = () => {
    if (!current) return;
    current.status = "done";
    current.endTs = lastTs;
    current = null;
  };
  for (let i = 0; i < path.length; i++) {
    const entry = path[i]!;
    if (entry.type === "run_start") {
      closeDead();
      current = { id: entry.runId ?? entry.id, status: "running", startTs: tsOf(entry) };
      currentAt = i;
      out.set(entry.id, current);
      lastTs = tsOf(entry);
      continue;
    }
    if (entry.type === "run_end") {
      const trigger = path[current ? currentAt - 1 : i - 1];
      const empty = current ? currentAt === i - 1 : true;
      const ended: MyClawAppRunMeta = current ?? { id: entry.id, status: entry.reason, startTs: tsOf(entry) };
      ended.status = entry.reason;
      ended.endTs = tsOf(entry);
      if (empty && trigger?.type === "user") out.set(trigger.id, ended);
      current = null;
      continue;
    }
    // The owner's turn that opens the next run is not a steer into the dead one.
    if (entry.type === "user" && path[i + 1]?.type === "run_start") closeDead();
    if (current) {
      out.set(entry.id, current);
      lastTs = tsOf(entry);
    }
  }
  return out;
}

/**
 * Which runs of this window travel as a header instead of as their work -- docs/run-hydration.md.
 *
 * The measurement that motivates it: opening a real 12 034-entry session moved 1 124 KB, of which
 * 18 KB was prose a reader could see (1,6 %). The rest was tool output inside finished runs the
 * app draws collapsed -- fetched, parsed and held so that a fold could hide it. Sending the header
 * alone puts that page at 21 KB, and `session.run.items` fetches the work if the reader opens it.
 *
 * What is folded is a **segment between two messages**: consecutive work of one terminal run,
 * inside this page. Messages are what the reader follows, so they never fold -- every reply the
 * agent wrote, and every picture it sent, stays on screen, and the header hides the work between
 * two of them (owner's decision, 2026-09-17: "je veux pouvoir tous les voir, ce qu'il y a entre
 * se regroupe"). A message is a phase with words, or one carrying media -- its own `MEDIA:` refs,
 * or the pictures its tools produced and the `run_end` pinned on it.
 *
 * - **Terminal only.** A running run is what the live frames are appending to; folding the thing
 *   currently being watched would fight the stream.
 * - **Messages and hoisted bubbles cut it**, exactly as `runRows.ts` cuts a group in the app: the
 *   owner's injected turns, commands, compaction boundaries, and every message stay on screen.
 *   Fold those away and a reopened conversation is a list of questions with collapsed headers
 *   and nothing under them.
 * - **The page boundary cuts it too.** A run spanning three pages folds into one row per page.
 *   The first version required the run to sit wholly inside the window, to avoid emitting the
 *   same row id twice -- but measured on the real session that refused to fold anything on the
 *   deep pages, which are the heavy ones (607 rows sent where the app drew 46). Keying each row
 *   on the first entry it stands for makes the ids distinct by construction, so the restriction
 *   bought nothing. The app merges two adjacent summaries of the same run into one group.
 *
 * Below `minItems` the fold is not worth a round trip: on the measured session, runs of 1-3 items
 * are 63 % of the runs and 3,2 % of the bytes, while runs of 31+ are 21 % of the runs and 86 % of
 * the bytes. Small segments stay whole and stay instant.
 */
export interface RunFoldPlan {
  /** Keyed by the entry the summary stands at: the first one it folds. */
  summaries: Map<string, MyClawAppRunSummaryEntry>;
  /** Entries that travel folded, and so must not be rendered. */
  folded: Set<string>;
}

export function runFoldPlan(
  window: readonly Entry[],
  runs: ReadonlyMap<string, MyClawAppRunMeta>,
  minItems = RUN_FOLD_MIN_ITEMS,
): RunFoldPlan {
  const plan: RunFoldPlan = { summaries: new Map(), folded: new Set() };
  if (window.length === 0) return plan;

  // The phases the run's media landed on: a picture with no words is a message too, so those
  // phases have to be told apart from the ones that only thought before calling a tool.
  const mediaPhases = mediaPhasesOf(window);

  // One pass over the page, folding runs of consecutive work. A message or a hoisted bubble cuts
  // the group in two rather than travelling inside it, which is what keeps a folded conversation
  // readable: message, header, message.
  let group: Entry[] = [];
  let groupRun: MyClawAppRunMeta | null = null;
  const flush = () => {
    if (groupRun && group.length > 0) {
      const rows = group.reduce((n, entry) => n + rowsOf(entry, mediaPhases), 0);
      if (rows >= minItems) {
        const first = group[0]!;
        const last = group[group.length - 1]!;
        const tools = group.filter((entry) => entry.type === "tool");
        const firstTool = tools[0];
        plan.summaries.set(first.id, {
          id: `run-${first.id}`,
          role: "run",
          // Where the work stood, not where the run opened: a run cut into segments has a header
          // per segment, and they must sort in the order the reader met them.
          ts: new Date(first.ts).toISOString(),
          run: groupRun,
          toolCount: tools.length,
          ...(firstTool?.type === "tool" ? { firstTool: toolDisplayName(firstTool.name) } : {}),
          itemCount: rows,
          lastId: last.id,
        });
        for (const entry of group) plan.folded.add(entry.id);
      }
    }
    group = [];
    groupRun = null;
  };

  for (const entry of window) {
    const meta = runs.get(entry.id);
    const foldable =
      meta !== undefined &&
      meta.status !== "running" &&
      !isHoisted(entry) &&
      !isMessage(entry, mediaPhases);
    // An entry that draws nothing is transparent: it neither opens a group -- the summary has to
    // stand on a row the client can point a cursor at -- nor breaks one, which the `run_start`
    // marker sitting at the head of every run would otherwise do to all of them.
    if (rowsOf(entry, mediaPhases) === 0) {
      if (foldable && groupRun) group.push(entry);
      continue;
    }
    if (!foldable) {
      flush();
      continue;
    }
    if (groupRun && groupRun.id !== meta.id) flush();
    groupRun = meta;
    group.push(entry);
  }
  flush();
  return plan;
}

/**
 * The phases the media of a run lands on, read the way `displayOf` reads it.
 *
 * The end marker is written after the phase it belongs to, so the last phase before a `run_end`
 * that carries media is the bubble those pictures hang on -- and a bubble with pictures is a
 * message even when it has no words (2026-09-14).
 */
function mediaPhasesOf(window: readonly Entry[]): Set<string> {
  const out = new Set<string>();
  let lastPhase: string | undefined;
  for (const entry of window) {
    if (entry.type === "phase") lastPhase = entry.id;
    else if (entry.type === "run_end" && entry.media?.length && lastPhase) out.add(lastPhase);
  }
  return out;
}

/**
 * A message the agent addressed to the owner: the words it wrote, or the pictures it sent.
 *
 * Everything else in a terminal run is work, and folds between two messages. A phase that only
 * thought before calling a tool wrote nothing and carries nothing: it stays in the fold.
 */
function isMessage(entry: Entry, mediaPhases: ReadonlySet<string>): boolean {
  if (entry.type !== "phase") return false;
  return entry.text.trim() !== "" || mediaPhases.has(entry.id);
}

/**
 * Bubbles that never travel folded, mirroring `isHoisted` in the app's `runRows.ts`.
 *
 * The owner's own turns (an injection splits the group around it, so the answer to a question
 * stays readable), command output and the model-change notices (the agent did not write them),
 * and compaction boundaries (a divider across the thread, not a bubble). Everything else is the
 * run's work: tool cards and thinking phases fold between the messages (see `isMessage`).
 *
 * This rule used to live in the app alone, and it stays there for what the app draws live. It has
 * to exist here too because the server is what decides not to send something, and the two are
 * kept honest by the same names: fold a hoisted bubble away and a reopened conversation becomes a
 * list of questions with collapsed headers and no answers under them.
 */
function isHoisted(entry: Entry): boolean {
  return (
    entry.type === "user" ||
    entry.type === "command" ||
    entry.type === "compaction" ||
    // A stopped compaction's trace is the boundary's sibling: a rule across the thread, in the
    // place the pass gave up, and never something to fold under a run's header -- at the moment
    // it is written there is no run open at all.
    entry.type === "compaction_stopped" ||
    entry.type === "model_change"
  );
}


/**
 * Where folding starts paying. Under it the header costs more than the work it hides, and a reader
 * who opens a three-item run should not wait on a round trip to see three lines.
 */
export const RUN_FOLD_MIN_ITEMS = 8;

/**
 * How many bubbles this entry becomes -- the same arithmetic `displayOf` does, so the placeholder
 * a folded group draws is the size of what will actually arrive.
 *
 * Worth being exact about: measured on the real session, counting entries rather than rows claimed
 * 528 items for a run that renders 386, because a turn writes a `phase` per tool call and the ones
 * that only thought before calling carry nothing to draw. A skeleton a third too long is a
 * scrollbar that jumps when the items land.
 */
function rowsOf(entry: Entry, mediaPhases?: ReadonlySet<string>): number {
  // Bookkeeping: the run markers and the spawn annotations reach no screen.
  if (entry.type === "run_start" || entry.type === "run_end" || entry.type === "spawn_state") return 0;
  if (entry.type === "phase") {
    // Mirrors the drop in `displayOf`: no words, no media (a `MEDIA:` ref lives in the text, and
    // a tool's pictures land on the phase), no thought. Anything else is a bubble.
    const empty =
      !entry.text.trim() && !entry.reasoning?.trim() && !entry.reasoningTokens && !mediaPhases?.has(entry.id);
    return empty ? 0 : 1;
  }
  // A command draws its input and its answer, unless it was quiet -- then the answer alone.
  if (entry.type === "command") return entry.quiet ? 1 : 2;
  return 1;
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
 * Every path a window's display will try to resolve, whatever carried it, paired with the store id
 * when the log already knows one.
 */
export interface MediaRef {
  path: string;
  id?: string;
}

export function mediaRefsOf(entries: readonly Entry[]): MediaRef[] {
  const refs: MediaRef[] = [];
  for (const entry of entries) {
    if (entry.type === "phase") refs.push(...extractMediaRefs(entry.text).map((ref) => ({ path: ref.path })));
    else if (entry.type === "run_end" && entry.media?.length) {
      refs.push(...entry.media.map((path, i) => {
        const id = entry.mediaIds?.[i];
        return id ? { path, id } : { path };
      }));
    }
  }
  return refs;
}

/**
 * Whether serving this window needs the thread's file list -- the bytes a media ref resolves to.
 *
 * Asked with the refs themselves, never with a proxy for them. "Does this window contain `MEDIA:`"
 * was that proxy, and it knows two of the three ways a turn carries media: a tool's pictures ride
 * the run's end marker with no ref anywhere in the prose, so a delta that delivered one resolved
 * nothing and drew an empty stage under a bare filename (2026-09-15).
 *
 * A delta is where it showed: the window is everything written since the client's cursor, so it
 * carries the run's entries and never the question that opened it.
 *
 * A ref the log already paired with a store id needs no listing: the device fetches that id, and
 * the store finds it from any thread of its owner. The listing is for what is left -- prose refs,
 * and markers written before the ids existed.
 */
export function windowNeedsFiles(entries: readonly Entry[]): boolean {
  if (entries.some((entry) => entry.type === "user")) return true;
  return mediaRefsOf(entries).some((ref) => !ref.id);
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
  spawn?: SpawnView,
  files: SessionFile[] = [],
  runs?: ReadonlyMap<string, MyClawAppRunMeta>,
  fold?: RunFoldPlan,
): MyClawAppHistoryEntry[] {
  const out: MyClawAppHistoryEntry[] = [];
  // The cards this window drew from a state entry, so several states of one child draw one card.
  const drawnFromState = new Set<string>();

  /**
   * What each run's tools produced, keyed by the phase that answers with it.
   *
   * The end marker is written after the phase it belongs to, so this reads the entries once to
   * pair them: the last phase of a run is the answer the live bubble hung its pictures on, and a
   * reload that lost them showed the prose alone (2026-09-14).
   */
  const mediaByPhase = new Map<string, MediaRef[]>();
  {
    let lastPhase: string | undefined;
    for (const entry of entries) {
      if (entry.type === "phase") lastPhase = entry.id;
      else if (entry.type === "run_end" && entry.media?.length && lastPhase) {
        const refs = entry.media.map((path, i) => {
          const id = entry.mediaIds?.[i];
          return id ? { path, id } : { path };
        });
        mediaByPhase.set(lastPhase, [...(mediaByPhase.get(lastPhase) ?? []), ...refs]);
      }
    }
  }

  let previous: Entry | undefined;
  for (const entry of entries) {
    const prior = previous;
    previous = entry;
    const ts = tsOf(entry);

    // A folded run stands at its own marker: the header goes out here, and the work it hides is
    // skipped below. The marker was already the entry that rendered to nothing, so the summary
    // lands exactly where the run's first item would have been.
    const summary = fold?.summaries.get(entry.id);
    if (summary) out.push(summary);
    if (fold?.folded.has(entry.id)) continue;

    // The run markers are bookkeeping, not bubbles: the work between them carries the run meta
    // and the client folds it. Leaking them as empty rows is what a replay would do otherwise.
    if (entry.type === "run_start" || entry.type === "run_end") continue;

    const run = runs?.get(entry.id);
    const withRun = <T extends MyClawAppHistoryEntry>(item: T): T =>
      run ? { ...item, run } : item;

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
      out.push(withRun({
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
      }));
      continue;
    }

    if (entry.type === "phase") {
      // The agent names its files with `MEDIA:` refs; a replayed turn must show real attachments.
      const refs: MediaRef[] = extractMediaRefs(entry.text);
      const text = stripMediaRefs(entry.text).trim();
      // Its own refs first, then what its tools attached: the order the live frame is built in.
      refs.push(...(mediaByPhase.get(entry.id) ?? []));
      const media = refs.length > 0 ? resolvers.mediaOf(refs) : [];
      // A phase that only thought before calling a tool wrote no prose, and the bubble the reader
      // saw was that thought: dropping it is what made a reopened thread jump from the question
      // straight to a tool card. A phase with nothing at all is not a bubble.
      if (!text && media.length === 0 && !entry.reasoning?.trim() && !entry.reasoningTokens) continue;
      out.push(withRun({
        id: entry.id,
        role: "assistant",
        text,
        ts,
        ...(media.length > 0 ? { attachments: media } : {}),
        ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
        ...(entry.reasoningTokens ? { reasoningTokens: entry.reasoningTokens } : {}),
        ...(entry.reasoningMs !== undefined ? { reasoningMs: entry.reasoningMs } : {}),
      }));
      continue;
    }

    // No bubble of its own: it is an annotation on the card named by its `callId`, and it reaches
    // the screen through the `spawn` fold -- which covers the whole log, not this page, because a
    // child launched fifty entries ago finishes here.
    //
    // When the log does not carry that card yet, the state draws it here, at its own position.
    // `spawn` returns while the child works, so its tool entry is written only when the whole batch
    // settles: a child that finished early has a state and no entry, and a client that connects in
    // that window saw the card vanish -- it was carried by the live frames alone, and a fresh page
    // has none. Measured 2026-09-21: three children, the first failed after 26s, the slowest ran 8
    // minutes, and a reload in between dropped the failed card from the page.
    if (entry.type === "spawn_state") {
      const state = spawn?.states.get(entry.callId);
      if (!state || spawn?.carded.has(entry.callId) || drawnFromState.has(entry.callId)) continue;
      drawnFromState.add(entry.callId);
      out.push(withRun({
        // The same id the tool entry will produce, so the card that lands later replaces this one
        // rather than standing beside it -- `toolCardId` is what both paths key on.
        id: toolCardId(entry.callId) ?? entry.id,
        role: "tool",
        name: state.action === "send" ? "send" : "spawn",
        args: {
          ...(state.agentType ? { type: state.agentType } : {}),
          ...(state.mode ? { mode: state.mode } : {}),
          ...(state.task ? { task: state.task } : {}),
        },
        ok: state.status === "complete",
        output: "",
        truncated: false,
        spawn: state,
        ts,
      }));
      continue;
    }

    if (entry.type === "tool") {
      const output = entry.output;
      const truncated = entry.truncated || output.length > outputLimit;
      const state = spawn?.states.get(entry.callId) ?? entry.spawn;
      out.push(withRun({
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
      }));
      continue;
    }

    if (entry.type === "command") {
      // A command entry has one log id but produces two bubbles. Prefer the chat.send id so both
      // replayed bubbles match the live input and `cmd-<send id>` result; old entries keep the
      // generated-id fallback. A quiet command (undo, retry, branches) replays its result only:
      // the input line was never shown live, so it must not reappear on a refresh.
      const sourceId = entry.sourceId || entry.id;
      if (!entry.quiet) {
        out.push(withRun({ id: sourceId, role: "user", text: entry.input, ts }));
      }
      // A `/compact` that wrote the boundary right above is already reported by it, in full and
      // with the same summary: the two entries are adjacent and the bubble repeats the rule. Only
      // that pair is dropped -- a refusal, or an engine that summarized without writing a
      // boundary, has nothing else to speak for it and keeps its line.
      if (prior?.type === "compaction" && entry.output.startsWith("Context compacted")) {
        continue;
      }
      out.push(withRun({
        id: `cmd-${sourceId}`,
        role: "assistant",
        text: entry.output,
        ts,
        command: true,
        ...(entry.details ? { details: entry.details } : {}),
      }));
      continue;
    }

    if (entry.type === "failure") {
      // The error bubble the owner saw live, under the question it never answered. A question with
      // nothing under it reads as a message the agent ignored.
      out.push(withRun({ id: entry.id, role: "assistant", text: "", ts, error: entry.error }));
      continue;
    }

    if (entry.type === "compaction") {
      // Stored as a user turn because that is the role the prompt needs it in; drawn as a boundary
      // because replayed as a user turn it reads as a wall of `[Prior context summarized]` in the
      // owner's own voice. The turns it stands for are still above it, in full.
      out.push(withRun({
        id: entry.id,
        role: "user",
        text: entry.summary,
        ts,
        summaryOf: entry.count,
        ...(entry.compactionMs !== undefined ? { compactionMs: entry.compactionMs } : {}),
        ...(entry.archive ? { archive: entry.archive } : {}),
      }));
      continue;
    }

    if (entry.type === "compaction_stopped") {
      // The boundary's stopped sibling: same rule, same count of turns it speaks about, empty
      // body -- there is no summary, because none was ever written, and the turns it names are
      // all still there. `compactionStopped` is what labels it "kept" instead of "summarized".
      out.push(withRun({
        id: entry.id,
        role: "user",
        text: "",
        ts,
        summaryOf: entry.kept,
        compactionStopped: true,
        ...(entry.compactionMs !== undefined ? { compactionMs: entry.compactionMs } : {}),
      }));
      continue;
    }

    if (entry.type === "note") {
      out.push(withRun({ id: entry.id, role: "assistant", text: entry.text, ts }));
      continue;
    }

    if (entry.type === "model_change") {
      const label = [entry.model, entry.effort].filter(Boolean).join(" ");
      out.push(withRun({ id: entry.id, role: "assistant", text: label, ts, command: true }));
    }
  }

  return out;
}
