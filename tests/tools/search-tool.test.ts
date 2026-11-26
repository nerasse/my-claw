import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { searchTool } from "../../src/tools/search.ts";
import { expandBraces, joinBatch, executeQuery, MAX_COLLECTED_LINES, type SearchQuery } from "../../src/tools/search-core.ts";
import { AbortedError } from "../../src/core/aborted.ts";

// A fixed path under the shared /tmp is one directory for every process on the machine:
// two concurrent runs (two CI jobs on one runner) delete each other's fixtures mid-test.
const TMP = mkdtempSync(join(tmpdir(), "my-claw-search-"));
/** Resolved per test: MY_CLAW_SEARCH_ENGINE=grep forces the fallback even where rg exists. */
const rgActive = () => Bun.which("rg") !== null && process.env["MY_CLAW_SEARCH_ENGINE"] !== "grep";

async function fixture(): Promise<string> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(join(TMP, "sub"), { recursive: true });
  await mkdir(join(TMP, "src"), { recursive: true });
  await mkdir(join(TMP, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(TMP, ".hidden"), { recursive: true });
  await writeFile(join(TMP, "data.txt"), "alpha\nbeta\ngamma\n");
  await writeFile(join(TMP, "sub", "notes.md"), "one\nbeta\nthree\nfour\n");
  await writeFile(join(TMP, "src", "a.ts"), "let beta = 1;\n");
  await writeFile(join(TMP, "src", "b.md"), "# beta\n");
  await writeFile(join(TMP, "node_modules", "pkg", "dep.ts"), "beta dependency\n");
  await writeFile(join(TMP, ".hidden", "secret.ts"), "beta hidden\n");
  return TMP;
}

/** The grep fallback is a real configuration (a machine without ripgrep); its banner prefixes
 *  every result, so a "leads with the count" assertion reads under it. */
async function withFallback<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env["MY_CLAW_SEARCH_ENGINE"];
  process.env["MY_CLAW_SEARCH_ENGINE"] = "grep";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env["MY_CLAW_SEARCH_ENGINE"];
    else process.env["MY_CLAW_SEARCH_ENGINE"] = previous;
  }
}

const underBanner = (output: string) => output.replace(/^\[engine: grep fallback[^\n]*\]\n/, "");

test("search: finds a pattern in a file", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", path: join(dir, "data.txt"), mode: "content" });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("beta"));
});

test("search: context lines come back around the hit", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", path: join(dir, "sub", "notes.md"), context: 1, mode: "content" });
  assert.equal(result.success, true);
  // The reason this tool exists next to bash: a hit without its surroundings sends the model
  // back for a second read of the same file.
  assert.match(result.output, /one/);
  assert.match(result.output, /three/);
  assert.doesNotMatch(result.output, /four/);
});

test("search: after gives the asymmetric block", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", path: join(dir, "sub", "notes.md"), after: 2, mode: "content" });
  assert.equal(result.success, true);
  assert.match(result.output, /three/);
  assert.match(result.output, /four/);
  assert.doesNotMatch(result.output, /one/);
});

test("search: context and after/before refuse to combine", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", path: dir, context: 1, after: 1 });
  assert.equal(result.success, false);
  assert.match(result.output, /not both/);
});

test("search: files mode reports paths, not lines", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", path: dir, mode: "files" });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("data.txt"));
  assert.doesNotMatch(result.output, /alpha/);
});

test("search: the default mode is files, not the matching lines", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", path: dir });
  assert.equal(result.success, true);
  assert.doesNotMatch(result.output, /alpha/);
});

test("search: a glob narrows a content search", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", path: dir, glob: "*.md" });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("notes.md"));
  assert.doesNotMatch(result.output, /data\.txt/);
});

test("search: brace globs work in both engines", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", path: dir, glob: "*.{ts,md}", mode: "files" });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("a.ts"));
  assert.ok(result.output.includes("notes.md"));
  assert.doesNotMatch(result.output, /data\.txt/);
  await withFallback(async () => {
    const fallback = await searchTool.execute({ pattern: "beta", path: dir, glob: "*.{ts,md}", mode: "files" });
    assert.equal(fallback.success, true);
    assert.ok(fallback.output.includes("a.ts"));
    assert.ok(fallback.output.includes("notes.md"));
  });
});

test("search: a path glob reads relative to the root", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", path: dir, glob: "src/**/*.ts", mode: "files" });
  if (!rgActive()) {
    // The grep fallback cannot express path globs and says so instead of answering wrong.
    assert.equal(result.success, false);
    assert.match(result.output, /need ripgrep/);
    return;
  }
  assert.equal(result.success, true);
  assert.ok(result.output.includes(join("src", "a.ts")));
  assert.doesNotMatch(result.output, /node_modules/);
});

