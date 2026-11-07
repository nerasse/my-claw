/**
 * The byte map of a session log: one fixed-width record per entry, beside `entries.jsonl`.
 *
 * The log is append-only and an entry is never rewritten, which makes a second file that says
 * where each entry sits in the first one a pure function of the log. That is the whole point:
 * opening a conversation must not read the conversation. Measured on a real 127 MB session,
 * opening cost 1.4 s and retained ~600 MB; reading the index of the same session costs 5 ms and
 * retains 2.6 MB, and the page the app asks for is 6 ms of seeks more.
 *
 * Derived, never authoritative. A missing or lagging index is rebuilt from the log in one pass
 * (the four fields a record needs sit at its ends, so the pass does not parse the entries); a
 * record pointing past the end of the log is dropped. Nothing in the log depends on this file, and
 * deleting it costs one scan.
 *
 * The parent is stored as a record *position*, not an id: positions are dense, so a branch walk
 * from the leaf reads the index twice and never touches the conversation.
 */

import { appendFile, mkdir, open, readFile, stat, truncate, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { log } from "../utils/logger.ts";
import { ENTRIES_FILE, sessionDir } from "./paths.ts";
import type { EntryType } from "./log.ts";

export const INDEX_FILE = "entries.idx";

/**
 * Ids the 16 bytes of a record cannot hold, one `<position>\t<id>` per line.
 *
 * Empty on every install this ships to: the log mints UUIDv7 and the app names its bubbles with
 * UUIDs too. It exists so a lookup by id is never approximate -- a test that names its entries `u1`
 * and `e1` reads back exactly what it wrote.
 */
export const INDEX_IDS_FILE = "entries.idxids";

/** id(16) parent(4) seq(4) offset-hi(4) offset-lo(4) length(4) ts(8) type(1) flags(1) pad(10). */
export const RECORD_BYTES = 56;

/** No parent: the root of a tree. */
export const NO_PARENT = 0xffffffff;
/** A `parentId` no line of the log holds -- `branches.ts` repairs what this names. */
export const DANGLING_PARENT = 0xfffffffe;

const FLAG_PROMPT = 1;
const FLAG_SPAWN_CARD = 2;
/** The id did not fit 16 bytes, and lives in `entries.idxids` instead. */
const FLAG_SIDE_ID = 4;

/**
 * Whether an id is a UUID, which is what 16 bytes hold.
 *
 * Every id this log mints is one (`newEntryId`, UUIDv7, and the app's own bubble ids), so the record
 * carries it whole and needs no other file. Anything else -- a test's `u1`, a hand-made cursor in a
 * migration -- keeps its id in the sidecar, because a lookup by id is not allowed to be approximate.
 */
export function isCanonicalId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * The type of an entry, as one byte. The order is the file format: adding a type at the end is a
 * version bump, reordering it is corruption.
 */
export const ENTRY_TYPE_CODES: readonly EntryType[] = [
  "user",
  "phase",
  "tool",
  "command",
  "failure",
  "compaction",
  "compaction_stopped",
  "model_change",
  "note",
  "spawn_state",
  "run_start",
  "run_end",
];

const CODE_OF_TYPE = new Map<EntryType, number>(ENTRY_TYPE_CODES.map((type, i) => [type, i + 1]));

/**
 * The tools whose card a sub-agent's lifecycle annotates. A spawn state names a call id, and this
 * is what tells a reader whether the card it revises is a line of the log or a card that has to
 * stand in for it -- without reading every tool entry ever written.
 */
export const SPAWN_CARD_TOOLS: ReadonlySet<string> = new Set(["spawn", "send", "delegate_browser_task"]);

export interface LogRecord {
  /** Position in file order, 0-based. */
  index: number;
  id: string;
  /** Record position of the parent, or `NO_PARENT` / `DANGLING_PARENT`. */
  parent: number;
  seq: number;
  ts: number;
  type: EntryType;
  prompt: boolean;
  /** A `spawn` / `send` / `delegate_browser_task` call: the card a spawn state revises. */
  spawnCard: boolean;
  /** Byte offset of the line in `entries.jsonl`. */
  offset: number;
  /** Byte length of the line, newline excluded. */
  length: number;
}

export function formatEntryId(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function hexOf(id: string): string {
  return id.replace(/-/g, "").toLowerCase().slice(0, 32).padEnd(32, "0");
}

/** One record, encoded at `at` of a buffer. */
export function encodeRecord(record: Omit<LogRecord, "index">, target: Buffer, at: number): void {
  const inline = isCanonicalId(record.id);
  if (inline) target.write(hexOf(record.id), at, 16, "hex");
  else target.fill(0, at, at + 16);
  target.writeUInt32BE(record.parent >>> 0, at + 16);
  target.writeUInt32BE(Math.max(record.seq, 0) >>> 0, at + 20);
  target.writeUInt32BE(Math.floor(record.offset / 2 ** 32) >>> 0, at + 24);
  target.writeUInt32BE((record.offset >>> 0) >>> 0, at + 28);
  target.writeUInt32BE(Math.min(record.length, 0xffffffff) >>> 0, at + 32);
  target.writeDoubleBE(record.ts, at + 36);
  target.writeUInt8(CODE_OF_TYPE.get(record.type) ?? 0, at + 44);
  target.writeUInt8(
    (record.prompt ? FLAG_PROMPT : 0) | (record.spawnCard ? FLAG_SPAWN_CARD : 0) | (inline ? 0 : FLAG_SIDE_ID),
    at + 45,
  );
}

function decodeRecord(buf: Buffer, at: number, index: number, sideIds?: ReadonlyMap<number, string>): LogRecord {
  const code = buf.readUInt8(at + 44);
  const flags = buf.readUInt8(at + 45);
  return {
    index,
    id: (flags & FLAG_SIDE_ID) !== 0 ? sideIds?.get(index) ?? "" : formatEntryId(buf.subarray(at, at + 16).toString("hex")),
    parent: buf.readUInt32BE(at + 16),
    seq: buf.readUInt32BE(at + 20),
    offset: buf.readUInt32BE(at + 24) * 2 ** 32 + buf.readUInt32BE(at + 28),
    length: buf.readUInt32BE(at + 32),
    ts: buf.readDoubleBE(at + 36),
    type: ENTRY_TYPE_CODES[code - 1] ?? "note",
    prompt: (flags & FLAG_PROMPT) !== 0,
    spawnCard: (flags & FLAG_SPAWN_CARD) !== 0,
  };
}

/**
 * The records of one log, in memory, growable at the end.
 *
 * A single buffer rather than an array of objects: a record is 56 bytes, and a conversation of a
 * million entries is 56 MB of them where the same records as JS objects are a gigabyte and a
 * nursery for the collector. `recordAt` is the only reader, so nothing else has to know.
 */
export class SessionIndex {
  private buf: Buffer;
  private used: number;
  /** Ids that do not fit 16 bytes, by position -- see `isCanonicalId`. Empty in practice. */
  private sideIds: Map<number, string>;

  constructor(buf: Buffer, count: number, sideIds: Map<number, string> = new Map()) {
    this.buf = buf;
    this.used = count;
    this.sideIds = sideIds;
  }

  static empty(): SessionIndex {
    return new SessionIndex(Buffer.alloc(RECORD_BYTES * 64), 0);
  }

  static fromBuffer(raw: Buffer, sideIds: Map<number, string> = new Map()): SessionIndex {
    const count = Math.floor(raw.length / RECORD_BYTES);
    return new SessionIndex(raw.subarray(0, count * RECORD_BYTES), count, sideIds);
  }

  /** Records whose id lives outside the buffer, which only a rebuild or a reopen has to know. */
  sideIdEntries(): Array<[number, string]> {
    return [...this.sideIds.entries()];
  }

  get count(): number {
    return this.used;
  }

  /** The type of a record, without decoding the rest of it: the hot loops read this and nothing else. */
  typeOf(index: number): EntryType {
    return ENTRY_TYPE_CODES[this.buf.readUInt8(index * RECORD_BYTES + 44) - 1] ?? "note";
  }

  /** Whether the entry is part of a prompt, without decoding it. */
  promptOf(index: number): boolean {
    return (this.buf.readUInt8(index * RECORD_BYTES + 45) & FLAG_PROMPT) !== 0;
  }

  /** Whether the entry is the card of a `spawn` / `send` / `delegate_browser_task`. */
  spawnCardOf(index: number): boolean {
    return (this.buf.readUInt8(index * RECORD_BYTES + 45) & FLAG_SPAWN_CARD) !== 0;
  }

  /** The parent position of a record, without decoding it. */
  parentOf(index: number): number {
    return this.buf.readUInt32BE(index * RECORD_BYTES + 16);
  }

  /** When the entry was written, without decoding it. */
  tsOf(index: number): number {
    return this.buf.readDoubleBE(index * RECORD_BYTES + 36);
  }

  recordAt(index: number): LogRecord {
    if (index < 0 || index >= this.used) throw new RangeError(`record ${index} of ${this.used}`);
    return decodeRecord(this.buf, index * RECORD_BYTES, index, this.sideIds);
  }

  /** The newest record, or undefined on an empty log. */
  get last(): LogRecord | undefined {
    return this.used === 0 ? undefined : this.recordAt(this.used - 1);
  }

  push(record: Omit<LogRecord, "index">): LogRecord {
    if ((this.used + 1) * RECORD_BYTES > this.buf.length) {
      const grown = Buffer.alloc(Math.max(this.buf.length * 2, RECORD_BYTES * 64));
      this.buf.copy(grown, 0, 0, this.used * RECORD_BYTES);
      this.buf = grown;
    }
    encodeRecord(record, this.buf, this.used * RECORD_BYTES);
    if (!isCanonicalId(record.id)) this.sideIds.set(this.used, record.id);
    this.used += 1;
    return this.recordAt(this.used - 1);
  }

  /** Every id in the index, mapped to its position. Built on demand -- nothing on the open path. */
  idPositions(): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = 0; i < this.used; i++) out.set(this.recordAt(i).id, i);
    return out;
  }

  /**
   * Whether anything in this log is worth `branches.ts`: a parent the log does not hold, or a fork
   * (a parent with two children). Two linear passes over the index, no entry read.
   *
   * A fork is not damage by itself -- `/undo` and `/retry` leave one on purpose -- so the answer
   * only says "worth looking at". The repair pass tells the two apart, and the session's meta
   * remembers that it ran.
   */
  needsRepair(): boolean {
    const seen = new Uint8Array(this.used);
    for (let i = 0; i < this.used; i++) {
      const parent = this.buf.readUInt32BE(i * RECORD_BYTES + 16);
      if (parent === DANGLING_PARENT) return true;
      if (parent >= this.used) continue;
      if (seen[parent] === 1) return true;
      seen[parent] = 1;
    }
    return false;
  }

  toBuffer(): Buffer {
    return this.buf.subarray(0, this.used * RECORD_BYTES);
  }
}

