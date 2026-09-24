/**
 * Reading a ZIP without unpacking it -- the entry list of an archive, and the one part of an
 * Office document its text lives in. Both are ZIPs, and the runtime's inflate is all it takes.
 */
import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findZipEntry, listZipEntries, readZipEntry } from "../../src/utils/archive.ts";
import { buildZip } from "../helpers/zip.ts";

async function write(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zip-"));
  const path = join(dir, "archive.zip");
  await writeFile(path, bytes);
  return path;
}

describe("a ZIP is read without being unpacked", () => {
  test("lists every entry, stored and deflated alike", async () => {
    const xml = Buffer.from("<w:t>a longer part</w:t>");
    const path = await write(
      buildZip([
        { name: "readme.txt", data: Buffer.from("hello"), deflate: false },
        { name: "word/document.xml", data: xml, deflate: true },
      ]),
    );
    const entries = await listZipEntries(path);
    expect(entries.map((entry) => entry.name)).toEqual(["readme.txt", "word/document.xml"]);
    expect(entries[0]).toMatchObject({ method: 0, size: 5 });
    expect(entries[1]).toMatchObject({ method: 8, size: xml.length });
  });

  test("reads one entry by its own offset, stored or deflated", async () => {
    const path = await write(
      buildZip([
        { name: "a.txt", data: Buffer.from("first"), deflate: false },
        { name: "nested/b.txt", data: Buffer.from("second entry, deflated"), deflate: true },
      ]),
    );
    const entries = await listZipEntries(path);
    const stored = findZipEntry(entries, "a.txt")!;
    const deflated = findZipEntry(entries, "nested/b.txt")!;
    expect((await readZipEntry(path, stored))?.toString("utf8")).toBe("first");
    expect((await readZipEntry(path, deflated))?.toString("utf8")).toBe("second entry, deflated");
  });

  test("a file that is not an archive lists nothing, and a missing entry is not invented", async () => {
    const path = await write(Buffer.from("%PDF-1.7 not a zip at all, really"));
    expect(await listZipEntries(path)).toEqual([]);
    const entries = await listZipEntries(await write(buildZip([{ name: "only.txt", data: Buffer.from("x"), deflate: false }])));
    expect(findZipEntry(entries, "absent.txt")).toBeUndefined();
  });

  test("an entry that does not inflate, or uses a method we do not know, comes back null", async () => {
    const path = await write(
      buildZip([{ name: "broken.xml", data: Buffer.from("this is not deflate data at all"), deflate: true }]),
    );
    const entries = await listZipEntries(path);
    // The stored bytes are not deflate: the reader answers nothing rather than throwing.
    expect(await readZipEntry(path, { ...entries[0]!, method: 8, compressedSize: 4 })).toBeNull();
    // Method 12 is bzip2, which nothing here claims to understand.
    expect(await readZipEntry(path, { ...entries[0]!, method: 12 })).toBeNull();
  });
});