test("search: a glob alone lists files by name", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ path: dir, glob: "*.md" });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("notes.md"));
  assert.doesNotMatch(result.output, /data\.txt/);
});

test("search: the defaults skip node_modules and hidden files; all reaches them", async () => {
  if (!rgActive()) return;
  const dir = await fixture();
  const defaults = await searchTool.execute({ pattern: "beta", path: dir, mode: "files" });
  assert.equal(defaults.success, true);
  assert.doesNotMatch(defaults.output, /node_modules/);
  assert.doesNotMatch(defaults.output, /\.hidden/);
  const all = await searchTool.execute({ pattern: "beta", path: dir, mode: "files", all: true });
  assert.equal(all.success, true);
  assert.match(all.output, /node_modules/);
  assert.match(all.output, /\.hidden/);
});

test("search: an explicit path into a skipped directory is searched", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", path: join(dir, "node_modules"), mode: "files" });
  assert.equal(result.success, true);
  assert.match(result.output, /dep\.ts/);
});

test("search: paths searches several roots in one call", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", paths: [join(dir, "src"), join(dir, "sub")], mode: "files" });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("a.ts"));
  assert.ok(result.output.includes("notes.md"));
  assert.doesNotMatch(result.output, /data\.txt/);
});

test("search: exclude and excludeDirs drop what they name", async () => {
  const dir = await fixture();
  const excluded = await searchTool.execute({ pattern: "beta", path: dir, mode: "files", exclude: ["*.md"] });
  assert.equal(excluded.success, true);
  assert.doesNotMatch(excluded.output, /notes\.md/);
  const excludedDirs = await searchTool.execute({ pattern: "beta", path: dir, mode: "files", excludeDirs: ["src"] });
  assert.equal(excludedDirs.success, true);
  assert.doesNotMatch(excludedDirs.output, /src/);
});

test("search: a cut result leads with the count and names the continuation", async () => {
  const dir = await fixture();
  await writeFile(join(dir, "many.txt"), ["beta 1", "beta 2", "beta 3", "beta 4"].join("\n") + "\n");
  const result = await searchTool.execute({ pattern: "beta", path: dir, mode: "content", limit: 3 });
  assert.equal(result.success, true);
  assert.match(underBanner(result.output), /^\d+ matching line/);
  assert.match(result.output, /showing results 1-3 of \d+/);
  assert.match(result.output, /offset 3/);
  const page = await searchTool.execute({ pattern: "beta", path: dir, mode: "content", limit: 3, offset: 3 });
  assert.equal(page.success, true);
  assert.match(page.output, /showing results 4-6 of \d+/);
});

test("search: every mode leads with a count, so a partial answer is visible as partial", async () => {
  const dir = await fixture();
  const files = await searchTool.execute({ pattern: "beta", path: dir, mode: "files" });
  assert.match(underBanner(files.output), /^\d+ file\(s\) contain/);
  const count = await searchTool.execute({ pattern: "beta", path: dir, mode: "count" });
  // The exact totals assume ripgrep's defaults; the fallback searches hidden files, so only the
  // shape is guaranteed there (the fallback's own tests pin its behavior).
  assert.match(underBanner(count.output), rgActive() ? /^4 match\(es\) in 4 file\(s\)/ : /^\d+ match\(es\) in \d+ file\(s\)/);
});

test("search: extract returns only the matched text", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "be\\w+", path: join(dir, "data.txt"), mode: "content", extract: true });
  assert.equal(result.success, true);
  assert.match(result.output, /beta/);
  assert.doesNotMatch(result.output, /alpha/);
});

test("search: invert returns the non-matching lines", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", path: join(dir, "data.txt"), mode: "content", invert: true });
  assert.equal(result.success, true);
  assert.match(result.output, /alpha/);
  assert.doesNotMatch(result.output, /beta/);
});

test("search: a miss names what was searched, so a repeat is visible as a repeat", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "zeta", path: dir });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("No matches for"));
  assert.ok(result.output.includes(dir));
});

test("search: a miss says what the defaults skipped", async () => {
  if (!rgActive()) return;
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "zeta", path: dir, mode: "files" });
  assert.match(result.output, /skipped by default: node_modules/);
  const all = await searchTool.execute({ pattern: "zeta", path: dir, mode: "files", all: true });
  assert.doesNotMatch(all.output, /skipped by default/);
});

