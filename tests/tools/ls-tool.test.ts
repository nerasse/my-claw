import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { lsTool } from "../../src/tools/ls.ts";

// A fixed path under the shared /tmp is one directory for every process on the machine:
// two concurrent runs (two CI jobs on one runner) delete each other's fixtures mid-test.
const TMP = mkdtempSync(join(tmpdir(), "my-claw-ls-"));

test("ls: lists files and subdirs with f and d prefixes", async () => {
  await mkdir(join(TMP, "subdir"), { recursive: true });
  await writeFile(join(TMP, "file.txt"), "data");
  try {
    const result = await lsTool.execute({ path: TMP });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("d subdir"));
    assert.ok(result.output.includes("f file.txt"));
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("ls: empty directory returns '(empty directory)'", async () => {
  await mkdir(TMP, { recursive: true });
  try {
    const result = await lsTool.execute({ path: TMP });
    assert.equal(result.success, true);
    assert.equal(result.output, "(empty directory)");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("ls: non-existent directory returns not found", async () => {
  const result = await lsTool.execute({ path: "/tmp/opencode/my-claw-tests/ls/no-exist" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("not found"));
});

test("ls: empty path returns success false", async () => {
  const result = await lsTool.execute({ path: "" });
  assert.equal(result.success, false);
});
