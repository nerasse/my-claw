import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { readTool } from "../../src/tools/read.ts";

const TMP = "/tmp/opencode/my-claw-tests/read";

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

test("read: reads file with absolute path ignoring workspaceDir", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "abs.txt");
  await writeFile(file, "absolute path content");
  try {
    const result = await readTool.execute({ path: file, __workspaceDir: "/some/other/dir" });
    assert.equal(result.success, true);
    assert.equal(result.output, "absolute path content");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});
