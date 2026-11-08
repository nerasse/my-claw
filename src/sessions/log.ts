/**
 * The conversation as an append-only log of entries -- docs/session-log.md.
 *
 * One line of JSON per entry, never rewritten. This is the half of a session that only ever
 * grows; the settings live in `meta.json` next to it and are the only thing that mutates.
 *
 * Two properties matter more than anything else here:
 *
 * - An entry is written once. Nothing modifies it, nothing deletes it, so a reader never has to
 *   wonder whether what it holds is still true. Compaction moves a boundary, a retry moves a
 *   cursor; neither destroys what came before.
 * - `parentId` makes the log a tree while `seq` keeps it a file. The tree is what a branch, a
 *   retry and an undo navigate; the file order is what a client syncs against, which is why a
 *   delta cursor keeps working across a branch switch.
 */

import { appendFile, copyFile, mkdir, open, readFile, rename, stat, truncate, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import type { ChatLocation } from "../channels/types.ts";
import type { SessionAttachment, SessionSubAgentAction, SessionSubAgentState, SessionSubAgentStatus } from "./store.ts";
import { repairBranches } from "./branches.ts";
import { ENTRIES_FILE, META_FILE, sessionDir } from "./paths.ts";
import {
  DANGLING_PARENT,
  NO_PARENT,
  RECORD_BYTES,
  SPAWN_CARD_TOOLS,
  SessionIndex,
  appendIndex,
  encodeRecord,
  isCanonicalId,
  openSessionIndex,
  writeIndex,
  type LogRecord,
} from "./log-index.ts";

export const SESSION_LOG_VERSION = 1;

export type EntryType =
  | "user"
  | "phase"
  | "tool"
  | "command"
  | "failure"
  | "compaction"
  | "compaction_stopped"
  | "model_change"
  | "note"
  | "spawn_state"
  | "run_start"
  | "run_end";

/** Assigned by the log, except when a channel reuses the id of a bubble already on screen. */
interface EntryBase {
  id: string;
  seq: number;
  parentId: string | null;
  ts: number;
  /**
   * Shape version of this entry, absent meaning 1. A reader that meets a version it does not know
   * keeps the entry rather than dropping it: the display degrades, the history does not lose a turn.
   */
  v?: number;
  type: EntryType;
  /**
   * Whether this entry belongs in the LLM context, as opposed to being shown and nothing else.
   *
   * The single tableau this log replaces served both, which is where every reconciliation hack in
   * the app came from. A slash command, a failed run and a hand-back note are things the owner
   * must see again and the model must never read.
   */
  prompt: boolean;
}

export interface UserEntry extends EntryBase {
  type: "user";
  prompt: true;
  text: string;
  /**
   * What the model actually read for this turn, when it differs from the owner's words: the
   * per-turn context block and the recalled-memory block are prompt-only. Persisted so the next
   * run reconstructs the same bytes and the prefix cache is not broken at the previous turn.
   */
  promptText?: string;
  attachments?: SessionAttachment[];
  location?: ChatLocation;
  transcripts?: Record<string, string>;
  /** Set when the turn came from another agent (a driven `send`, a hand-back) rather than a human. */
  from?: { sessionId: string; label: string };
}

export interface PhaseEntry extends EntryBase {
  type: "phase";
  prompt: true;
  text: string;
  reasoning?: string;
  /** What the call spent thinking, as the endpoint counted it; on the last phase of the call. */
  reasoningTokens?: number;
  /** How long the thinking that produced `reasoning` lasted. Kept so a reopened thread shows it. */
  reasoningMs?: number;
  /**
   * How long the call took to put its first thing on screen, word of reasoning or word of answer.
   * On the first phase of the call, kept for the same reason as `reasoningMs`: the wait is a fact
   * about the turn, and a thread reopened an hour later cannot re-measure it.
   */
  waitMs?: number;
  /** Phases of one model turn share this, which is what lets the prompt fold them back together. */
  runId: string;
  /** Opaque provider state, replayed verbatim -- docs/reasoning-replay.md. Omitted on a truncated turn. */
  providerMeta?: unknown;
}

export interface ToolEntry extends EntryBase {
  type: "tool";
  prompt: true;
  /** The model's own call id. Also the card id on the device: one identity, not two. */
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** The clipped output. Anything longer lives at `outputPath`. */
  output: string;
  outputPath?: string;
  truncated: boolean;
  ok: boolean;
  /**
   * Images the tool put in front of the model -- a `read` of a PNG, a browser screenshot. The
   * bytes stay on disk and are encoded per prompt build, like a user's own attachment
   * (2026-09-22: agents could not see an image they themselves read).
   */
  attachments?: SessionAttachment[];
  durationMs?: number;
  /**
   * The run ended under this call (a Stop, a crash): the output says so, and a Continue resumes a
   * sub-agent the call was running instead of redoing it -- docs/continue.md.
   */
  interrupted?: true;
  /**
   * Sub-agent state as it stood when a pre-log session was imported, and only then: the shape kept
   * the lifecycle on the assistant turn's tool call, so the migration copies it here rather than
   * losing it. Nothing writes it live -- a sub-agent outlives the call that started it, so its
   * state cannot be part of an entry written once, at settle. `spawn_state` entries carry it now,
   * and `spawnStates` reads both, this one being the floor.
   */
  spawn?: SessionSubAgentState;
  /** The model turn this call belongs to, not the run: one id per API call (`RunRecorder.turnId`). Named before runs had markers. */
  runId: string;
}

export interface CommandEntry extends EntryBase {
  type: "command";
  /**
   * False for what the owner typed (a slash command and its answer). True for a report filed by
   * another part of the system that the conversation's agent must be able to read, such as a cron
   * delivery: the model sees it as a context turn (`messagesOf`), never as something to answer.
   */
  prompt: boolean;
  input: string;
  output: string;
  details?: string;
  /** The app's chat.send id, used to replay both command bubbles under their live ids. */
  sourceId?: string;
  /**
   * Quiet commands (undo, retry, branches) never show their input line: the entry replays as
   * the result bubble only, live and on every refresh. `display.ts` renders this, nothing else.
   */
  quiet?: boolean;
  /**
   * The entry the command followed when the owner sent it: where its bubbles belong on screen.
   *
   * A command is journalled when it *answers* -- `/compact` waits for the run in flight and only
   * replies afterwards -- so its own place in the file is the end of everything it caused: after
   * the run, after the boundary it wrote, after the messages queued behind it. Read as-is, the
   * command landed *under* its own effect, and under messages typed after it. `afterId` is the
   * leaf the branch had at the instant the send was admitted, and `display.ts` puts the bubbles
   * back there. Absent for entries written before this existed, and for a report filed by the
   * system rather than typed.
   */
  afterId?: string;
  /**
   * When the owner sent it, ms. The bubbles read this rather than the journal's write time, so a
   * command that took minutes carries the instant of the send, not of its answer.
   */
  anchorTs?: number;
}

export interface FailureEntry extends EntryBase {
  type: "failure";
  prompt: false;
  error: string;
}

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  prompt: true;
  summary: string;
  /**
   * First entry the summary does *not* cover. The prompt resumes there; everything between the
   * start of the branch and this id is what the summary stands for, and is still on disk. The
   * boundary's own id when nothing before it is kept: the prompt then resumes after it.
   */
  firstKeptEntryId: string;
  tokensBefore: number;
  count: number;
  /**
   * The owner's most recent messages, kept verbatim and replayed before the summary, oldest first,
   * the oldest one cut to fit. Codex's own shape: the summary carries the state, these carry his
   * words (docs/compaction.md). Absent on a boundary written before them.
   */
  retained?: string[];
  /**
   * What finished between the previous boundary and this one, in the detail the summary no longer
   * carries. Written once, never replayed to the model; indexed for `conversation_search`. Present,
   * possibly empty, on every boundary written since the archive exists, which is how the next pass
   * tells a summary that still holds the whole history from one that holds only the open work.
   */
  archive?: string;
  /**
   * How long the summary took to write, so a replayed boundary shows it the way a replayed
   * thinking phase shows its own span -- docs/reasoning-visibility.md. Absent on a boundary
   * written before this was measured, and drawn as nothing rather than as a zero.
   */
  compactionMs?: number;
}