/**
 * The four fields a record needs, pulled out of a line without parsing it.
 *
 * Both writers of this log put those fields in a fixed run at the end of the object, and the type
 * and the tool name at its head, so a scan costs three small slices per line instead of a JSON
 * parse of a line that can weigh a megabyte: 127 MB in 150 ms here, against 900 ms parsing.
 *
 * Anything the shapes do not recognise -- a third writer, a hand-edited line -- falls back to the
 * parse. The shapes are anchored on the closing brace and on the exact key order, so a tool output
 * that happens to end in JSON cannot be mistaken for the entry's own fields.
 */
const ID = String.raw`"id"\s*:\s*"([0-9a-f-]{36})"`;
const SEQ = String.raw`"seq"\s*:\s*(\d+)`;
const PARENT = String.raw`"parentId"\s*:\s*(null|"[0-9a-f-]{36}")`;
const TS = String.raw`"ts"\s*:\s*(\d+)`;

const SHAPE_ID_SEQ_PARENT_TS = new RegExp(`${ID},\\s*${SEQ},\\s*${PARENT},\\s*${TS}(?:,.*)?\\}$`);
const SHAPE_TS_ID_SEQ_PARENT = new RegExp(`${TS},\\s*${ID},\\s*${SEQ},\\s*${PARENT}(?:,.*)?\\}$`);
const SHAPE_PARENT_TS_ID_SEQ = new RegExp(`${PARENT},\\s*${TS},\\s*${ID},\\s*${SEQ}(?:,.*)?\\}$`);

