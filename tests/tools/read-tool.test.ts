import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { readTool } from "../../src/tools/read.ts";

// A fixed path under the shared /tmp is one directory for every process on the machine:
// two concurrent runs (two CI jobs on one runner) delete each other's fixtures mid-test.
const TMP = mkdtempSync(join(tmpdir(), "my-claw-read-"));

test("read: reads existing file content", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "sample.txt");
  await writeFile(file, "expected content");
  try {
    const result = await readTool.execute({ path: file });
    assert.equal(result.success, true);
    assert.equal(result.output, "expected content");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("read: non-existent file returns success false", async () => {
  const result = await readTool.execute({ path: "/tmp/opencode/my-claw-tests/read/no-such-file.txt" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("not found"));
});

test("read: nonexistent relative path returns not found", async () => {
  const result = await readTool.execute({
    path: "does-not-exist.txt",
    __workspaceDir: "/tmp/opencode/my-claw-tests/read-missing",
  });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("not found"));
});

test("read: an absolute path outside workspaceDir is read as asked", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "abs.txt");
  await writeFile(file, "absolute path content");
  try {
    const result = await readTool.execute({ path: file, __workspaceDir: "/some/other/dir" });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("absolute path content"));
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("read: caps output at 100KB with a truncation notice", async () => {
  const { readTool } = await import("../../src/tools/read.ts");
  const { writeFile, mkdir, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "my-claw-read-cap-"));
  await mkdir(dir, { recursive: true });
  const file = join(dir, "big.txt");
  await writeFile(file, "x".repeat(250_000));
  const result = await readTool.execute({ path: file, __workspaceDir: dir });
  assert.equal(result.success, true);
  assert.ok(result.output.length < 250_000, "output should be capped");
  assert.match(result.output, /truncated at 100000 chars/);
  await rm(dir, { recursive: true, force: true });
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("read: an image returns itself as an attachment, sniffed by magic bytes", async () => {
  await mkdir(TMP, { recursive: true });
  // No extension anywhere: a screenshot under a generated name is still an image, and the bytes
  // are the only honest witness. The model gets the image itself, not mojibake from a utf-8 read.
  const file = join(TMP, "shot-100037562");
  await writeFile(file, PNG);
  try {
    const result = await readTool.execute({ path: file });
    assert.equal(result.success, true);
    assert.ok(result.output.startsWith("Image read successfully:"), result.output);
    assert.deepEqual(result.attachments, [{ type: "image", path: file, mimeType: "image/png" }]);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("read: a text file named .png is read as text -- the magic bytes decide", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "notes.png");
  await writeFile(file, "planning notes, not a picture");
  try {
    const result = await readTool.execute({ path: file });
    assert.equal(result.success, true);
    assert.equal(result.output, "planning notes, not a picture");
    assert.equal(result.attachments, undefined);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("read: a jpeg is sniffed too, and named as its real mime", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "photo.bin");
  await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]));
  try {
    const result = await readTool.execute({ path: file });
    assert.equal(result.success, true);
    assert.deepEqual(result.attachments, [{ type: "image", path: file, mimeType: "image/jpeg" }]);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("read: a binary that is no image is refused in words", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "archive.zip");
  await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]));
  try {
    const result = await readTool.execute({ path: file });
    assert.equal(result.success, false);
    assert.ok(result.output.includes("Binary file"), result.output);
    assert.equal(result.attachments, undefined);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});
