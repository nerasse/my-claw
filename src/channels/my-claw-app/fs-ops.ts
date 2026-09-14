import { type FSWatcher } from "node:fs";
import { open, readdir, lstat, stat, realpath, mkdir, rename, rm, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { watchQuiet } from "../../utils/watch.ts";
import type { MyClawAppFsEncoding, MyClawAppFsEntry, MyClawAppFsEol } from "./types.ts";

/** The files page's pure half: listing, windowed reads, format detection, atomic writes, the
 *  removal guards and the watch helpers -- everything testable without a socket. */

/** Past this many entries a listing says so rather than pretending: node_modules has more. */
export const FS_LIST_LIMIT = 5000;

/** One read window. Deliberately not larger: the phone never draws more, and nextFrom continues. */
export const FS_READ_MAX = 2_000_000;

/** Per connection, one watcher per path and no more than this many paths. */
export const FS_WATCH_MAX = 8;

/** How long a burst of watcher events is gathered into one fs.changed. */
export const FS_WATCH_DEBOUNCE_MS = 250;

/** Text detection samples the first 4 KB: enough for magic-byte damage, no more. */
const DETECT_SAMPLE_BYTES = 4096;

/** Past this share of control characters, a sample is not text. */
const CONTROL_SHARE = 0.3;

/** How far past a window end the line-boundary scan reads before it gives up and cuts back. */
const WINDOW_SCAN_BYTES = 64 * 1024;

/**
 * Extensions that are binary to a certainty. The hint only picks an icon -- unknown extensions
 * guess text, because an icon guessed wrong costs nothing and the truth is `fs.read`'s.
 */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic", "avif",
  "mp3", "wav", "flac", "ogg", "opus", "m4a", "aac", "wma",
  "mp4", "mkv", "avi", "mov", "webm", "wmv", "flv", "mpeg", "mpg",
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub", "mobi",
  "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "jar", "wasm", "node", "pyc", "pyo",
  "ttf", "otf", "woff", "woff2", "eot",
  "db", "sqlite", "sqlite3", "mdb", "dat", "pak", "iso", "img", "dmg", "deb", "rpm", "apk",
]);

/** Whether the file is text, from its name alone. A guess for the icon, never for the editor. */
export function textHintFor(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return true;
  return !BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export interface FsListing {
  entries: MyClawAppFsEntry[];
  truncated: boolean;
}

export async function listDirectory(dir: string, limit = FS_LIST_LIMIT): Promise<FsListing> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const truncated = dirents.length > limit;
  const slice = truncated ? dirents.slice(0, limit) : dirents;
  const entries: MyClawAppFsEntry[] = [];
  // Stats in batches: a 5000-entry listing is 5000 syscalls, and handing them all to the thread
  // pool at once is how listing /usr/bin stalls every other disk read in the process.
  const BATCH = 128;
  for (let i = 0; i < slice.length; i += BATCH) {
    const batch = slice.slice(i, i + BATCH);
    entries.push(...(await Promise.all(batch.map((dirent) => describeEntry(dir, dirent)))));
  }
  return { entries, truncated };
}

async function describeEntry(dir: string, dirent: Dirent): Promise<MyClawAppFsEntry> {
  const path = join(dir, dirent.name);
  const kind: MyClawAppFsEntry["kind"] = dirent.isDirectory()
    ? "dir"
    : dirent.isSymbolicLink()
      ? "symlink"
      : dirent.isFile()
        ? "file"
        : "other";
  let size = 0;
  let mtimeMs = 0;
  let mode = 0;
  try {
    const st = await lstat(path);
    size = st.size;
    mtimeMs = st.mtimeMs;
    mode = st.mode;
  } catch {
    // Vanished between readdir and lstat (/proc does this constantly): listed with zeroes rather
    // than dropped, because a row the app already shows is less wrong than a hole.
  }
  const entry: MyClawAppFsEntry = { name: dirent.name, path, kind, size, mtimeMs, mode, textHint: textHintFor(dirent.name) };
  if (kind === "symlink") {
    try {
      const target = await stat(path);
      entry.targetKind = target.isDirectory() ? "dir" : target.isFile() ? "file" : "other";
    } catch {
      // Dangling: no targetKind, and the app draws the arrow as broken.
    }
  }
  return entry;
}

