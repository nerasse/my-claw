/**
 * A folder as a ZIP, written while it is sent: nothing is staged on disk and no file is held in
 * memory whole. No dependency and no `zip` binary, which a compose image or another distribution
 * may not have -- docs/system-files.md.
 *
 * Plain ZIP, not ZIP64: every size and offset fits 32 bits, so `zipPlan` refuses a folder that
 * could not, rather than send an archive that opens corrupt. Each file is deflated through a data
 * descriptor (its CRC and sizes follow its bytes), which is what lets it stream.
 */

import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw } from "node:zlib";

export interface ZipItem {
  /** Absolute path on disk. */
  path: string;
  /** Path inside the archive, `/`-separated; a folder ends with `/`. */
  name: string;
  dir: boolean;
  size: number;
  mode: number;
  mtime: Date;
}

/** Room left under 4 GiB for headers and for deflate's worst case on data that will not shrink. */
export const ZIP_MAX_BYTES = 3.5 * 1024 ** 3;
export const ZIP_MAX_ENTRIES = 65_535;

/**
 * What the archive will hold: the folder itself, everything under it, regular files and folders
 * only. A symlink is left out rather than followed, so a link to `/` or to its own parent cannot
 * turn one download into the whole disk.
 */
export async function zipPlan(
  root: string,
  limits = { bytes: ZIP_MAX_BYTES, entries: ZIP_MAX_ENTRIES },
): Promise<{ items: ZipItem[] } | { refused: string }> {
  const items: ZipItem[] = [];
  let bytes = 0;
  const top = root.split(sep).filter(Boolean).at(-1) ?? "folder";
  const walk = async (dir: string): Promise<string | undefined> => {
    const st = await lstat(dir);
    items.push({ path: dir, name: `${archiveName(top, root, dir)}/`, dir: true, size: 0, mode: st.mode, mtime: st.mtime });
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const entry = await lstat(path).catch(() => null);
      if (!entry) continue;
      if (entry.isDirectory()) {
        const refused = await walk(path);
        if (refused) return refused;
      } else if (entry.isFile()) {
        bytes += entry.size;
        items.push({ path, name: archiveName(top, root, path), dir: false, size: entry.size, mode: entry.mode, mtime: entry.mtime });
      }
      if (items.length > limits.entries) return `more than ${limits.entries} files and folders`;
      if (bytes > limits.bytes) return `more than ${(limits.bytes / 1024 ** 3).toFixed(1)} GB`;
    }
    return undefined;
  };
  const refused = await walk(root);
  return refused ? { refused } : { items };
}

function archiveName(top: string, root: string, path: string): string {
  const rel = relative(root, path).split(sep).filter(Boolean);
  return [top, ...rel].join("/");
}

/** The archive of a plan, as a stream of bytes. */
export function zipStream(items: ZipItem[]): ReadableStream<Uint8Array> {
  const parts = archive(items);
  return new ReadableStream({
    async pull(controller) {
      const next = await parts.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await parts.return(undefined);
    },
  });
}

const UTF8 = 0x0800;
const DESCRIPTOR = 0x0008;
const DEFLATE = 8;
/** Made by Unix (3), spec 2.0: what makes an unzipper read the mode in the external attributes. */
const MADE_BY = (3 << 8) | 20;

async function* archive(items: ZipItem[]): AsyncGenerator<Uint8Array> {
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, "utf8");
    const { time, date } = dosTime(item.mtime);
    const flags = item.dir ? UTF8 : UTF8 | DESCRIPTOR;
    const method = item.dir ? 0 : DEFLATE;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    yield local;
    yield name;
    let crc = 0;
    let raw = 0;
    let packed = 0;
    if (!item.dir) {
      const deflate = createDeflateRaw();
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          crc = crc32(chunk, crc);
          raw += chunk.length;
          done(null, chunk);
        },
      });
      // A read error destroys the deflate stream, which ends the loop below with that error.
      const piped = pipeline(createReadStream(item.path), counted, deflate);
      for await (const chunk of deflate as AsyncIterable<Buffer>) {
        packed += chunk.length;
        yield chunk;
      }
      await piped;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc >>> 0, 4);
      descriptor.writeUInt32LE(packed, 8);
      descriptor.writeUInt32LE(raw, 12);
      yield descriptor;
    }
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(MADE_BY, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc >>> 0, 16);
    entry.writeUInt32LE(packed, 20);
    entry.writeUInt32LE(raw, 24);
    entry.writeUInt16LE(name.length, 28);
    // The Unix mode in the high half, and the DOS directory bit for the readers that only know it.
    entry.writeUInt32LE((((item.mode & 0xffff) << 16) | (item.dir ? 0x10 : 0)) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + (item.dir ? 0 : packed + 16);
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  for (const part of central) yield part;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}

/** DOS time has two-second steps and starts in 1980; earlier dates are clamped to it. */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.max(at.getFullYear(), 1980);
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}
