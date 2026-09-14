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

import { appendFile, copyFile, mkdir, open, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import type { ChatLocation } from "../channels/types.ts";
import type { SessionAttachment, SessionSubAgentAction, SessionSubAgentState, SessionSubAgentStatus } from "./store.ts";
import { repairBranches } from "./branches.ts";

export const SESSION_LOG_VERSION = 1;

export type EntryType =
  | "user"
  | "phase"
  | "tool"
  | "command"
  | "failure"
  | "compaction"
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
  reasoningTokens?: number;
  /** How long the thinking that produced `reasoning` lasted. Kept so a reopened thread shows it. */
  reasoningMs?: number;
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
  durationMs?: number;
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
  prompt: false;
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
   * start of the branch and this id is what the summary stands for, and is still on disk.
   */
  firstKeptEntryId: string;
  tokensBefore: number;
  count: number;
  /**
   * How long the summary took to write, so a replayed boundary shows it the way a replayed
   * thinking phase shows its own span -- docs/reasoning-visibility.md. Absent on a boundary
   * written before this was measured, and drawn as nothing rather than as a zero.
   */
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
   * What the run's tools produced, as the paths they were written to.
   *
   * A tool attaches its files to the answer and the prose never names them, so this marker is the
   * only entry that can carry them to a reopened thread -- the phase was already on disk when the
   * tool ran. Resolved by filename, exactly like a `MEDIA:` ref (2026-09-14).
   */
  media?: string[];
}

export type Entry =
  | UserEntry
  | PhaseEntry
  | ToolEntry
  | CommandEntry
  | FailureEntry
  | CompactionEntry
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

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");

function sanitizeSessionId(raw: string): string {
  return raw.replace(/\.\./g, "_").replace(/\0/g, "");
}

export function sessionDir(sessionId: string): string {
  return join(SESSIONS_DIR, sanitizeSessionId(sessionId));
}

export const ENTRIES_FILE = "entries.jsonl";
export const META_FILE = "meta.json";

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
 * One session's entries, in memory and on disk.
 *
 * Opened through `openSessionLog`, which is the only path that reads the file. The instance owns
 * its own `seq` and leaf, so an append never has to re-read anything.
 */
export class SessionLog {
  readonly sessionId: string;
  private readonly file: string;
  private readonly list: Entry[];
  private nextSeq: number;
  private leafId: string | null;
  /** Serializes appends: two awaited writes must not interleave inside one line. */
  private tail: Promise<void> = Promise.resolve();
  /**
   * What a conversation list needs and nothing else, kept incrementally so it can be mirrored
   * into `meta.json`. A drawer that has to open every log to count messages and read a title
   * parses every conversation the owner has ever had -- 214 MB of JSONL here, several times that
   * once it is objects -- to draw one sidebar.
   */
  private prompts: number;
  private firstUser: string | null;
  /**
   * Told after every append, leaf moved. The manager hangs the session's dirty flag on it, so the
   * autosave carries the new leaf to `meta.json` within its tick. Without it the flag moved only
   * with a model call's usage, and a leaf that advanced between two calls (a tool settling, the
   * `run_end` marker) waited for the run's own persist: a process killed there reopened the log
   * on the leaf before them, and the entries past it were a dead branch.
   */
  onAppend: (() => void) | undefined;
  /** What `openSessionLog` had to put back on the branch, if anything -- `branches.ts`. */
  readonly repaired: { relinked: number; reparented: number; adoptedTail: boolean } | null;

  constructor(sessionId: string, entries: Entry[], leafId: string | null, repaired: { relinked: number; reparented: number; adoptedTail: boolean } | null = null) {
    this.sessionId = sessionId;
    this.repaired = repaired;
    this.file = entriesPath(sessionId);
    this.list = entries;
    this.nextSeq = entries.reduce((max, entry) => Math.max(max, entry.seq), -1) + 1;
    this.leafId = leafId ?? entries[entries.length - 1]?.id ?? null;
    this.prompts = entries.reduce((count, entry) => (entry.prompt ? count + 1 : count), 0);
    this.firstUser = entries.find((entry): entry is UserEntry => entry.type === "user")?.text ?? null;
  }

  /** Entries a prompt would carry: the message count a conversation list shows. */
  promptCount(): number {
    return this.prompts;
  }

  /** Raw text of the first thing the owner said, which is what an untitled conversation is named after. */
  firstUserText(): string | null {
    return this.firstUser;
  }

  entries(): readonly Entry[] {
    return this.list;
  }

  leaf(): string | null {
    return this.leafId;
  }

  /** Id of the newest entry written, whatever branch it is on: the cursor a client syncs against. */
  head(): string | null {
    return this.list[this.list.length - 1]?.id ?? null;
  }

  get(entryId: string): Entry | undefined {
    return this.list.find((entry) => entry.id === entryId);
  }

  path(): Entry[] {
    return pathOf(this.list, this.leafId);
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
    if (id !== undefined && this.get(id)) throw new Error(`Entry id already exists: ${id}`);
    const entry = {
      ...input,
      id: id ?? newEntryId(now),
      seq: this.nextSeq++,
      parentId: this.leafId,
      ts: now,
      // The generic is the caller's promise about which member it is building; the omitted four
      // fields are put back right here, so the assertion restores exactly what Provisioned removed.
    } as unknown as T;
    this.list.push(entry);
    this.leafId = entry.id;
    if (entry.prompt) this.prompts += 1;
    if (this.firstUser === null && entry.type === "user") this.firstUser = entry.text;
    this.write(`${JSON.stringify(entry)}\n`, 1);
    this.onAppend?.();
    return entry;
  }

