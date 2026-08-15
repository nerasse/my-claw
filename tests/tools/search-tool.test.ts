import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { searchTool } from "../../src/tools/search.ts";

// A fixed path under the shared /tmp is one directory for every process on the machine:
// two concurrent runs (two CI jobs on one runner) delete each other's fixtures mid-test.
const TMP = mkdtempSync(join(tmpdir(), "my-claw-search-"));

async function fixture(): Promise<string> {
  await mkdir(join(TMP, "sub"), { recursive: true });
  await writeFile(join(TMP, "data.txt"), "alpha\nbeta\ngamma\n");
  await writeFile(join(TMP, "sub", "notes.md"), "one\nbeta\nthree\nfour\n");
  return TMP;
}

test("search: finds a pattern in a file", async () => {
  const dir = await fixture();
  try {
    const result = await searchTool.execute({ pattern: "beta", path: join(dir, "data.txt") });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("beta"));
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: context lines come back around the hit", async () => {
  const dir = await fixture();
  try {
    const result = await searchTool.execute({ pattern: "beta", path: join(dir, "sub", "notes.md"), context: 1 });
    assert.equal(result.success, true);
    // The reason this tool exists next to bash: a hit without its surroundings sends the model
    // back for a second read of the same file.
    assert.match(result.output, /one/);
    assert.match(result.output, /three/);
    assert.doesNotMatch(result.output, /four/);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: filesOnly reports paths, not lines", async () => {
  const dir = await fixture();
  try {
    const result = await searchTool.execute({ pattern: "beta", path: dir, filesOnly: true });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("data.txt"));
    assert.doesNotMatch(result.output, /alpha/);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: a glob narrows a content search", async () => {
  const dir = await fixture();
  try {
    const result = await searchTool.execute({ pattern: "beta", path: dir, glob: "*.md" });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("notes.md"));
    assert.doesNotMatch(result.output, /data\.txt/);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: a glob alone lists files by name", async () => {
  const dir = await fixture();
  try {
    const result = await searchTool.execute({ path: dir, glob: "*.md" });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("notes.md"));
    assert.doesNotMatch(result.output, /data\.txt/);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: a name search with no hit says so instead of failing", async () => {
  const dir = await fixture();
  try {
    const result = await searchTool.execute({ path: dir, glob: "nonexistent-xyz.log" });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("No files found"));
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: no matches returns 'No matches found'", async () => {
  const dir = await fixture();
  try {
    const result = await searchTool.execute({ pattern: "zzzzz", path: dir });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("No matches found"));
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: neither a pattern nor a glob is refused", async () => {
  const result = await searchTool.execute({ path: "/tmp" });
  assert.equal(result.success, false);
  assert.match(result.output, /pattern .* or glob/i);
});

test("search: empty path returns success false", async () => {
  const result = await searchTool.execute({ pattern: "foo", path: "" });
  assert.equal(result.success, false);
});

test("search: non-existent path returns not found", async () => {
  const result = await searchTool.execute({ pattern: "foo", path: "/tmp/my-claw-tests/search/no-exist" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("not found"));
});

test("search: invalid regex reports failure instead of 'No matches found'", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "d2.txt");
  await writeFile(file, "hello\n");
  // Unbalanced parenthesis is an invalid BRE/ERE -> grep exits >=2.
  const result = await searchTool.execute({ pattern: "a\\(b", path: file, __workspaceDir: TMP });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /grep failed/i);
  await rm(TMP, { recursive: true, force: true });
});

test("search: a pattern starting with a dash is not parsed as a flag", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "d3.txt");
  await writeFile(file, "-v is here\nother\n");
  const result = await searchTool.execute({ pattern: "-v", path: file, __workspaceDir: TMP });
  assert.equal(result.success, true);
  assert.match(result.output, /-v is here/);
  await rm(TMP, { recursive: true, force: true });
});
