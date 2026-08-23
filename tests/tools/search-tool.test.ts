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
    const result = await searchTool.execute({ pattern: "beta", path: join(dir, "data.txt"), mode: "content" });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("beta"));
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: context lines come back around the hit", async () => {
  const dir = await fixture();
  try {
    const result = await searchTool.execute({ pattern: "beta", path: join(dir, "sub", "notes.md"), context: 1, mode: "content" });
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
    assert.ok(result.output.includes("No files matching"));
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: a miss names what was searched, so a repeat is visible as a repeat", async () => {
  const dir = await fixture();
  try {
    const result = await searchTool.execute({ pattern: "zzzzz", path: dir });
    assert.equal(result.success, true);
    assert.ok(result.output.includes("No matches"));
    assert.ok(result.output.includes("zzzzz"), "the pattern is in the message");
    assert.ok(result.output.includes(dir), "and so is the path");
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

test("search: an invalid regex fails loudly and names the dialect", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "d2.txt");
  await writeFile(file, "hello\n");
  // Unbalanced parenthesis: invalid in ERE, so grep exits >= 2.
  const result = await searchTool.execute({ pattern: "a(b", path: file, __workspaceDir: TMP });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Unmatched/i);
  // The measured loop was thirteen identical failures in one run: the message said which
  // character was wrong but never which flavour of regex the tool speaks.
  assert.match(result.error ?? "", /extended regex|ERE/i);
  assert.match(result.error ?? "", /a\(b/, "and it quotes the pattern back");
  await rm(TMP, { recursive: true, force: true });
});

test("search: alternation works, because this tool is ERE and not BRE", async () => {
  const dir = await fixture();
  try {
    // Under plain grep this returned exit 1 -- "no matches" on a file containing both words.
    const result = await searchTool.execute({ pattern: "(alpha|gamma)", path: join(dir, "data.txt"), mode: "content" });
    assert.equal(result.success, true);
    assert.match(result.output, /alpha/);
    assert.match(result.output, /gamma/);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: +, ? and {n,m} are operators, not literal characters", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "d4.txt");
  await writeFile(file, "aaa\nbc\n");
  const result = await searchTool.execute({ pattern: "a{2,3}", path: file, __workspaceDir: TMP, mode: "content" });
  assert.equal(result.success, true);
  assert.match(result.output, /aaa/);
  await rm(TMP, { recursive: true, force: true });
});

test("search: a pattern starting with a dash is not parsed as a flag", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "d3.txt");
  await writeFile(file, "-v is here\nother\n");
  const result = await searchTool.execute({ pattern: "-v", path: file, __workspaceDir: TMP, mode: "content" });
  assert.equal(result.success, true);
  assert.match(result.output, /-v is here/);
  await rm(TMP, { recursive: true, force: true });
});

/**
 * The default was `content`, and it is the reason one measured sub-agent run made 304 tool calls
 * for 3.4M characters of output: `filesOnly` existed but was opt-in and went unused 256 times out
 * of 256. Claude Code defaults its Grep to `files_with_matches` for exactly this reason.
 */
test("search: the default mode is files, not the matching lines", async () => {
  const dir = await fixture();
  try {
    const result = await searchTool.execute({ pattern: "beta", path: dir });
    assert.equal(result.success, true);
    assert.match(result.output, /file\(s\) contain/, "counts files");
    assert.ok(result.output.includes("data.txt"), "names the file");
    assert.doesNotMatch(result.output, /Line 2|:2:/, "and does not carry the line itself");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: every mode leads with a count, so a partial answer is visible as partial", async () => {
  const dir = await fixture();
  try {
    const files = await searchTool.execute({ pattern: "beta", path: dir });
    const count = await searchTool.execute({ pattern: "beta", path: dir, mode: "count" });
    const content = await searchTool.execute({ pattern: "beta", path: dir, mode: "content" });
    assert.match(files.output, /^2 file\(s\) contain/);
    assert.match(count.output, /^2 match\(es\) in 2 file\(s\)/);
    assert.match(content.output, /^2 matching line\(s\)/);
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});

test("search: past the limit the result says so and says what to do", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "many.txt");
  await writeFile(file, Array.from({ length: 40 }, (_, i) => `hit ${i}`).join("\n"));
  const result = await searchTool.execute({ pattern: "hit", path: file, __workspaceDir: TMP, mode: "content", limit: 5 });
  assert.match(result.output, /^40 matching line\(s\)/, "the true total, not the shown count");
  assert.match(result.output, /showing the first 5 of 40/);
  assert.match(result.output, /narrow the pattern/, "and how to recover");
  await rm(TMP, { recursive: true, force: true });
});

test("search: a minified line cannot become the whole result", async () => {
  await mkdir(TMP, { recursive: true });
  const file = join(TMP, "bundle.js");
  await writeFile(file, `var x="${"z".repeat(5000)}";\n`);
  const result = await searchTool.execute({ pattern: "var x", path: file, __workspaceDir: TMP, mode: "content" });
  assert.ok(result.output.length < 1000, `line clipped (${result.output.length} chars)`);
  assert.match(result.output, /line truncated/);
  await rm(TMP, { recursive: true, force: true });
});

test("search: context is ignored outside content mode rather than silently dropped by grep", async () => {
  const dir = await fixture();
  try {
    // grep drops -C beside -l; a model that believes it asked for context would read a partial
    // answer as a complete one. The files mode simply never claims to carry lines.
    const result = await searchTool.execute({ pattern: "beta", path: dir, context: 3 });
    assert.match(result.output, /file\(s\) contain/);
    assert.doesNotMatch(result.output, /one|three/, "no surrounding lines leaked in");
  } finally {
    await rm(TMP, { recursive: true, force: true });
  }
});