/**
 * A compaction that was stopped, and what it left untouched -- docs/stop.md.
 *
 * A boundary is only written when the summary lands, so an aborted pass used to leave nothing at
 * all: the work spent on it left no mark and a thread reopened elsewhere had no way to know an
 * operation had been interrupted. This is the boundary's stopped sibling, appended on the branch
 * where the pass stopped.
 *
 * `kept` counts the entries the plan was about to cover, all of which are still there: nothing
 * was folded, so the rule speaks about the same entries a boundary would have stood for. The
 * type is deliberately distinct and `prompt` is false -- the projection finds its floor by
 * reading `entry.type === "compaction"`, so an entry of its own type cannot be mistaken for a
 * ceiling and can never move the prompt.
 */
export interface CompactionStoppedEntry extends EntryBase {
  type: "compaction_stopped";
  prompt: false;
  kept: number;
  /** How long the pass ran before the stop. Absent when the caller did not measure it. */
  compactionMs?: number;
}

export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  prompt: false;
  model?: string;
  effort?: string;
}

export interface NoteEntry extends EntryBase {
  type: "note";
  prompt: false;
  text: string;
  from?: { sessionId: string; label: string };
}

/**
 * One step of a sub-agent's life, on the card of the call that started it -- docs/session-log.md §5.
 *
 * The only entry that describes another entry, and the reason it has to exist: a `spawn` tool
 * returns as soon as the child is launched, so the tool entry is written while the child is still
 * running and every later state -- complete, error, killed -- happens after the one write it would
 * have fitted in. Nothing here rewrites that entry. The state is appended as it happens and folded
 * back onto `callId` at read time, which is the same trade the whole format makes: an immutable
 * log, a view that is computed.
 *
 * Never in a prompt. A model reads the child's result in the tool output; this is the spinner.
 */
export interface SpawnStateEntry extends EntryBase {
  type: "spawn_state";
  prompt: false;
  /** The card this annotates: the model's own id for the `spawn` or `send` call that opened it. */
  callId: string;
  subagentId: string;
  status: SessionSubAgentStatus;
  /** Identity, carried by the opening entry only -- a terminal event knows the child, not its name. */
  displayName?: string;
  agentType?: string;
  mode?: string;
  action?: SessionSubAgentAction;
  /**
   * What the child was asked to do, carried by the opening entry.
   *
   * The `spawn` tool entry holds it too, but that entry is written when the whole batch settles:
   * a child that finishes early has a state and no entry for minutes, and the card a fresh page
   * draws from the state alone would show no task at all.
   */
  task?: string;
  resultLength?: number;
  error?: string;
}

/**
 * A run opened. Written once, right after the trigger turn -- docs/run-grouping.md.
 *
 * Everything written between this entry and the matching `run_end` is one run's work, which is
 * what lets the app fold the tool cards, thinking phases and intermediate traffic of a finished
 * run under one collapsed header while it answers. Never part of a prompt: the model reads the
 * work, not the bookkeeping.
 */
export interface RunStartEntry extends EntryBase {
  type: "run_start";
  prompt: false;
  /**
   * The run's id as the wire announces it (`chat.run.start` / `chat.run.end`, the run context's
   * correlation id), so a live item and its persisted entry name the same run and the app never
   * has to rename one to the other. Absent on markers written before 0.6.3: those runs are named
   * after the marker's own entry id, as they always were.
   */
  runId?: string;
}

/** A run closed, and why. `done` is a normal ending, `error` a failed one, `aborted` a Stop. */
export interface RunEndEntry extends EntryBase {
  type: "run_end";
  prompt: false;
  reason: "done" | "aborted" | "error";
  /**
   * Why an `error` run failed, in the same vocabulary the caller is told (`classifyProviderFailure`).
   *
   * Written because the marker alone answered "it broke" and nothing else: a roster deciding
   * between "wait for the plan to reopen" and "this needs a decision" had to open the log's prose,
   * or guess -- and a `blocked` state derived from a guess is worse than no state at all.
   */
  failure?: string;
  /**
   * What the run's tools produced, as the paths they were written to.
   *
   * A tool attaches its files to the answer and the prose never names them, so this marker is the
   * only entry that can carry them to a reopened thread -- the phase was already on disk when the
   * tool ran. Resolved by filename, exactly like a `MEDIA:` ref (2026-09-14).
   */
  media?: string[];
  /**
   * The store id of each `media` entry, same order, when the bytes were stored before the marker
   * was written. A device fetches by id, so an id here needs no directory listing at all -- and
   * it is found from any thread of the owner, which a filename match in one thread directory
   * cannot do (2026-09-15).
   *
   * A null hole means "no copy found": that entry still resolves by filename, or not at all.
   * Read in parallel with `media`, never instead of it: a server on `prev` still knows only the
   * paths, and the rollback has to keep working.
   */
  mediaIds?: Array<string | null>;
}

export type Entry =
  | UserEntry
  | PhaseEntry
  | ToolEntry
  | CommandEntry
  | FailureEntry
  | CompactionEntry
  | CompactionStoppedEntry
  | ModelChangeEntry
  | NoteEntry
  | SpawnStateEntry
  | RunStartEntry
  | RunEndEntry;

/**
 * What a caller hands to `append`: the payload, without anything the log itself decides.
 *
 * Distributive on purpose. A bare `Omit` over a union keeps only the properties every member
 * shares, so `append({ type: "failure", error })` stopped compiling; the conditional applies the
 * Omit to each member and keeps the union. Same shape as pi's `ProvisionedEntry`.
 */