test("search: neither a pattern nor a glob is refused", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ path: dir });
  assert.equal(result.success, false);
  assert.match(result.output, /pattern .*or glob .*required/);
});

test("search: empty path is refused with a way out", async () => {
  const result = await searchTool.execute({ pattern: "beta", path: "" });
  assert.equal(result.success, false);
  assert.match(result.output, /path cannot be empty/);
});

test("search: a missing path names itself", async () => {
  const result = await searchTool.execute({ pattern: "beta", path: join(TMP, "does-not-exist") });
  assert.equal(result.success, false);
  assert.match(result.output, /Path not found/);
});

test("search: no path searches the workspace default", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", mode: "files", __workspaceDir: dir });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("data.txt"));
});

test("search: an invalid regex fails loudly and names the dialect", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta(", path: dir, mode: "content" });
  assert.equal(result.success, false);
  if (rgActive()) assert.match(result.output, /Rust regex/);
  await withFallback(async () => {
    const fallback = await searchTool.execute({ pattern: "beta(", path: dir, mode: "content" });
    assert.equal(fallback.success, false);
    assert.match(fallback.output, /ERE|POSIX/);
  });
});

test("search: a pattern starting with a dash is not parsed as a flag", async () => {
  const dir = await fixture();
  await writeFile(join(dir, "dash.txt"), "-beta\nother\n");
  const result = await searchTool.execute({ pattern: "-beta", path: join(dir, "dash.txt"), mode: "content" });
  assert.equal(result.success, true);
  assert.match(result.output, /-beta/);
});

test("search: the grep fallback announces itself", async () => {
  const dir = await fixture();
  const result = await withFallback(() => searchTool.execute({ pattern: "beta", path: dir, mode: "files" }));
  assert.equal(result.success, true);
  assert.match(result.output, /grep fallback/);
});

test("search: the grep fallback still skips node_modules unless the root names it", async () => {
  const dir = await fixture();
  await withFallback(async () => {
    const skipped = await searchTool.execute({ pattern: "beta", path: dir, mode: "files" });
    assert.equal(skipped.success, true);
    assert.doesNotMatch(skipped.output, /node_modules/);
    const named = await searchTool.execute({ pattern: "beta", path: join(dir, "node_modules"), mode: "files" });
    assert.equal(named.success, true);
    assert.match(named.output, /dep\.ts/);
  });
});

test("search: a batch runs several queries in one call", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({
    searches: [
      { path: join(dir, "src"), pattern: "beta", mode: "count" },
      { path: join(dir, "data.txt"), pattern: "alpha", mode: "content" },
    ],
  });
  assert.equal(result.success, true);
  assert.match(result.output, /── \[1\/2\]/);
  assert.match(result.output, /── \[2\/2\]/);
  assert.ok(result.output.includes("alpha"));
});

test("search: a batch refuses top-level single-query fields", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ pattern: "beta", searches: [{ path: dir, pattern: "beta" }] });
  assert.equal(result.success, false);
  assert.match(result.output, /searches replaces the single-query fields/);
});

test("search: a broken batch entry names its index", async () => {
  const dir = await fixture();
  const result = await searchTool.execute({ searches: [{ path: dir, pattern: "beta" }, { path: dir }] });
  assert.equal(result.success, false);
  assert.match(result.output, /searches\[1\]:/);
});

test("search-core: joinBatch cuts on the shared budget and names the cut", () => {
  const block = (i: number) => ({ header: `── [${i}/3]`, text: "x".repeat(45_000) });
  const text = joinBatch([block(1), block(2), block(3)]);
  assert.match(text, /batch cut at query 3 of 3/);
  assert.doesNotMatch(text, /── \[3\/3\]/);
});

test("search-core: expandBraces handles nesting and commas", () => {
  assert.deepEqual(expandBraces("*.ts"), ["*.ts"]);
  assert.deepEqual(expandBraces("*.{ts,tsx}"), ["*.ts", "*.tsx"]);
  assert.deepEqual(expandBraces("src/*.{ts,{js,jsx}}"), ["src/*.ts", "src/*.js", "src/*.jsx"]);
  assert.deepEqual(expandBraces("plain"), ["plain"]);
});

// An engine that never answers: the shape of a ripgrep over `/` that held a sub-agent's run for
// 16 hours after Stop. The stand-in is a script, so no real filesystem walk is involved.
async function stuckEngine(seconds = 300): Promise<string> {
  const path = join(TMP, `stuck-engine-${seconds}.sh`);
  await mkdir(TMP, { recursive: true });
  await writeFile(path, `#!/bin/sh\nexec sleep ${seconds}\n`, { mode: 0o755 });
  return path;
}

