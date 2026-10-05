import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { zipPlan, zipStream } from "../../src/utils/zip-stream.ts";

/**
 * A folder as a ZIP, read back here with nothing but the format: the central directory, each
 * local entry, inflate and the CRC. What the archive claims is checked against what it holds.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "zip-stream-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Read {
  name: string;
  data: Buffer;
  mode: number;
}

function readZip(zip: Buffer): Read[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(-1);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  expect(at + zip.readUInt32LE(end + 12)).toBe(end);
  const out: Read[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(start, start + packed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(size);
    expect(crc32(data) >>> 0).toBe(crc);
    out.push({ name, data, mode });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return out;
}

async function zipOf(dir: string): Promise<Buffer> {
  const plan = await zipPlan(dir);
  if ("refused" in plan) throw new Error(plan.refused);
  return Buffer.from(await new Response(zipStream(plan.items)).arrayBuffer());
}

test("a folder comes back whole: nested files, an empty folder, accents, binary bytes and modes", async () => {
  const root = join(temp(), "projet");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "vide"));
  writeFileSync(join(root, "résumé.txt"), "bonjour\n");
  const binary = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 256));
  writeFileSync(join(root, "src", "deep", "blob.bin"), binary);
  writeFileSync(join(root, "run.sh"), "#!/bin/sh\necho ok\n");
  chmodSync(join(root, "run.sh"), 0o755);

  const read = readZip(await zipOf(root));
  expect(read.map((e) => e.name)).toEqual([
    "projet/",
    "projet/run.sh",
    "projet/résumé.txt",
    "projet/src/",
    "projet/src/deep/",
    "projet/src/deep/blob.bin",
    "projet/vide/",
  ]);
  const byName = new Map(read.map((e) => [e.name, e]));
  expect(byName.get("projet/résumé.txt")!.data.toString()).toBe("bonjour\n");
  expect(byName.get("projet/src/deep/blob.bin")!.data.equals(binary)).toBe(true);
  expect(byName.get("projet/run.sh")!.mode & 0o777).toBe(0o755);
  expect(byName.get("projet/vide/")!.mode & 0o170000).toBe(0o040000);
});

test("a symlink is left out, so a link to / cannot pull the whole disk in", async () => {
  const root = join(temp(), "links");
  mkdirSync(root);
  writeFileSync(join(root, "real.txt"), "x");
  symlinkSync("/", join(root, "everything"));
  symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));
  expect(readZip(await zipOf(root)).map((e) => e.name)).toEqual(["links/", "links/real.txt"]);
});

test("a folder that would not fit a plain ZIP is refused before a byte is sent", async () => {
  const root = join(temp(), "big");
  mkdirSync(root);
  writeFileSync(join(root, "a"), "12345");
  writeFileSync(join(root, "b"), "12345");
  expect(await zipPlan(root, { bytes: 9, entries: 100 })).toEqual({ refused: "more than 0.0 GB" });
  expect(await zipPlan(root, { bytes: 100, entries: 2 })).toEqual({ refused: "more than 2 files and folders" });
  expect("items" in (await zipPlan(root, { bytes: 10, entries: 3 }))).toBe(true);
});