/** `${mtimeMs}-${size}`: cheap, and the identity every write checks before it lands. */
export function etagOf(st: { mtimeMs: number; size: number }): string {
  return `${st.mtimeMs}-${st.size}`;
}

export interface FsReadWindow {
  etag: string;
  size: number;
  mtimeMs: number;
  from: number;
  nextFrom: number | null;
  truncated: boolean;
  binary?: { reason: "nul" | "control" };
  encoding?: MyClawAppFsEncoding;
  eol?: MyClawAppFsEol;
  text?: string;
  lines?: number;
}

export async function readFileWindow(path: string, fromRaw?: number, maxBytesRaw?: number): Promise<FsReadWindow> {
  const st = await stat(path);
  if (!st.isFile()) throw new Error("not a regular file");
  const etag = etagOf(st);
  const maxBytes = Math.min(Math.max(1, Math.floor(maxBytesRaw ?? FS_READ_MAX)), FS_READ_MAX);
  let start = Math.min(Math.max(0, Math.floor(fromRaw ?? 0)), st.size);

  const handle = await open(path, "r");
  try {
    const sampleLen = Math.min(DETECT_SAMPLE_BYTES, st.size);
    const sample = Buffer.allocUnsafe(sampleLen);
    const sampleGot = sampleLen > 0 ? await readExact(handle, sample, 0) : 0;
    const verdict = detectFormat(sample.subarray(0, sampleGot), st.size > sampleGot);
    if (verdict.binary) {
      return { etag, size: st.size, mtimeMs: st.mtimeMs, from: start, nextFrom: null, truncated: false, binary: verdict.binary };
    }
    // UTF-16 is scanned and cut in code units: an odd start would decode garbage.
    if (verdict.encoding === "utf16le" || verdict.encoding === "utf16be") start += start % 2;
    if (start >= st.size) {
      return { etag, size: st.size, mtimeMs: st.mtimeMs, from: start, nextFrom: null, truncated: false, encoding: verdict.encoding, eol: "lf", text: "", lines: 0 };
    }
    // One read covers the window plus the scan slack the line-boundary alignment may need.
    const want = Math.min(st.size - start, maxBytes + WINDOW_SCAN_BYTES);
    const buffer = Buffer.allocUnsafe(want);
    const got = await readExact(handle, buffer, start);
    const bytes = buffer.subarray(0, got);
    const nominal = Math.min(got, maxBytes);
    let endRel = got <= maxBytes ? got : nextLineEnd(bytes, nominal, verdict.encoding);
    if (endRel < 0) endRel = cutToBoundary(bytes, nominal, verdict.encoding);
    if (endRel <= 0) endRel = Math.min(got, Math.max(1, endRel + 1));
    const end = start + endRel;
    const truncated = end < st.size;
    const text = decodeWindow(bytes.subarray(0, endRel), verdict.encoding);
    return {
      etag,
      size: st.size,
      mtimeMs: st.mtimeMs,
      from: start,
      nextFrom: truncated ? end : null,
      truncated,
      encoding: verdict.encoding,
      eol: detectEol(text),
      text,
      lines: countLines(text),
    };
  } finally {
    await handle.close();
  }
}

async function readExact(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total);
    if (bytesRead <= 0) break;
    total += bytesRead;
  }
  return total;
}

interface FormatVerdict {
  encoding: MyClawAppFsEncoding;
  binary?: { reason: "nul" | "control" };
}

/**
 * What the sample says the file is.
 *
 * The rules disagree on one point and this resolves it: a UTF-16 file is half NUL bytes, so the
 * NUL rule would call every one of them binary -- but the encoding list names utf16le and utf16be
 * as readable, which is only reachable when the BOM is checked first.
 */
