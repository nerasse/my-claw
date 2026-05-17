import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { findTool } from "../../src/tools/find.ts";

const TMP = "/tmp/opencode/my-claw-tests/find";

test("find: finds file by name pattern", async () => {
  await mkdir(TMP, { recursive: true });
  await writeFile(join(TMP, "target.txt"), "content");
  try {
    const result = await findTool.execute({ path: TMP, pattern: "target.txt" });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("target.txt"));
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("find: no matches returns 'No files found'", async () => {
  await mkdir(TMP, { recursive: true });
  try {
    const result = await findTool.execute({ path: TMP, pattern: "nonexistent-xyz.log" });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("No files found"));
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("find: empty path returns success false", async () => {
  const result = await findTool.execute({ path: "", pattern: "*.txt" });
  assert.equal(result.success, false);
});

test("find: empty pattern returns success false", async () => {
  const result = await findTool.execute({ path: "/tmp", pattern: "" });
  assert.equal(result.success, false);
});

test("find: non-existent directory returns not found", async () => {
  const result = await findTool.execute({ path: "/tmp/opencode/my-claw-tests/find/no-exist", pattern: "*.txt" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("not found"));
});