const HEAD_TYPE = /^\{\s*"type"\s*:\s*"(\w+)"\s*,\s*"prompt"\s*:\s*(true|false)/;
const HEAD_TOOL_NAME = /"name"\s*:\s*"([^"]{1,64})"/;

const TAIL_BYTES = 320;
const HEAD_BYTES = 200;

interface Extracted {
  id: string;
  seq: number;
  parentId: string | null;
  ts: number;
  type: EntryType;
  prompt: boolean;
  spawnCard: boolean;
}

function extractLine(line: Buffer): Extracted | null {
  const tail = line.subarray(Math.max(0, line.length - TAIL_BYTES)).toString("latin1");
  let id: string | undefined;
  let seq: number | undefined;
  let parentId: string | null | undefined;
  let ts: number | undefined;
  let match = SHAPE_ID_SEQ_PARENT_TS.exec(tail);
  if (match) {
    id = match[1];
    seq = Number(match[2]);
    parentId = match[3] === "null" ? null : match[3]!.slice(1, -1);
    ts = Number(match[4]);
  } else if ((match = SHAPE_TS_ID_SEQ_PARENT.exec(tail))) {
    ts = Number(match[1]);
    id = match[2];
    seq = Number(match[3]);
    parentId = match[4] === "null" ? null : match[4]!.slice(1, -1);
  } else if ((match = SHAPE_PARENT_TS_ID_SEQ.exec(tail))) {
    parentId = match[1] === "null" ? null : match[1]!.slice(1, -1);
    ts = Number(match[2]);
    id = match[3];
    seq = Number(match[4]);
  }
  const head = line.subarray(0, Math.min(line.length, HEAD_BYTES)).toString("latin1");
  const headType = HEAD_TYPE.exec(head);
  if (id === undefined || seq === undefined || parentId === undefined || ts === undefined || !headType) {
    return parseWholeLine(line);
  }
  const type = headType[1] as EntryType;
  if (!CODE_OF_TYPE.has(type)) return parseWholeLine(line);
  const spawnCard = type === "tool" && SPAWN_CARD_TOOLS.has(HEAD_TOOL_NAME.exec(head)?.[1] ?? "");
  return { id, seq, parentId, ts, type, prompt: headType[2] === "true", spawnCard };
}

