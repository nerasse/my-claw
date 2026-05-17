import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeTool } from "../../src/tools/write.ts";

const TMP = "/tmp/opencode/my-claw-tests/write";

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

test("write: overwrites existing file", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "overwrite.txt");
  try {
    await writeTool.execute({ path: file, content: "first" });
    await writeTool.execute({ path: file, content: "second" });
    const content = await readFile(file, "utf-8");
    assert.equal(content, "second");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});