function detectFormat(sample: Buffer, moreBytesFollow: boolean): FormatVerdict {
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return { encoding: "utf16le", ...(binaryOfText(decodeWindow(sample.subarray(2), "utf16le")) ?? {}) };
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return { encoding: "utf16be", ...(binaryOfText(decodeWindow(sample.subarray(2), "utf16be")) ?? {}) };
  }
  const bom = sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf;
  const binary = binaryOfBytes(sample);
  if (binary) return { encoding: bom ? "utf8-bom" : "utf8", binary };
  if (bom) return { encoding: "utf8-bom" };
  return { encoding: looksUtf8(sample, moreBytesFollow) ? "utf8" : "latin1" };
}

function binaryOfBytes(sample: Buffer): { reason: "nul" | "control" } | undefined {
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return { reason: "nul" };
    if ((byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) || byte === 0x7f) controls += 1;
  }
  if (sample.length > 0 && controls / sample.length > CONTROL_SHARE) return { reason: "control" };
  return undefined;
}

function binaryOfText(text: string): { reason: "nul" | "control" } | undefined {
  let controls = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0) return { reason: "nul" };
    if ((c < 0x20 && c !== 9 && c !== 10 && c !== 12 && c !== 13) || c === 0x7f) controls += 1;
  }
  if (text.length > 0 && controls / text.length > CONTROL_SHARE) return { reason: "control" };
  return undefined;
}

/**
 * UTF-8 well-formedness, with one allowance: a sequence cut by the sample's own end is not
 * evidence of anything when the file continues past the sample (the 4 KB cut lands mid-character
 * on its own schedule). With no bytes left after the sample, a truncated tail is real damage.
 */
function looksUtf8(sample: Buffer, moreBytesFollow: boolean): boolean {
  let i = 0;
  while (i < sample.length) {
    const b = sample[i]!;
    if (b < 0x80) {
      i += 1;
      continue;
    }
    let len: number;
    if (b >= 0xc2 && b <= 0xdf) len = 2;
    else if (b >= 0xe0 && b <= 0xef) len = 3;
    else if (b >= 0xf0 && b <= 0xf4) len = 4;
    else return false;
    if (i + len > sample.length) return moreBytesFollow;
    for (let k = 1; k < len; k += 1) {
      if ((sample[i + k]! & 0xc0) !== 0x80) return false;
    }
    if (len === 3) {
      const b1 = sample[i + 1]!;
      if (b === 0xe0 && b1 < 0xa0) return false;
      if (b === 0xed && b1 > 0x9f) return false;
    }
    if (len === 4) {
      const b1 = sample[i + 1]!;
      if (b === 0xf0 && b1 < 0x90) return false;
      if (b === 0xf4 && b1 > 0x8f) return false;
    }
    i += len;
  }
  return true;
}

function decodeWindow(bytes: Buffer, encoding: MyClawAppFsEncoding): string {
  if (encoding === "latin1") return bytes.toString("latin1");
  // utf-16be is decoded through utf-16le: the bundled TextDecoder types do not name it, and
  // swapping the bytes of every code unit is the same transform encodeText runs in reverse.
  const body = encoding === "utf16be" ? swapCodeUnitBytes(bytes) : bytes;
  // Bun's runtime accepts the WHATWG labels the published Encoding type leaves out.
  const label = (encoding === "utf8" || encoding === "utf8-bom" ? "utf-8" : "utf-16le") as Bun.Encoding;
  try {
    return new TextDecoder(label, { fatal: true }).decode(body);
  } catch {
    // A file appended to or truncated mid-codepoint while it was being read: the page still opens
    // it, with the damage visible as replacement characters, instead of refusing to show anything.
    return new TextDecoder(label).decode(body);
  }
}

/** Swaps the two bytes of every complete code unit; an odd trailing byte is dropped. */
function swapCodeUnitBytes(bytes: Buffer): Buffer {
  const pairs = bytes.length - (bytes.length % 2);
  const swapped = Buffer.allocUnsafe(pairs);
  for (let i = 0; i < pairs; i += 2) {
    swapped[i] = bytes[i + 1]!;
    swapped[i + 1] = bytes[i]!;
  }
  return swapped;
}

