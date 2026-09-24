/**
 * Reading a ZIP without unpacking it, and without a dependency.
 *
 * An Office document is a ZIP, and an archive is a ZIP, so one reader answers both: the entry
 * list of an archive, and the one XML part a document's text lives in. The runtime already has
 * inflate (`node:zlib`), and a ZIP is a central directory plus that, so nothing is added to
 * `package.json` for it -- docs/file-preview.md.
 *
 * Nothing is ever unpacked to disk and nothing is read whole: the central directory is at the end
 * of the file, and each entry is fetched by its own offset. A 2 GB archive costs a few kilobytes
 * of reads to list, and one entry's compressed size to read.
 *
 * ZIP64 (a size or offset of `0xFFFFFFFF`) is refused rather than guessed at: the fields move, and
 * a wrong offset is a wrong file.
 */

import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Slash-separated, as the archive stores it. */
  name: string;
  /** 0 stored, 8 deflate. Anything else is refused at read time. */
  method: number;
  compressedSize: number;
  size: number;
  /** Where the local header starts. */
  headerOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** The comment can be 64 KiB, so the record can sit that far from the end. */
const EOCD_MAX_SIZE = EOCD_MIN_SIZE + 0xffff;
const ZIP64_SENTINEL = 0xffffffff;

/** One entry, as the central directory describes it. */
function parseCentralEntry(view: Buffer, at: number): ZipEntry | null {
  if (view.readUInt32LE(at) !== CENTRAL_SIGNATURE) return null;
  const method = view.readUInt16LE(at + 10);
  const compressedSize = view.readUInt32LE(at + 20);
  const size = view.readUInt32LE(at + 24);
  const nameLength = view.readUInt16LE(at + 28);
  const headerOffset = view.readUInt32LE(at + 42);
  if (compressedSize === ZIP64_SENTINEL || size === ZIP64_SENTINEL || headerOffset === ZIP64_SENTINEL) {
    return null;
  }
  return {
    name: view.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
    method,
    compressedSize,
    size,
    headerOffset,
  };
}

/** The whole central record, so the caller advances by it and not by the name. */
function recordLengthOf(view: Buffer, at: number): number {
  return 46 + view.readUInt16LE(at + 28) + view.readUInt16LE(at + 30) + view.readUInt16LE(at + 32);
}

/** Every entry the archive holds, in the order the central directory lists them. */
export async function listZipEntries(path: string): Promise<ZipEntry[]> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size < EOCD_MIN_SIZE) return [];
    const tailLength = Math.min(size, EOCD_MAX_SIZE);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let at = tail.length - EOCD_MIN_SIZE; at >= 0; at--) {
      if (tail.readUInt32LE(at) === EOCD_SIGNATURE) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) return [];
    const total = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (total === 0xffff || centralSize === ZIP64_SENTINEL || centralOffset === ZIP64_SENTINEL) return [];

    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);
    const entries: ZipEntry[] = [];
    let at = 0;
    while (at + 46 <= central.length) {
      const entry = parseCentralEntry(central, at);
      if (!entry) break;
      const length = recordLengthOf(central, at);
      if (length <= 0) break;
      entries.push(entry);
      at += length;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** One entry's bytes, inflated if it was deflated. `null` when the archive lies about it. */
export async function readZipEntry(path: string, entry: ZipEntry): Promise<Buffer | null> {
  if (entry.method !== 0 && entry.method !== 8) return null;
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.headerOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) return null;
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const start = entry.headerOffset + 30 + nameLength + extraLength;
    const raw = Buffer.alloc(entry.compressedSize);
    await handle.read(raw, 0, entry.compressedSize, start);
    if (entry.method === 0) return raw;
    return inflateRawSync(raw);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** The entry whose name matches, case-insensitively; the first one wins. */
export function findZipEntry(entries: readonly ZipEntry[], name: string): ZipEntry | undefined {
  const wanted = name.toLowerCase();
  return entries.find((entry) => entry.name.toLowerCase() === wanted);
}
