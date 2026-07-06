import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { grepTool } from "../../src/tools/grep.ts";

const TMP = "/tmp/opencode/my-claw-tests/grep";

test("grep: finds pattern in file", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "data.txt");
  await writeFile(file, "alpha\nbeta\ngamma\n");
  try {
    const result = await grepTool.execute({ pattern: "beta", path: file });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("beta"));
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("grep: no matches returns 'No matches found'", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "data.txt");
  await writeFile(file, "alpha\nbeta\ngamma\n");
  try {
    const result = await grepTool.execute({ pattern: "zzzzz", path: file });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("No matches found"));
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("grep: empty pattern returns success false", async () => {
  const result = await grepTool.execute({ pattern: "", path: "/tmp" });
  assert.equal(result.success, false);
});

test("grep: empty path returns success false", async () => {
  const result = await grepTool.execute({ pattern: "foo", path: "" });
  assert.equal(result.success, false);
});

test("grep: non-existent path returns not found", async () => {
  const result = await grepTool.execute({ pattern: "foo", path: "/tmp/opencode/my-claw-tests/grep/no-exist" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("not found"));
});

test("grep: invalid regex reports failure instead of 'No matches found'", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "d2.txt");
  await writeFile(file, "hello\n");
  // Unbalanced parenthesis is an invalid BRE/ERE -> grep exits >=2.
  const result = await grepTool.execute({ pattern: "a\\(b", path: file, __workspaceDir: TMP });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /grep failed/i);
  await rm(TMP, { recursive: true, force: true });
});

test("grep: pattern starting with dash is not parsed as a flag", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "d3.txt");
  await writeFile(file, "-v is here\nother\n");
  const result = await grepTool.execute({ pattern: "-v", path: file, __workspaceDir: TMP });
  assert.equal(result.success, true);
  assert.match(result.output, /-v is here/);
  await rm(TMP, { recursive: true, force: true });
});