/** The index just past the next line terminator at or after `from`, or -1 when there is none. */
function nextLineEnd(bytes: Buffer, from: number, encoding: MyClawAppFsEncoding): number {
  if (encoding === "utf16le" || encoding === "utf16be") {
    let p = from % 2 === 1 ? from + 1 : from;
    for (; p + 1 < bytes.length; p += 2) {
      const low = bytes[p]!;
      const high = bytes[p + 1]!;
      if (encoding === "utf16le" ? low === 0x0a && high === 0x00 : low === 0x00 && high === 0x0a) return p + 2;
    }
    return -1;
  }
  const lf = bytes.indexOf(0x0a, from);
  return lf < 0 ? -1 : lf + 1;
}

/** `len` moved back to the previous character boundary; the fallback when no line end is in reach. */
function cutToBoundary(bytes: Buffer, len: number, encoding: MyClawAppFsEncoding): number {
  if (encoding === "latin1") return len;
  if (encoding === "utf16le" || encoding === "utf16be") return len - (len % 2);
  if (len <= 0) return 0;
  let cut = len;
  let continuations = 0;
  while (cut > 0 && continuations < 3 && (bytes[cut - 1]! & 0xc0) === 0x80) {
    cut -= 1;
    continuations += 1;
  }
  if (cut === 0) return 0;
  const lead = bytes[cut - 1]!;
  if (lead < 0x80) return continuations > 0 ? cut : len;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 1;
  return 1 + continuations >= need ? len : cut - 1;
}

function countLines(text: string): number {
  if (text === "") return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) newlines += 1;
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

function detectEol(text: string): MyClawAppFsEol {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10) continue;
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf += 1;
    else lf += 1;
  }
  if (crlf > 0 && lf > 0) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
}

export interface FsWriteRequest {
  path: string;
  text: string;
  etag: string;
  force?: boolean;
  encoding?: MyClawAppFsEncoding;
  eol?: MyClawAppFsEol;
}

export type FsWriteOutcome =
  | { ok: true; etag: string; size: number; mtimeMs: number }
  | { ok: false; conflict: { etag: string; size: number; mtimeMs: number } };

export async function writeTextFile(req: FsWriteRequest): Promise<FsWriteOutcome> {
  const target = await resolveSymlinkTarget(req.path);
  const before = await statOrNull(target);
  if (before && !before.isFile()) throw new Error("not a regular file");
  // No file and no etag is the create case; a non-empty etag against a missing file is the file
  // having been deleted since it was read, which the app handles exactly like a change.
  const currentEtag = before ? etagOf(before) : "";
  if (!req.force && req.etag !== currentEtag) {
    return { ok: false, conflict: { etag: currentEtag, size: before?.size ?? 0, mtimeMs: before?.mtimeMs ?? 0 } };
  }
  const detected = before ? await detectFileFormat(target) : undefined;
  const encoding = req.encoding ?? detected?.encoding ?? "utf8";
  const eol = req.eol && req.eol !== "mixed" ? req.eol : detected?.eol ?? "lf";
  const content = encodeText(req.text, encoding, eol);
  await writeBytesAtomically(target, content, before ? before.mode & 0o7777 : 0o644);
  const after = await stat(target);
  return { ok: true, etag: etagOf(after), size: after.size, mtimeMs: after.mtimeMs };
}

/** The file's format as a fresh read would report it: what a write with no explicit fields keeps. */
async function detectFileFormat(path: string): Promise<{ encoding: MyClawAppFsEncoding; eol: MyClawAppFsEol }> {
  const handle = await open(path, "r");
  try {
    const st = await handle.stat();
    const buffer = Buffer.allocUnsafe(DETECT_SAMPLE_BYTES);
    const got = await readExact(handle, buffer, 0);
    const sample = buffer.subarray(0, got);
    const verdict = detectFormat(sample, st.size > got);
    return { encoding: verdict.encoding, eol: detectEol(decodeWindow(sample, verdict.encoding)) };
  } finally {
    await handle.close();
  }
}