function parseWholeLine(line: Buffer): Extracted | null {
  let entry: { id?: unknown; seq?: unknown; parentId?: unknown; ts?: unknown; type?: unknown; prompt?: unknown; name?: unknown };
  try {
    entry = JSON.parse(line.toString("utf-8"));
  } catch {
    return null;
  }
  if (typeof entry.id !== "string" || typeof entry.type !== "string" || !CODE_OF_TYPE.has(entry.type as EntryType)) return null;
  return {
    id: entry.id,
    seq: typeof entry.seq === "number" ? entry.seq : 0,
    parentId: typeof entry.parentId === "string" ? entry.parentId : null,
    ts: typeof entry.ts === "number" ? entry.ts : 0,
    type: entry.type as EntryType,
    prompt: entry.prompt === true,
    spawnCard: entry.type === "tool" && typeof entry.name === "string" && SPAWN_CARD_TOOLS.has(entry.name),
  };
}

/**
 * Walks `raw` from `fromOffset` and appends a record per line to `index`. Offsets are absolute in
 * the log: `raw` starts at `base` there, which is 0 for a whole-file scan and the end of the index
 * for a tail scan.
 *
 * `positions` resolves a parent id to a record: the map the caller already has when it rebuilds,
 * or one built from what the index holds when only the tail is missing. A parent the map does not
 * hold is `DANGLING_PARENT`, which is exactly what `branches.ts` needs to know.
 */
function scanInto(
  raw: Buffer,
  fromOffset: number,
  base: number,
  index: SessionIndex,
  positions: Map<string, number>,
): { endOffset: number; unterminated: number } {
  let start = fromOffset;
  let endOffset = fromOffset;
  let unterminated = 0;
  let duplicated = 0;
  while (start < raw.length) {
    const newline = raw.indexOf(0x0a, start);
    if (newline === -1) {
      unterminated = raw.length - start;
      break;
    }
    const local = start;
    const length = newline - start;
    start = newline + 1;
    if (length === 0) {
      endOffset = start;
      continue;
    }
    const extracted = extractLine(raw.subarray(local, newline));
    if (!extracted || positions.has(extracted.id)) {
      if (extracted) duplicated += 1;
      endOffset = start;
      continue;
    }
    const parent = extracted.parentId === null ? NO_PARENT : positions.get(extracted.parentId) ?? DANGLING_PARENT;
    const record = index.push({
      id: extracted.id,
      parent,
      seq: extracted.seq,
      ts: extracted.ts,
      type: extracted.type,
      prompt: extracted.prompt,
      spawnCard: extracted.spawnCard,
      offset: base + local,
      length,
    });
    positions.set(record.id, record.index);
    endOffset = start;
  }
  if (duplicated > 0) void log("warn", "session index: lines claiming an id already in the log", { count: duplicated });
  return { endOffset, unterminated };
}

async function readIndexFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    void log("warn", "session index: unreadable, rebuilding", { path, error: String(err) });
    return null;
  }
}

async function writeIndexFile(sessionId: string, index: SessionIndex): Promise<void> {
  await mkdir(sessionDir(sessionId), { recursive: true });
  await writeFile(join(sessionDir(sessionId), INDEX_FILE), index.toBuffer());
  const side = index.sideIdEntries();
  await writeFile(join(sessionDir(sessionId), INDEX_IDS_FILE), side.map(([at, id]) => `${at}\t${id}\n`).join(""));
}

