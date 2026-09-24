/**
 * A real ZIP file, built by hand so a test depends on the format and not on a zipper.
 *
 * The CRC is left at zero on purpose: the reader under test never checks it, and a test that had
 * to compute one would be testing the helper.
 */
import { deflateRawSync } from "node:zlib";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function buildZip(entries: Array<{ name: string; data: Buffer; deflate: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  chunks.push(...locals);
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  chunks.push(...centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

/** Writes those bytes to a throwaway file and answers its path. */
export async function writeZipFile(entries: Array<{ name: string; data: Buffer; deflate: boolean }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zip-"));
  const path = join(dir, "document");
  await writeFile(path, buildZip(entries));
  return path;
}

/** Shorthand for a document part, deflated the way a real writer stores it. */
export function part(name: string, xml: string): { name: string; data: Buffer; deflate: boolean } {
  return { name, data: Buffer.from(xml, "utf8"), deflate: true };
}