  /** Queues one write behind the last. Never rejects: see the comment inside for why. */
  private write(lines: string, count: number): void {
    this.tail = this.tail
      .catch(() => {})
      .then(async () => {
        const separator = (await endsOnNewline(this.file)) ? "" : "\n";
        await appendFile(this.file, `${separator}${lines}`, "utf-8");
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
    const ids = new Set(this.list.map((entry) => entry.id));
    let parentId = this.leafId;
    for (const input of inputs) {
      const ts = input.ts ?? now;
      const id = input.id ?? newEntryId(ts);
      if (ids.has(id)) throw new Error(`Entry id already exists: ${id}`);
      ids.add(id);
      const entry = { ...input, id, seq: this.nextSeq++, parentId, ts } as unknown as Entry;
      entries.push(entry);
      parentId = entry.id;
    }
    patch?.(entries);
    for (const entry of entries) this.list.push(entry);
    this.leafId = parentId;
    const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    if (lines.length > 0) this.write(lines, entries.length);
    if (entries.length > 0) this.onAppend?.();
    return entries;
  }

  /**
   * Moves the cursor. The entries left behind stay exactly where they are: that is what makes a
   * retry non-destructive and an undo reversible, where truncating an array is neither.
   */
  branch(leafId: string | null): void {
    if (leafId !== null && !this.get(leafId)) throw new UnknownCursorError(leafId);
    this.leafId = leafId;
    this.onAppend?.();
  }

  /**
   * Everything written after `cursor`, in file order.
   *
   * File order, not branch order, and that is the point: a client applying these in order ends up
   * with every entry it lacks whichever branch they were written on, and the leaf it is told about
   * separately decides what it shows. That is why a branch switch does not invalidate a cursor.
   */
  since(cursor: string | null): Entry[] {
    if (cursor === null) return [...this.list];
    const index = this.list.findIndex((entry) => entry.id === cursor);
    if (index < 0) throw new UnknownCursorError(cursor);
    return this.list.slice(index + 1);
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
export async function openSessionLog(sessionId: string, leafId?: string | null): Promise<SessionLog> {
  const path = entriesPath(sessionId);
  let raw = "";
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      void log("warn", "session log: unreadable file, starting empty", { sessionId, error: String(err) });
    }
    await mkdir(dirname(path), { recursive: true });
    // Created empty rather than on the first append, so "a session directory holds its log" is
    // true from the moment the directory exists. A conversation nobody ever wrote to used to be a
    // directory with settings and no log, a shape every walk had to special-case.
    await appendFile(path, "");
    return new SessionLog(sessionId, [], leafId ?? null);
  }

  const entries: Entry[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const entry = parseEntryLine(lines[i]!, sessionId, i + 1);
    if (entry) entries.push(entry);
  }

  // A file that does not end on a newline ends on a line nobody finished writing. Skipping it at
  // read time is not enough: the next append would glue itself to that stump, and the entry that
  // was supposed to repair the damage would be swallowed by it. Cut the stump off the file instead,
  // so the only thing the interrupted write costs is the entry it never finished.
  if (raw.length > 0 && !raw.endsWith("\n")) {
    const keep = raw.lastIndexOf("\n") + 1;
    await truncate(path, keep).catch((err) => {
      void log("error", "session log: could not drop an unterminated line", { sessionId, error: String(err) });
    });
    void log("warn", "session log: dropped an unterminated last line", { sessionId, bytes: raw.length - keep });
  }

  // Dead branches go back on the branch here, at the one door every read goes through, so an
  // install that carries them from an older version is whole the next time a conversation opens
  // (`branches.ts`). The file is rewritten only when a parent link moved, atomically, with a copy
  // kept beside it: the repair moves links and never deletes, but the shape it undoes is gone.
  const repair = repairBranches(entries, leafId ?? null);
  const repaired = repair.relinked.length > 0 || repair.reparented.length > 0 || repair.adoptedTail
    ? { relinked: repair.relinked.length, reparented: repair.reparented.length, adoptedTail: repair.adoptedTail }
    : null;
  // The rewrite also settles what the read recovered: the stump that swallowed an entry is not
  // part of any entry, so it is gone from the file the moment the file is rewritten. The copy kept
  // beside it is where those bytes stay, which is the same trade the branch repair already makes.
  if (repair.relinked.length > 0 || repair.reparented.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(path, `${path}.bak-branches-${stamp}`);
    await writeFile(`${path}.tmp`, repair.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf-8");
    await rename(`${path}.tmp`, path);
  }
  if (repair.reparented.length > 0) {
    void log("warn", "session log: entries whose parent was never written, put behind the line before them", {
      sessionId,
      reparented: repair.reparented.length,
      ids: repair.reparented.slice(0, 5),
    });
  }
  if (repair.relinked.length > 0 || repair.adoptedTail) {
    void log("warn", "session log: dead branches put back on the branch", {
      sessionId,
      forks: repair.bugForks,
      deliberateForks: repair.deliberateForks,
      relinked: repair.relinked.length,
      adoptedTail: repair.adoptedTail,
      leafId: repair.leafId,
    });
  }

  return new SessionLog(sessionId, repair.entries, repair.leafId, repaired);
}