export type Provisioned<T extends Entry = Entry> = T extends Entry
  ? Omit<T, "id" | "seq" | "parentId" | "ts">
  : never;

/**
 * A cursor the log cannot place. Thrown rather than answered with a silent full page: the client
 * has to know its delta was refused, or two windows drift apart with nobody noticing.
 */
export class UnknownCursorError extends Error {
  readonly cursor: string;
  constructor(cursor: string) {
    super(`Entry not found: ${cursor}`);
    this.name = "UnknownCursorError";
    this.cursor = cursor;
  }
}

export { ENTRIES_FILE, META_FILE, sessionDir } from "./paths.ts";

/**
 * Whether a directory holding these names *is* a session, rather than a directory that merely
 * contains sessions. Two walks depend on this (`migrate.ts`, `store.ts`), so it is one function.
 *
 * Either half is enough, and the reason is an empty conversation: it has settings and no log, so a
 * test on `entries.jsonl` alone read it as "not a session", descended into it and offered
 * `<id>/meta` as a conversation of its own. Loading that hands back the parsed `meta.json`, which
 * has no `messages` -- the crash loop measured on 0.4.55.
 */
export async function holdsSession(dir: string, names: readonly string[]): Promise<boolean> {
  if (names.includes(ENTRIES_FILE)) return true;
  if (!names.includes(META_FILE)) return false;
  // The settings have to count on their own, for a directory written before the log was created
  // with it. But `<owner>/meta.json` is a *session* file that merely happens to be named
  // `meta.json` -- what writing in the ghost conversation of 0.4.53 persisted -- and it sits among
  // that owner's conversations. Only settings carry `storageVersion`, and reading an owner's
  // directory as a session would hide every conversation inside it.
  try {
    const parsed = JSON.parse(await readFile(join(dir, META_FILE), "utf-8")) as { storageVersion?: unknown };
    return typeof parsed.storageVersion === "number";
  } catch {
    return false;
  }
}

export function entriesPath(sessionId: string): string {
  return join(sessionDir(sessionId), ENTRIES_FILE);
}

/**
 * UUIDv7: 48 bits of millisecond timestamp, then randomness. Ids sort by creation time, so the
 * file order and the id order agree and a reader can bound a scan by time without an index.
 */