export function encodeText(text: string, encoding: MyClawAppFsEncoding, eol: MyClawAppFsEol): Buffer {
  const normalized = text.replace(/\r\n/g, "\n");
  const body = eol === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
  switch (encoding) {
    case "latin1": {
      for (let i = 0; i < body.length; i += 1) {
        if (body.charCodeAt(i) > 0xff) {
          throw new Error(`text carries a character latin1 cannot encode (offset ${i}); save as utf8 instead`);
        }
      }
      return Buffer.from(body, "latin1");
    }
    case "utf16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]);
    case "utf16be": {
      const le = Buffer.from(body, "utf16le");
      const be = swapCodeUnitBytes(le);
      return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    }
    case "utf8-bom":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]);
    default:
      return Buffer.from(body, "utf8");
  }
}

/**
 * Same-directory temp file, write, chmod to the target's mode, rename.
 *
 * Why not utils/atomic-write.ts: it writes string content (these payloads are bytes, because the
 * encodings here are not utf-8) and it creates missing parent directories (fs.mkdir owns tree
 * creation, deliberately non-recursive). What it gets right and is copied here: a unique temp
 * name, fsync before rename, and the old file untouched until the rename.
 */
export async function writeBytesAtomically(path: string, content: Buffer | Uint8Array, mode: number): Promise<void> {
  const tmp = tmpPathFor(path);
  const handle = await open(tmp, "w", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.chmod(mode);
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await handle.close();
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function writeStreamAtomically(path: string, stream: ReadableStream<Uint8Array>, mode: number): Promise<void> {
  const tmp = tmpPathFor(path);
  const handle = await open(tmp, "w", mode);
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
    }
    await handle.sync();
    await handle.chmod(mode);
  } catch (err) {
    await reader.cancel().catch(() => {});
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await handle.close();
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function tmpPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID().slice(0, 12)}.tmp`);
}

/** Writing through a symlink must edit its target, not replace the link: vim's default, and what
 *  the reader expects when a path under /etc/alternatives points at the real file. */
async function resolveSymlinkTarget(path: string): Promise<string> {
  try {
    const lst = await lstat(path);
    if (!lst.isSymbolicLink()) return path;
  } catch {
    return path;
  }
  return realpath(path);
}

export async function makeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: false });
}

/** rename(2), refusing an existing destination first: a move that silently replaced a file is
 *  how a page loses something the owner never asked to overwrite. */
export async function moveEntry(from: string, to: string): Promise<void> {
  const existing = await lstatOrNull(to);
  if (existing) throw new Error("destination already exists");
  await rename(from, to);
}

export async function removeEntry(path: string, recursive: boolean): Promise<void> {
  // Bun's rm on a directory without `recursive` fails with an EFAULT whose text names nothing;
  // the check states the reason instead.
  if (!recursive) {
    const st = await lstatOrNull(path);
    if (st?.isDirectory()) throw new Error("is a directory: remove it recursively to delete a tree");
  }
  await rm(path, { recursive, force: false });
}

export interface FsRemoveGuards {
  home: string;
  myClawDir: string;
  defaultWorkspace: string;
  cwd: string;
}

/**
 * Why `fs.remove` will never touch this path, or null to let it through. The reason is a sentence
 * because it reaches the owner verbatim. Compared canonical on both sides: a symlink to a root is
 * a root. A path that does not exist is not refused here -- rm will say so, and there is nothing
 * left to protect.
 */
export async function fsRemoveRefusal(path: string, guards: FsRemoveGuards): Promise<string | null> {
  const target = await realpathOrNull(path);
  if (target === null) return null;
  if (target === "/") return "refusing to remove the filesystem root";
  if (target === (await realpathOrNull(guards.home))) return "refusing to remove the home directory";
  if (target === (await realpathOrNull(guards.myClawDir))) return "refusing to remove the my-claw data directory";
  if (target === (await realpathOrNull(guards.defaultWorkspace))) return "refusing to remove the workspace directory";
  const cwd = await realpathOrNull(guards.cwd);
  if (cwd && (cwd === target || cwd.startsWith(`${target}/`))) {
    return "refusing to remove a directory the running process works inside";
  }
  return null;
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export interface FsChangeEvent {
  kind: "changed" | "removed";
  size: number;
  mtimeMs: number;
}

/**
 * The watchers open right now, one map per connection.
 *
 * Keyed by the socket object itself: the registry never reads it, it only needs identity, which
 * is also what makes it testable without sockets.
 */
export class FsWatchRegistry {
  private readonly bySocket = new Map<object, Map<string, FsPathWatcher>>();

  constructor(
    private readonly debounceMs = FS_WATCH_DEBOUNCE_MS,
    private readonly cap = FS_WATCH_MAX,
  ) {}

  /** True when the path is (already) watched; false at the cap or when it cannot be attached. */
  watch(key: object, path: string, emit: (change: FsChangeEvent) => void): boolean {
    let set = this.bySocket.get(key);
    if (!set) {
      set = new Map();
      this.bySocket.set(key, set);
    }
    if (set.has(path)) return true;
    if (set.size >= this.cap) return false;
    let watcher: FsPathWatcher;
    try {
      watcher = FsPathWatcher.attach(path, emit, this.debounceMs);
    } catch {
      return false;
    }
    set.set(path, watcher);
    return true;
  }

  unwatch(key: object, path: string): boolean {
    const set = this.bySocket.get(key);
    if (!set) return false;
    const watcher = set.get(path);
    if (!watcher) return false;
    watcher.close();
    set.delete(path);
    if (set.size === 0) this.bySocket.delete(key);
    return true;
  }

  /** Everything this connection watched is stopped: the socket is gone. */
  drop(key: object): void {
    const set = this.bySocket.get(key);
    if (!set) return;
    for (const watcher of set.values()) watcher.close();
    this.bySocket.delete(key);
  }

  /** For tests and shutdown. */
  clear(): void {
    for (const key of [...this.bySocket.keys()]) this.drop(key);
  }

  count(key: object): number {
    return this.bySocket.get(key)?.size ?? 0;
  }
}

/**
 * One watched path, one debounced push.
 *
 * Two inotify watches per path, deliberately. A self-watch alone is blind to the two operations
 * this feature exists for: an atomic write replaces the watched inode (temp + rename) and Bun
 * reports nothing for it, and a plain unlink of a watched file produces no event at all; the
 * parent directory carries both. A parent watch alone would miss everything happening inside a
 * watched directory, hence the second. Events within one debounce window are one push, and the
 * stat at push time sees the latest state either way.
 */
export class FsPathWatcher {
  private readonly self: FSWatcher;
  private readonly parent: FSWatcher | null;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly emit: (change: FsChangeEvent) => void,
    private readonly debounceMs: number,
    self: FSWatcher,
    parent: FSWatcher | null,
  ) {
    this.self = self;
    this.parent = parent;
  }

  static attach(path: string, emit: (change: FsChangeEvent) => void, debounceMs = FS_WATCH_DEBOUNCE_MS): FsPathWatcher {
    const name = basename(path);
    let watcher: FsPathWatcher | undefined;
    const tick = () => watcher?.tick();
    const self = watchQuiet(path, "fs.watch", () => tick());
    let parent: FSWatcher | null = null;
    try {
      parent = watchQuiet(dirname(path), "fs.watch", (_event, filename) => {
        if (filename === null || filename === name) tick();
      });
    } catch (err) {
      self.close();
      throw err;
    }
    watcher = new FsPathWatcher(path, emit, debounceMs, self, parent);
    return watcher;
  }

  private tick(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.emitChange();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private async emitChange(): Promise<void> {
    if (this.closed) return;
    try {
      const st = await stat(this.path);
      this.emit({ kind: "changed", size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      this.emit({ kind: "removed", size: 0, mtimeMs: 0 });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.self.close();
    this.parent?.close();
  }
}