async function readSideIds(sessionId: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  let raw = "";
  try {
    raw = await readFile(join(sessionDir(sessionId), INDEX_IDS_FILE), "utf-8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const at = line.indexOf("\t");
    if (at < 0) continue;
    out.set(Number(line.slice(0, at)), line.slice(at + 1));
  }
  return out;
}

/** The bytes of the log from `from` to its end. */
export async function readRange(path: string, from: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size <= from) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(size - from);
    await handle.read(buf, 0, buf.length, from);
    return buf;
  } finally {
    await handle.close();
  }
}

export interface OpenedIndex {
  index: SessionIndex;
  /** Bytes the log lost to a line nobody finished writing, 0 when the file ended on a newline. */
  unterminated: number;
  /** Whether the log was read end to end, which is the case worth a log line. */
  rebuilt: boolean;
}

/**
 * The index of a log, opened or brought up to date.
 *
 * Three shapes, and only the first is the common one: an index whose last record ends exactly
 * where the log does; an index that lags (a write that landed in the log after the process died
 * between the two appends), appended from where it stopped; and nothing usable at all, scanned
 * from the start. A record pointing past the end of the log is dropped -- the index ran ahead of a
 * write that never landed.
 */
export async function openSessionIndex(sessionId: string): Promise<OpenedIndex> {
  const logPath = join(sessionDir(sessionId), ENTRIES_FILE);
  let size = 0;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return { index: SessionIndex.empty(), unterminated: 0, rebuilt: false };
  }

  const raw = await readIndexFile(join(sessionDir(sessionId), INDEX_FILE));
  if (raw && raw.length >= RECORD_BYTES) {
    const whole = raw.subarray(0, Math.floor(raw.length / RECORD_BYTES) * RECORD_BYTES);
    const sideIds = await readSideIds(sessionId);
    const found = SessionIndex.fromBuffer(whole, sideIds);
    let count = found.count;
    while (count > 0 && found.recordAt(count - 1).offset >= size) count -= 1;
    if (count === 0) return rebuild(sessionId, logPath, size);
    const index = count === found.count ? found : new SessionIndex(whole, count, sideIds);
    const last = index.last!;
    const end = last.offset + last.length + 1;
    if (end < size) {
      // The log grew past the index: a process died between the two appends, or the index predates
      // a write. Only the tail is scanned; the file stays the authority on where lines end.
      const tail = await readRange(logPath, end);
      scanInto(tail, 0, end, index, index.idPositions());
      await writeIndexFile(sessionId, index).catch(() => {});
      return { index, unterminated: 0, rebuilt: false };
    }
    if (end > size) {
      // A line nobody finished writing where the index expected one: the log is shorter than its
      // record says. Nothing to serve past it, so the record goes and the stump follows.
      return rebuild(sessionId, logPath, size);
    }
    return { index, unterminated: 0, rebuilt: false };
  }

  return rebuild(sessionId, logPath, size);
}

async function rebuild(sessionId: string, logPath: string, size: number): Promise<OpenedIndex> {
  if (size === 0) {
    return { index: SessionIndex.empty(), unterminated: 0, rebuilt: false };
  }
  const all = await readFile(logPath).catch(() => null);
  if (!all) return { index: SessionIndex.empty(), unterminated: 0, rebuilt: false };
  const index = SessionIndex.empty();
  const { endOffset, unterminated } = scanInto(all, 0, 0, index, new Map());
  if (unterminated > 0) {
    await truncate(logPath, endOffset).catch((err) => {
      void log("error", "session index: could not drop an unterminated line", { sessionId, error: String(err) });
    });
    void log("warn", "session index: dropped an unterminated last line", { sessionId, bytes: unterminated });
  }
  await writeIndexFile(sessionId, index).catch((err) => {
    // A session directory that vanished, or a read-only volume: the log still opens, it just opens
    // through a scan next time.
    void log("warn", "session index: could not be written", { sessionId, error: String(err) });
  });
  return { index, unterminated, rebuilt: true };
}

/** Appends the records of the lines a caller just wrote, and the ids they could not hold. */
export async function appendIndex(
  sessionId: string,
  records: Buffer,
  sideIds: ReadonlyArray<readonly [number, string]> = [],
): Promise<void> {
  if (records.length === 0) return;
  await appendFile(join(sessionDir(sessionId), INDEX_FILE), records);
  if (sideIds.length > 0) {
    await appendFile(join(sessionDir(sessionId), INDEX_IDS_FILE), sideIds.map(([at, id]) => `${at}\t${id}\n`).join(""));
  }
}

/** Replaces the whole index, after `branches.ts` moved parent links and the log was rewritten. */
export async function writeIndex(sessionId: string, index: SessionIndex): Promise<void> {
  await writeIndexFile(sessionId, index);
}
