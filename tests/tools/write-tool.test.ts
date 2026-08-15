import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeTool } from "../../src/tools/write.ts";

// A fixed path under the shared /tmp is one directory for every process on the machine:
// two concurrent runs (two CI jobs on one runner) delete each other's fixtures mid-test.
const TMP = mkdtempSync(join(tmpdir(), "my-claw-write-"));

test("write: writes file and verifies content", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "out.txt");
  try {
    const result = await writeTool.execute({ path: file, content: "hello world" });
    assert.equal(result.success, true);
    const content = await readFile(file, "utf-8");
    assert.equal(content, "hello world");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("write: creates parent directories automatically", async () => {
  const nested = join(TMP, "a", "b", "c", "deep.txt");
  try {
    const result = await writeTool.execute({ path: nested, content: "nested" });
    assert.equal(result.success, true);
    const content = await readFile(nested, "utf-8");
    assert.equal(content, "nested");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("write: empty path returns success false", async () => {
  const result = await writeTool.execute({ path: "", content: "data" });
  assert.equal(result.success, false);
});

test("write: an existing file is refused and the model is sent to apply_patch", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "overwrite.txt");
  try {
    await writeTool.execute({ path: file, content: "first" });
    // Re-emitting a whole file to change three lines is how the rest of it silently disappears.
    const refused = await writeTool.execute({ path: file, content: "second" });
    assert.equal(refused.success, false);
    assert.match(refused.error ?? "", /apply_patch/);
    assert.equal(await readFile(file, "utf-8"), "first");

    const forced = await writeTool.execute({ path: file, content: "second", overwrite: true });
    assert.equal(forced.success, true);
    assert.equal(await readFile(file, "utf-8"), "second");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});