export function newEntryId(now = Date.now()): string {
  const random = randomUUID().replace(/-/g, "");
  const time = now.toString(16).padStart(12, "0");
  const rest = random.slice(12);
  // Version 7 in the high nibble of the 7th byte, variant 0b10 in the high bits of the 9th.
  const version = `7${rest.slice(1, 4)}`;
  const variant = ((parseInt(rest.slice(4, 5), 16) & 0x3) | 0x8).toString(16) + rest.slice(5, 8);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-${version}-${variant}-${rest.slice(8, 20)}`;
}

const ENTRY_START = '{"type":"';

/**
 * The entry glued behind a stump, when an unreadable line holds one.
 *
 * A short write leaves an entry that stops mid-token and with no newline, and the append after it
 * lands on the same line: `[stump][whole entry]`. The stump is lost either way -- nobody finished
 * writing it -- but the entry behind it is intact, and it is the link the rest of the branch hangs
 * from, so dropping the whole line costs every ancestor of the leaf rather than one entry.
 *
 * Candidates are tried from the last object start backwards, so what comes back is the shortest
 * suffix of the line that parses whole: an earlier start would have to swallow bytes that were
 * never finished. A failed attempt is cheap -- `JSON.parse` stops at the first bad token, it does
 * not read to the end -- so a line carrying JSON inside a tool output costs a scan, not a square.
 */
function gluedEntry(line: string): { entry: Entry; stumpBytes: number } | null {
  const starts: number[] = [];
  for (let at = line.indexOf(ENTRY_START, 1); at >= 0; at = line.indexOf(ENTRY_START, at + 1)) starts.push(at);
  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i]!;
    try {
      const parsed = JSON.parse(line.slice(start)) as Entry;
      if (typeof parsed?.id === "string" && typeof parsed?.type === "string") return { entry: parsed, stumpBytes: start };
    } catch {
      // Not a boundary. An earlier start may still be one.
    }
  }
  return null;
}

/**
 * Reads one line, or nothing.
 *
 * A truncated last line is what a process killed mid-append leaves behind, and it must cost that
 * line alone. The whole point of the format is that damage is bounded to a line instead of taking
 * the conversation with it, the way a half-written 12 MB JSON object did.
 *
 * Bounded to the line is true of the file and false of the tree, which is what the disk filling up
 * on 2026-09-12 measured: `pathOf` walks parents from the leaf, so one lost link hid twenty hours
 * of conversation that were still on disk. Hence the recovery -- docs/session-log.md, annexe E.
 */
export function parseEntryLine(line: string, sessionId: string, lineNumber: number): Entry | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as Entry;
    if (typeof parsed?.id !== "string" || typeof parsed?.type !== "string") {
      void log("warn", "session log: entry without an id or a type, skipped", { sessionId, lineNumber });
      return null;
    }
    return parsed;
  } catch {
    const glued = gluedEntry(line);
    if (glued) {
      void log("warn", "session log: entry recovered from behind a stump, the stump is dropped", {
        sessionId,
        lineNumber,
        stumpBytes: glued.stumpBytes,
        id: glued.entry.id,
      });
      return glued.entry;
    }
    void log("warn", "session log: unreadable line, skipped", { sessionId, lineNumber, bytes: line.length });
    return null;
  }
}

/**
 * Walks the branch that ends at `leafId`, oldest first.
 *
 * The tree is only ever traversed upwards, from a leaf to the root, because that is the direction
 * `parentId` points and it is the one walk that cannot be ambiguous: a node has one parent and any
 * number of children. A leaf the log does not hold falls back to the last entry written, which is
 * what an app asking about a branch that was never created should see.
 */
export function pathOf(entries: readonly Entry[], leafId: string | null): Entry[] {
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = byId.get(leafId);
  if (!current) {
    const last = entries[entries.length - 1];
    if (!last) return [];
    void log("warn", "session log: unknown leaf, falling back to the last entry", { leafId });
    current = last;
  }
  const path: Entry[] = [];
  // A cycle cannot happen through `append` (a parent is always already written) but a hand-edited
  // or half-migrated file is not worth an infinite loop.
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

/** Entries with no child: one per branch, which is what a branch picker lists. */
export function leavesOf(entries: readonly Entry[]): Entry[] {
  const parents = new Set<string>();
  for (const entry of entries) if (entry.parentId) parents.add(entry.parentId);
  // The run markers are bookkeeping, not conversation points: a trailing `run_end` is a childless
  // entry by construction (the next turn is what would chain under it), and listing it as a
  // branch would offer an empty row in the picker.
  return entries.filter((entry) => !parents.has(entry.id) && entry.type !== "run_start" && entry.type !== "run_end");
}

/**
 * Whether the log is at a point where a new line can start.
 *
 * `appendFile` opens in append mode, so a write that stopped short -- the disk filled on
 * 2026-09-12, twice, `ENOSPC: no space left on device` -- leaves a stump with no newline and the
 * next entry lands glued behind it, unreadable with it. One byte read at the end of the file is
 * what keeps the two apart, inside the write chain that was already asynchronous.
 */
async function endsOnNewline(file: string): Promise<boolean> {
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      if (size === 0) return true;
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, size - 1);
      return tail[0] === 0x0a;
    } finally {
      await handle.close();
    }
  } catch {
    // No file yet, or one this process cannot read: an entry written at offset 0 needs nothing in
    // front of it, and a real disk problem surfaces on the append that follows, loudly.
    return true;
  }
}

/**
 * One session's log: the index of every entry, and the file behind it.
 *
 * Opening no longer reads the conversation. It reads `entries.idx` -- 56 bytes per entry, 2.6 MB
 * for a 127 MB session -- and everything on the open path (the branch, a page, the run a page
 * belongs to) is answered from it plus a handful of byte ranges. The whole log is still one call
 * away (`all()`), and that is what every consumer that genuinely needs every entry asks for.
 *
 * The two must not be confused. `all()` reads and parses the entire file and holds it: on the
 * measured session that is 1.1 s and 600 MB. `entries()` throws instead of doing it silently, so a
 * path that was meant to be bounded cannot regress into one that is not -- the error names the call
 * to use, and the fix is one word.
 *
 * The instance owns its `seq` and its leaf, so an append never re-reads anything, and an append
 * writes the line and its record in the same queued step.
 */
export class SessionLog {
  readonly sessionId: string;
  private readonly file: string;
  /** Every entry's position, in file order. The only thing `openSessionLog` reads. */
  private index: SessionIndex;
  private nextSeq: number | null;
  private leafId: string | null;
  /** Position of the leaf in `index`, -1 when the branch is empty. */
  private leafPosition: number;
  /** Bytes of the log once the queued writes land: where the next line starts. */
  private bytes: number;
  /** Serializes appends: two awaited writes must not interleave inside one line. */
  private tail: Promise<void> = Promise.resolve();
  /** Prompt count and last owner turn, off the index, once. */
  private facts: { prompts: number; lastUser: number | null } | null = null;
  private firstUser: string | null;
  /** The whole log, once something asked for it. Null is the normal state of an open session. */
  private list: Entry[] | null = null;
  private materializing: Promise<readonly Entry[]> | null = null;
  /** Entries this process appended: kept by identity, so an id has one object until it is reread. */
  private appended = new Map<string, Entry>();
  /** id -> position, built the first time something asks the log about an id. */
  private positions: Map<string, number> | null = null;
  /**
   * What `context()` handed out, and the entry count it covered: a run holds one array for its whole
   * duration, so an append that extends the branch must land in it -- the turn the run just wrote is
   * exactly what its next prompt has to carry.
   */
  private contextCache: Entry[] | null = null;
  private contextCovers = -1;
  /** Spawn states and spawn cards, cached -- see `spawnRecords`. */
  private spawns: { states: LogRecord[]; cards: LogRecord[] } | null = null;
  private spawnsCover = -1;
  /**
   * Told after every append, leaf moved. The manager hangs the session's dirty flag on it, so the
   * autosave carries the new leaf to `meta.json` within its tick. Without it the flag moved only
   * with a model call's usage, and a leaf that advanced between two calls (a tool settling, the
   * `run_end` marker) waited for the run's own persist: a process killed there reopened the log
   * on the leaf before them, and the entries past it were a dead branch.
   */
  onAppend: (() => void) | undefined;
  /** What materializing had to put back on the branch, if anything -- `branches.ts`. */
  repaired: { relinked: number; reparented: number; adoptedTail: boolean } | null = null;
  /** Told once a repair ran, so the manager can remember that this log was checked. */
  onRepaired: (() => void) | undefined;
  /**
   * Whether `branches.ts` has already looked at this log. Kept in `meta.json`, because a deliberate
   * rewind leaves a fork forever and a fork alone does not say whether the shape is damage.
   */
  private branchesChecked: boolean;

  constructor(
    sessionId: string,
    index: SessionIndex,
    leafId: string | null,
    bytes: number,
    firstUser: string | null,
    repaired: { relinked: number; reparented: number; adoptedTail: boolean } | null = null,
    branchesChecked = false,
  ) {
    this.sessionId = sessionId;
    this.file = entriesPath(sessionId);
    this.index = index;
    this.bytes = bytes;
    this.firstUser = firstUser;
    this.repaired = repaired;
    this.branchesChecked = branchesChecked;
    this.positions = null;
    const known = leafId !== null && index.count > 0 ? this.positionOf(leafId) : undefined;
    if (known !== undefined) {
      this.leafId = leafId;
      this.leafPosition = known;
    } else {
      // A meta naming a leaf this log does not hold describes nothing here: the newest entry is
      // what a reader is owed, and `branches.ts` is what will make the two agree again.
      this.leafId = index.last?.id ?? null;
      this.leafPosition = index.count - 1;
    }
    this.nextSeq = null;
  }

  /** Entries the log holds, without reading any of them. */
  count(): number {
    return this.index.count;
  }

  recordAt(position: number): LogRecord {
    return this.index.recordAt(position);
  }

  /** The record of an entry, by id. Builds the id map on first use: 46k ids in ~20 ms. */
  recordOf(id: string): LogRecord | undefined {
    const position = this.positionOf(id);
    return position === undefined ? undefined : this.index.recordAt(position);
  }

  private positionOf(id: string): number | undefined {
    this.positions ??= this.index.idPositions();
    return this.positions.get(id);
  }

  /** The newest record written, whatever branch it is on: the cursor a client syncs against. */
  headRecord(): LogRecord | undefined {
    return this.index.last;
  }

  head(): string | null {
    return this.index.last?.id ?? null;
  }

  leaf(): string | null {
    return this.leafId;
  }

  /** The branch that ends at `leafId` (the log's own leaf by default), oldest first. */
  pathRecords(leafId?: string | null): LogRecord[] {
    const wanted = leafId === undefined ? this.leafPosition : leafId === null ? -1 : this.positionOf(leafId) ?? this.leafPosition;
    const path: LogRecord[] = [];
    let position = wanted;
    // A parent is always written before its child, so this cannot cycle; the bound is here for a
    // record file somebody edited by hand.
    for (let guard = 0; position >= 0 && position < this.index.count && guard <= this.index.count; guard++) {
      const record = this.index.recordAt(position);
      path.push(record);
      position = record.parent === NO_PARENT || record.parent === DANGLING_PARENT ? -1 : record.parent;
    }
    path.reverse();
    return path;
  }

  /** Every record after `cursor`, in file order -- what a client that already holds it lacks. */
  recordsSince(cursor: string | null): LogRecord[] {
    if (cursor === null) return Array.from({ length: this.index.count }, (_unused, i) => this.index.recordAt(i));
    const from = this.positionOf(cursor);
    if (from === undefined) throw new UnknownCursorError(cursor);
    const out: LogRecord[] = [];
    for (let i = from + 1; i < this.index.count; i++) out.push(this.index.recordAt(i));
    return out;
  }

  /** The entries of these records, read in one pass over the file. Unreadable lines are skipped. */
  async entriesIn(records: readonly LogRecord[]): Promise<Entry[]> {
    if (records.length === 0) return [];
    // Queued appends may not have landed yet: a page asked for right after a write must see it.
    await this.tail;
    const out: Entry[] = [];
    const handle = await open(this.file, "r");
    try {
      // A page is one contiguous stretch of the file, so the reads are batched: one syscall per
      // run of adjacent lines, then a slice per entry. Measured on a 400-entry page, this is the
      // difference between 400 positional reads (~90 ms) and one (~10 ms).
      for (let i = 0; i < records.length; ) {
        const first = records[i]!;
        let end = i;
        let span = first.length;
        while (end + 1 < records.length && records[end + 1]!.offset === records[end]!.offset + records[end]!.length + 1) {
          end += 1;
          span = records[end]!.offset + records[end]!.length - first.offset;
        }
        const buf = Buffer.allocUnsafe(Math.max(span, 1));
        const { bytesRead } = await handle.read(buf, 0, span, first.offset);
        for (let k = i; k <= end; k++) {
          const record = records[k]!;
          const at = record.offset - first.offset;
          if (at + record.length > bytesRead) continue;
          const parsed = parseEntryLine(buf.subarray(at, at + record.length).toString("utf-8"), this.sessionId, record.index + 1);
          if (parsed) out.push(this.appended.get(parsed.id) ?? parsed);
        }
        i = end + 1;
      }
    } finally {
      await handle.close();
    }
    return out;
  }

  /** One entry, by record. */
  async entryOf(record: LogRecord): Promise<Entry | undefined> {
    const [entry] = await this.entriesIn([record]);
    return entry;
  }

  /** One entry, by id. A single read: the index says where it sits. */
  async entryById(id: string): Promise<Entry | undefined> {
    const record = this.recordOf(id);
    return record ? this.entryOf(record) : undefined;
  }

  /**
   * The whole log, in file order.
   *
   * Reads the file, parses every line, repairs the branch shape if it needs it, and keeps the
   * result. Everything a conversation weighs is paid here, once: the display path never calls it,
   * and a run only does when its own floor is not enough (a branch with no compaction boundary).
   */
  async all(): Promise<readonly Entry[]> {
    if (this.list) return this.list;
    if (this.materializing) return this.materializing;
    this.materializing = this.materialize();
    try {
      return await this.materializing;
    } finally {
      this.materializing = null;
    }
  }

  private async materialize(): Promise<readonly Entry[]> {
    await this.tail;
    let raw = "";
    try {
      raw = await readFile(this.file, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        void log("warn", "session log: unreadable file, reading as empty", { sessionId: this.sessionId, error: String(err) });
      }
      this.list = [];
      return this.list;
    }

    const entries: Entry[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const entry = parseEntryLine(lines[i]!, this.sessionId, i + 1);
      if (entry) entries.push(this.appended.get(entry.id) ?? entry);
    }

    // A file that does not end on a newline ends on a line nobody finished writing. Skipping it at
    // read time is not enough: the next append would glue itself to that stump, and the entry that
    // was supposed to repair the damage would be swallowed by it. Cut the stump off the file
    // instead, so the only thing the interrupted write costs is the entry it never finished.
    if (raw.length > 0 && !raw.endsWith("\n")) {
      const keep = raw.lastIndexOf("\n") + 1;
      await truncate(this.file, keep).catch((err) => {
        void log("error", "session log: could not drop an unterminated line", { sessionId: this.sessionId, error: String(err) });
      });
      void log("warn", "session log: dropped an unterminated last line", { sessionId: this.sessionId, bytes: raw.length - keep });
    }

    this.list = entries;
    this.positions = null;
    this.nextSeq = this.list.reduce((max, entry) => Math.max(max, entry.seq), -1) + 1;
    this.bytes = (await stat(this.file).catch(() => ({ size: this.bytes }))).size;
    this.appended.clear();
    return this.list;
  }

  /** Whether `branches.ts` has looked at this log, here or in an earlier process. */
  checkedBranches(): boolean {
    return this.branchesChecked;
  }

  /** Whether this log is shaped like something `branches.ts` has not looked at yet. */
  needsRepair(): boolean {
    return !this.branchesChecked && this.index.count > 0 && this.index.needsRepair();
  }

  /**
   * The meta's leaf is behind the file, and the file past it is one straight line: adopt the tail.
   *
   * This is the shape a process killed mid-run leaves -- the leaf reached the meta at the autosave
   * tick, the entries did not -- and repairing it needs no entry read: if every record past the leaf
   * is the child of the one before it, there is no second branch to tell deliberate from damage.
   * A rewind fails the test at its own command entry, which is a child of the leaf and not of its
   * neighbour, so a branch the owner walked away from is left exactly where it is.
   */
  adoptStraightTail(): boolean {
    const last = this.index.last;
    if (!last || this.leafPosition < 0 || this.leafPosition >= this.index.count - 1) return false;
    for (let i = this.leafPosition + 1; i < this.index.count; i++) {
      if (this.index.recordAt(i).parent !== i - 1) return false;
    }
    this.leafId = last.id;
    this.leafPosition = this.index.count - 1;
    this.repaired = { relinked: 0, reparented: 0, adoptedTail: true };
    return true;
  }

  /**
   * Puts dead branches back on the branch -- `branches.ts`.
   *
   * Not on the display path and not on the run path: it needs every entry, and the shape it repairs
   * is (a) legacy damage from before 0.6.1 and (b) a parent line lost to a full disk. `openSessionLog`
   * runs it when the index says the shape is worth a look and the meta says it has not been looked
   * at, and the boot maintenance pass runs it for every session it has never checked -- so an
   * upgrade heals an install without a reader ever paying for it twice.
   */
  async repair(): Promise<void> {
    if (this.branchesChecked) return;
    const all = await this.all();
    const repair = repairBranches(all, this.leafId);
    this.repaired = repair.relinked.length > 0 || repair.reparented.length > 0 || repair.adoptedTail
      ? { relinked: repair.relinked.length, reparented: repair.reparented.length, adoptedTail: repair.adoptedTail }
      : null;
    const moved = repair.relinked.length > 0 || repair.reparented.length > 0;
    if (moved) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await copyFile(this.file, `${this.file}.bak-branches-${stamp}`);
      await writeFile(`${this.file}.tmp`, repair.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf-8");
      await rename(`${this.file}.tmp`, this.file);
      this.list = repair.entries;
      this.leafId = repair.leafId;
      await this.reindex(repair.entries);
    }
    this.report(repair);
    this.branchesChecked = true;
    if (repair.adoptedTail || repair.relinked.length > 0 || repair.reparented.length > 0) this.onRepaired?.();
    else this.onRepaired?.();
  }

  /** Rewrites the index from entries in hand, after a repair moved parent links. */
  private async reindex(entries: readonly Entry[]): Promise<void> {
    const index = SessionIndex.empty();
    const positions = new Map<string, number>();
    let offset = 0;
    for (const entry of entries) {
      const line = `${JSON.stringify(entry)}\n`;
      const length = Buffer.byteLength(line) - 1;
      const parent = entry.parentId === null ? NO_PARENT : positions.get(entry.parentId) ?? DANGLING_PARENT;
      const record = index.push({
        id: entry.id,
        parent,
        seq: entry.seq,
        ts: entry.ts,
        type: entry.type,
        prompt: entry.prompt,
        spawnCard: entry.type === "tool" && SPAWN_CARD_TOOLS.has(entry.name),
        offset,
        length,
      });
      positions.set(record.id, record.index);
      offset += length + 1;
    }
    this.index = index;
    this.bytes = offset;
    this.positions = null;
    this.facts = null;
    this.contextCache = null;
    this.contextCovers = -1;
    // The leaf of a repaired log is not the last line: the repair moves it to the tip it adopted.
    this.leafPosition = this.leafId === null ? -1 : positions.get(this.leafId) ?? index.count - 1;
    await writeIndex(this.sessionId, index).catch((err) => {
      void log("warn", "session index: could not be rewritten after a repair", { sessionId: this.sessionId, error: String(err) });
    });
  }

  private report(repair: { reparented: string[]; relinked: string[]; adoptedTail: boolean; bugForks: number; deliberateForks: number; leafId: string | null }): void {
    if (repair.reparented.length > 0) {
      void log("warn", "session log: entries whose parent was never written, put behind the line before them", {
        sessionId: this.sessionId,
        reparented: repair.reparented.length,
        ids: repair.reparented.slice(0, 5),
      });
    }
    if (repair.relinked.length > 0 || repair.adoptedTail) {
      void log("warn", "session log: dead branches put back on the branch", {
        sessionId: this.sessionId,
        forks: repair.bugForks,
        deliberateForks: repair.deliberateForks,
        relinked: repair.relinked.length,
        adoptedTail: repair.adoptedTail,
        leafId: repair.leafId,
      });
    }
  }

  /**
   * The whole log, synchronously -- and a throw when it is not in memory.
   *
   * The throw is the feature. Everything this used to answer silently cost a full parse of a file
   * that can be hundreds of megabytes, on paths (an opened conversation, a run's first call) that
   * have no business reading it. A caller that needs every entry awaits `all()`.
   */
  entries(): readonly Entry[] {
    if (this.list) return this.list;
    throw new Error(
      `session log ${this.sessionId} is not in memory: await log.all() for every entry, or read the index (pathRecords/entriesIn) for a window`,
    );
  }

  /** Whether the whole log is in memory. For tests and for a caller that must not parse. */
  isMaterialized(): boolean {
    return this.list !== null;
  }

  /** The branch, oldest first, from the whole log. The bounded form is `pathRecords`. */
  async path(): Promise<Entry[]> {
    const all = await this.all();
    return pathOf(all, this.leafId);
  }

  /**
   * What a prompt would carry: the newest compaction boundary on the branch, and every entry the
   * summary does not stand for.
   *
   * This is the run path's whole reason not to read the log. The boundary of the measured session
   * sat 360 KB from the end of a 127 MB file: a run read 0.3 % of it and paid 1.1 s and 600 MB for
   * the rest. A branch with no boundary has nothing to bound it, and falls back to the whole log --
   * which is what compaction exists to prevent, and what it still cost before this.
   */
  async context(): Promise<Entry[]> {
    // A second handle on the same session (the sub-agent runner holding one while a run opens its
    // own) writes lines this index has not seen. The file is the authority: one stat says whether
    // what is in hand still describes it.
    await this.refreshFromDisk();
    if (this.contextCache && this.contextCovers === this.index.count) return this.contextCache;
    const path = this.pathRecords();
    let boundary = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i]!.type === "compaction") {
        boundary = i;
        break;
      }
    }
    if (boundary < 0) {
      const whole = await this.all();
      this.contextCache = whole === this.list ? (this.list as Entry[]) : [...whole];
      this.contextCovers = this.index.count;
      return this.contextCache;
    }
    const compaction = await this.entryOf(path[boundary]!);
    let start = boundary;
    if (compaction?.type === "compaction") {
      // An imported boundary can sit *after* the turns it keeps; the union of both is the floor.
      const keptAt = path.findIndex((record) => record.id === compaction.firstKeptEntryId);
      if (keptAt >= 0) start = Math.min(start, keptAt);
    }
    const entries = await this.entriesIn(path.slice(start));
    this.contextCache = entries;
    this.contextCovers = this.index.count;
    return entries;
  }

  /**
   * Brings the index up to date with the file, when something else wrote to it.
   *
   * The process holds one log per session, so this is normally a stat that finds the size it
   * expected. It exists because "normally" is not "always": a test drives a runner and a bridge on
   * two handles, and a handle that kept serving a stale index would answer a prompt without the
   * turn that was just written.
   */
  private async refreshFromDisk(): Promise<void> {
    const size = await stat(this.file).then((info) => info.size, () => this.bytes);
    // Only growth is somebody else's write: a file that shrank or vanished was deleted under us, and
    // a handle that adopted the empty shape would answer with a conversation that no longer exists.
    if (size <= this.bytes) return;
    const { index } = await openSessionIndex(this.sessionId);
    this.index = index;
    this.bytes = size;
    this.positions = null;
    this.facts = null;
    this.contextCache = null;
    this.contextCovers = -1;
    // The whole log in hand is just as stale as the index it was parsed against.
    this.list = null;
    this.appended.clear();
    this.leafPosition = this.leafId === null ? -1 : this.positionOf(this.leafId) ?? index.count - 1;
    this.leafId = this.leafPosition >= 0 ? this.index.recordAt(this.leafPosition).id : null;
    this.adoptStraightTail();
    void log("warn", "session log: a second handle wrote to this conversation", { sessionId: this.sessionId, seen: size });
  }

  /**
   * The records a card needs: the spawn states, and the spawn cards they revise.
   *
   * Scanned once, from the cheap type and flag bytes, and extended as entries are appended: a page
   * asked for twice in a row must not walk the index twice, and a conversation of a million
   * entries holds a few dozen of these.
   */
  spawnRecords(): { states: LogRecord[]; cards: LogRecord[] } {
    if (this.spawns && this.spawnsCover === this.index.count) return this.spawns;
    const states: LogRecord[] = [];
    const cards: LogRecord[] = [];
    for (let i = 0; i < this.index.count; i++) {
      const type = this.index.typeOf(i);
      if (type === "spawn_state") states.push(this.index.recordAt(i));
      else if (this.index.spawnCardOf(i)) cards.push(this.index.recordAt(i));
    }
    this.spawns = { states, cards };
    this.spawnsCover = this.index.count;
    return this.spawns;
  }

  private noteSpawnRecord(record: LogRecord): void {
    if (!this.spawns) return;
    if (record.type === "spawn_state") this.spawns.states.push(record);
    else if (record.spawnCard) this.spawns.cards.push(record);
    this.spawnsCover = this.index.count;
  }

  /** The context a run already holds, for a caller that must not await. Null when nothing is held. */
  heldContext(): readonly Entry[] | null {
    return this.contextCache && this.contextCovers === this.index.count ? this.contextCache : null;
  }

  /** Entries a prompt would carry: the message count a conversation list shows. */
  promptCount(): number {
    return this.counts().prompts;
  }

  /** Raw text of the first thing the owner said, which is what an untitled conversation is named after. */
  firstUserText(): string | null {
    return this.firstUser;
  }

  /** `openSessionLog` fills this from the one line the index points at. */
  rememberFirstUser(text: string | null): void {
    this.firstUser = text;
  }

  /** When the last message was sent into this conversation, whatever branch it is on: what a conversation list sorts on. */
  lastUserAt(): number | null {
    return this.counts().lastUser;
  }

  private counts(): { prompts: number; lastUser: number | null } {
    if (this.facts) return this.facts;
    let prompts = 0;
    let lastUser: number | null = null;
    for (let i = 0; i < this.index.count; i++) {
      if (this.index.promptOf(i)) prompts += 1;
      if (this.index.typeOf(i) !== "user") continue;
      const ts = this.index.tsOf(i);
      if (ts > (lastUser ?? -Infinity)) lastUser = ts;
    }
    this.facts = { prompts, lastUser };
    return this.facts;
  }

  /** Whether the log already holds an entry under this id. */
  has(entryId: string): boolean {
    return this.positionOf(entryId) !== undefined;
  }

  /**
   * Appends an entry under the current leaf and makes it the new leaf.
   *
   * The write is fire-and-forget on purpose: the caller gets the entry back synchronously, with its
   * id, so the live bubble and the stored entry are the same identity from the first frame. Waiting
   * on the disk here would put a file write on the path of every token.
   */
  append<T extends Entry>(input: Provisioned<T>, id?: string): T {
    const now = Date.now();
    // A caller-provided id is one already on screen: the channel minted it when it opened the
    // bubble this entry holds the text of, so the two are one identity -- docs/bubble-identity.md.
    // Reusing one would make the tree ambiguous and let a retried send attach to an older turn.
    if (id !== undefined && this.has(id)) throw new Error(`Entry id already exists: ${id}`);
    const entry = {
      ...input,
      id: id ?? newEntryId(now),
      seq: this.seq(),
      parentId: this.leafId,
      ts: now,
      // The generic is the caller's promise about which member it is building; the omitted four
      // fields are put back right here, so the assertion restores exactly what Provisioned removed.
    } as unknown as T;
    this.record(entry);
    this.materializedPush(entry);
    return entry;
  }

  /** The next `seq`. Read off the index rather than a counter, so an open costs no entry read. */
  private seq(): number {
    if (this.nextSeq === null) {
      let max = -1;
      for (let i = 0; i < this.index.count; i++) {
        const seq = this.index.recordAt(i).seq;
        if (seq > max) max = seq;
      }
      this.nextSeq = max + 1;
    }
    return this.nextSeq++;
  }

  /** Writes the record and the line for an entry appended now, and moves the leaf to it. */
  private record(entry: Entry): void {
    const line = `${JSON.stringify(entry)}\n`;
    const length = Buffer.byteLength(line) - 1;
    const offset = this.bytes;
    const record = this.index.push({
      id: entry.id,
      parent: this.leafPosition >= 0 ? this.leafPosition : NO_PARENT,
      seq: entry.seq,
      ts: entry.ts,
      type: entry.type,
      prompt: entry.prompt,
      spawnCard: entry.type === "tool" && SPAWN_CARD_TOOLS.has(entry.name),
      offset,
      length,
    });
    this.positions?.set(entry.id, record.index);
    this.appended.set(entry.id, entry);
    this.leafId = entry.id;
    this.leafPosition = record.index;
    this.bytes += length + 1;
    if (entry.prompt && this.facts) this.facts.prompts += 1;
    if (entry.type === "user") {
      if (this.firstUser === null) this.firstUser = entry.text;
      if (this.facts) this.facts.lastUser = Math.max(this.facts.lastUser ?? -Infinity, entry.ts);
    }
    this.noteSpawnRecord(record);
    this.extendContext(entry);
    const bytes = this.index.toBuffer().subarray(record.index * RECORD_BYTES, (record.index + 1) * RECORD_BYTES);
    this.write(line, Buffer.from(bytes), 1, isCanonicalId(entry.id) ? [] : [[record.index, entry.id]]);
    this.onAppend?.();
  }

  private materializedPush(entry: Entry): void {
    // A log with no compaction boundary hands out its own list as the context: one array, one push.
    if (this.list && this.list !== this.contextCache) this.list.push(entry);
  }

  /** Keeps a context a run is already holding in step with what it just appended. */
  private extendContext(entry: Entry): void {
    if (!this.contextCache) return;
    const last = this.contextCache[this.contextCache.length - 1];
    if (last ? entry.parentId === last.id : entry.parentId === null) {
      this.contextCache.push(entry);
      this.contextCovers = this.index.count;
      return;
    }
    // Appended somewhere this context does not cover: it is no longer the branch in memory.
    this.contextCache = null;
    this.contextCovers = -1;
  }

  /** Queues one write behind the last. Never rejects: see the comment inside for why. */
  private write(line: string, record: Buffer, count = 1, sideIds: ReadonlyArray<readonly [number, string]> = []): void {
    this.tail = this.tail
      .catch(() => {})
      .then(async () => {
        const separator = (await endsOnNewline(this.file)) ? "" : "\n";
        if (separator !== "") {
          // The file lost its newline under us: every offset past this point in the index is wrong
          // by one, so nothing here may be trusted. The write goes in, and the index is rebuilt
          // from the file the next time it is opened.
          void log("warn", "session log: appending behind an unterminated line", { sessionId: this.sessionId });
        }
        await appendFile(this.file, `${separator}${line}`, "utf-8");
        await appendIndex(this.sessionId, record, sideIds).catch(async (err) => {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            await writeIndex(this.sessionId, this.index).catch(() => {});
            return;
          }
          void log("error", "session index: append failed", { sessionId: this.sessionId, count, error: String(err) });
        });
      })
      .catch((err) => {
        // Deliberately not rethrown, and deliberately not recreating the directory: a write that
        // fails with ENOENT means the conversation was deleted under the run, and resurrecting it
        // one entry at a time is worse than losing the entry. Anything else is a disk problem the
        // next append will meet again, loudly.
        void log("error", "session log: append failed", { sessionId: this.sessionId, count, error: String(err) });
      });
  }

  /**
   * Appends a whole chain at once, and hands it back before a byte is written.
   *
   * The point is the gap between the two: an entry that has to name another entry cannot be
   * written until that id exists, and `append` serialises its line immediately, so patching one
   * afterwards would either be lost or force a rewrite -- and no entry is ever rewritten. Here the
   * ids and the chain are assigned first, `patch` gets to resolve the cross-references, and only
   * then does anything reach the disk. A compaction boundary importing an old session is the case
   * that needs it: it sits before the entries it keeps, so the id it must carry does not exist yet
   * when its turn comes.
   *
   * An input may carry its own `ts`, which is the other thing an import needs: a conversation from
   * last month must keep last month's dates, and an id sorts by the time it encodes, so the id is
   * built from that timestamp too rather than from the clock of the migration.
   */
  appendAll(
    inputs: ReadonlyArray<Provisioned & { id?: string; ts?: number }>,
    patch?: (entries: Entry[]) => void,
  ): Entry[] {
    const now = Date.now();
    const entries: Entry[] = [];
    const parentId = this.leafId;
    let parentPosition = this.leafPosition;
    let seq = this.seq();
    for (const input of inputs) {
      const ts = input.ts ?? now;
      const id = input.id ?? newEntryId(ts);
      if (this.has(id)) throw new Error(`Entry id already exists: ${id}`);
      const entry = { ...input, id, seq: seq++, parentId: null as string | null, ts } as unknown as Entry;
      entry.parentId = entries.length === 0 ? parentId : entries[entries.length - 1]!.id;
      entries.push(entry);
    }
    patch?.(entries);
    // The base of this batch is the anchor for the first record; the rest chain among themselves.
    this.leafPosition = parentPosition;
    this.leafId = parentId;
    let batch = "";
    const sideIds: Array<readonly [number, string]> = [];
    const records = Buffer.alloc(RECORD_BYTES * entries.length);
    let at = 0;
    let offset = this.bytes;
    for (const entry of entries) {
      const line = `${JSON.stringify(entry)}\n`;
      const length = Buffer.byteLength(line) - 1;
      const record = this.index.push({
        id: entry.id,
        parent: this.leafPosition >= 0 ? this.leafPosition : NO_PARENT,
        seq: entry.seq,
        ts: entry.ts,
        type: entry.type,
        prompt: entry.prompt,
        spawnCard: entry.type === "tool" && SPAWN_CARD_TOOLS.has(entry.name),
        offset,
        length,
      });
      encodeRecord(record, records, at);
      if (!isCanonicalId(entry.id)) sideIds.push([record.index, entry.id]);
      at += RECORD_BYTES;
      this.positions?.set(entry.id, record.index);
      this.appended.set(entry.id, entry);
      this.noteSpawnRecord(record);
      this.leafId = entry.id;
      this.leafPosition = record.index;
      batch += line;
      offset += length + 1;
    }
    this.bytes = offset;
    // The batch took as many numbers as it has entries: the counter has to move past them all.
    this.nextSeq = seq;
    for (const entry of entries) {
      if (entry.type === "user" && entry.ts > (this.facts?.lastUser ?? -Infinity)) {
        if (this.facts) this.facts.lastUser = entry.ts;
        if (this.firstUser === null) this.firstUser = entry.text;
      }
      if (entry.prompt && this.facts) this.facts.prompts += 1;
    }
    if (batch.length > 0) this.write(batch, records, entries.length, sideIds);
    if (entries.length > 0) {
      for (const entry of entries) this.extendContext(entry);
      if (this.list && this.list !== this.contextCache) this.list.push(...entries);
      this.onAppend?.();
    }
    return entries;
  }

  /**
   * Moves the cursor. The entries left behind stay exactly where they are: that is what makes a
   * retry non-destructive and an undo reversible, where truncating an array is neither.
   */
  branch(leafId: string | null): void {
    if (leafId !== null) {
      const position = this.positionOf(leafId);
      if (position === undefined) throw new UnknownCursorError(leafId);
      this.leafPosition = position;
    } else {
      this.leafPosition = -1;
    }
    this.leafId = leafId;
    this.contextCache = null;
    this.contextCovers = -1;
    this.onAppend?.();
  }

  /** Everything written after `cursor`, in file order, read from the file. */
  async since(cursor: string | null): Promise<Entry[]> {
    return this.entriesIn(this.recordsSince(cursor));
  }

  /** Resolves once every queued append has reached the disk. Awaited by shutdown, and by tests. */
  async flush(): Promise<void> {
    await this.tail;
  }
}

/**
 * Reads a session's log, or opens an empty one.
 *
 * A missing file is a new conversation, not an error. An unreadable line is skipped and logged --
 * see `parseEntryLine` for why that is the whole reason this format was chosen.
 */
export async function openSessionLog(
  sessionId: string,
  leafId?: string | null,
  branchesChecked = false,
): Promise<SessionLog> {
  const path = entriesPath(sessionId);
  const { index, unterminated } = await openSessionIndex(sessionId);
  if (unterminated > 0) void log("warn", "session index: the log ended mid-line", { sessionId, bytes: unterminated });

  let bytes = 0;
  try {
    bytes = (await stat(path)).size;
  } catch {
    await mkdir(dirname(path), { recursive: true });
    // Created empty rather than on the first append, so "a session directory holds its log" is
    // true from the moment the directory exists. A conversation nobody ever wrote to used to be a
    // directory with settings and no log, a shape every walk had to special-case.
    await appendFile(path, "");
    return new SessionLog(sessionId, index, leafId ?? null, 0, null, null, branchesChecked);
  }

  const opened = new SessionLog(sessionId, index, leafId ?? null, bytes, null, null, branchesChecked);
  // A meta that lags the file, and nothing but a straight line past it: the tail is the branch.
  opened.adoptStraightTail();
  // A log whose shape is worth a look and that nothing has looked at yet: this is the one place the
  // whole file is read on the open path, and only for damage `branches.ts` can actually fix.
  if (opened.needsRepair()) await opened.repair();
  // The first thing the owner ever said names an untitled conversation, and it never changes: read
  // it once here, from the one line the index points at, rather than parse the log for it later.
  const firstUserRecord = findFirst(index, "user");
  if (firstUserRecord) {
    const entry = await opened.entryOf(firstUserRecord).catch(() => undefined);
    opened.rememberFirstUser(entry?.type === "user" ? entry.text : null);
  }
  return opened;
}

function findFirst(index: SessionIndex, type: EntryType): LogRecord | null {
  for (let i = 0; i < index.count; i++) {
    const record = index.recordAt(i);
    if (record.type === type) return record;
  }
  return null;
}