/** An engine that answers, slowly: the shape of a real search over a tree that has to be walked. */
async function slowEngine(seconds: number): Promise<string> {
  const path = join(TMP, `slow-engine-${seconds}.sh`);
  await mkdir(TMP, { recursive: true });
  await writeFile(path, `#!/bin/sh\nsleep ${seconds}\nprintf 'hit\\n'\n`, { mode: 0o755 });
  return path;
}

const stuckQuery = (): SearchQuery => ({
  roots: [TMP],
  pattern: "x",
  glob: "",
  mode: "files",
  context: 0,
  after: 0,
  before: 0,
  limit: 10,
  offset: 0,
  ignoreCase: false,
  extract: false,
  invert: false,
  all: false,
  exclude: [],
  excludeDirs: [],
});

test("search: an engine that never answers is killed at the wall", async () => {
  const rgPath = await stuckEngine();
  const started = Date.now();
  const outcome = await executeQuery(stuckQuery(), { rgPath, wallMs: 300 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /Search timed out after 0\.3 s/);
  assert.ok(Date.now() - started < 5000, "the wall, not the engine, ended the call");
});

test("search: a Stop kills the engine and throws instead of answering", async () => {
  const rgPath = await stuckEngine();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await assert.rejects(executeQuery(stuckQuery(), { rgPath, signal: controller.signal }), AbortedError);
  assert.ok(Date.now() - started < 5000);
});

test("search: a Stop that landed before the spawn never runs the engine to its end", async () => {
  const rgPath = await stuckEngine();
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await assert.rejects(executeQuery(stuckQuery(), { rgPath, signal: controller.signal }), AbortedError);
  assert.ok(Date.now() - started < 5000);
});

test("search: a Stop reaches the batch path too", async () => {
  const rgPath = await stuckEngine();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(
    executeQuery({ ...stuckQuery(), roots: [TMP, TMP] }, { rgPath, signal: controller.signal }),
    AbortedError,
  );
});

test("search: a huge result set stops at the collection cap and says so", async () => {
  const real = Bun.which("rg");
  if (!real) return;
  const dir = await fixture();
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    await writeFile(join(dir, name), Array.from({ length: 4 }, (_, i) => `beta ${i}`).join("\n") + "\n");
  }
  const outcome = await executeQuery({ ...stuckQuery(), pattern: "beta", mode: "content" }, { rgPath: real, maxLines: 4 });
  assert.equal(outcome.ok, true);
  assert.match(outcome.text, /^4\+ matching line\(s\)/);
  assert.match(outcome.text, /of 4\+/);
  assert.match(outcome.text, /stopped at 4 results/);
});

test("search: the cap applies to a file listing too", async () => {
  const real = Bun.which("rg");
  if (!real) return;
  const dir = await fixture();
  const outcome = await executeQuery({ ...stuckQuery(), mode: "files", pattern: "beta" }, { rgPath: real, maxLines: 2 });
  assert.equal(outcome.ok, true);
  assert.match(outcome.text, /^2\+ file\(s\) contain/);
});

test("search: the default cap is a page deep enough for offset paging", async () => {
  assert.ok(MAX_COLLECTED_LINES >= 2000 * 2);
});

test("search: every root shares one wall, not one wall each", async () => {
  const engine = await slowEngine(0.4);
  const started = Date.now();
  const outcome = await executeQuery({ ...stuckQuery(), roots: [TMP, TMP] }, { rgPath: engine, wallMs: 600 });
  const elapsed = Date.now() - started;
  assert.equal(outcome.ok, false);
  assert.match(outcome.text, /Search timed out/);
  assert.ok(elapsed < 950, `two roots took ${elapsed} ms, so the second one had its own wall`);
});

test("search: an rg that will not start hands the query to grep instead of failing it", async () => {
  const root = await fixture();
  // A path that exists but cannot be executed is exactly the 0.7.207 release: the engine resolved,
  // and every search died at the spawn with EACCES instead of using the grep beside it.
  const broken = join(root, "rg-not-executable");
  await writeFile(broken, "#!/bin/sh\n", { mode: 0o644 });
  await chmod(broken, 0o644);
  const query: SearchQuery = { ...stuckQuery(), pattern: "beta", roots: [root], mode: "content" };
  const result = await executeQuery(query, { rgPath: broken, wallMs: 10_000 });
  assert.equal(result.ok, true);
  assert.match(result.text, /engine: grep fallback/);
  assert.match(result.text, /beta/);
});
