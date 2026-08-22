import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractTargetDirs,
  recordNestedInjection,
  MAX_NESTED_RECORDS,
  NestedAgentsCollector,
  type NestedAgentsRecord,
} from "../../../src/agent/prompt/nested-agents.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "nested-agents-"));
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

test("nested: chain from git root down to dir, closest last", () => {
  const base = scratch();
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "pkg", "sub"), { recursive: true });
  write(join(repo, "AGENTS.md"), "REPO RULES");
  write(join(repo, "pkg", "AGENTS.md"), "PKG RULES");
  writeFileSync(join(repo, "pkg", "sub", "file.ts"), "x", "utf-8");
  // An AGENTS.md above the git root must be ignored: the walk stops at .git.
  write(join(base, "AGENTS.md"), "ABOVE GIT ROOT");

  const c = new NestedAgentsCollector(join(base, "ws"), 32768);
  const out = c.collect("read", { path: join(repo, "pkg", "sub", "file.ts") });

  assert.ok(out.includes("REPO RULES"), "repo root included");
  assert.ok(out.includes("PKG RULES"), "pkg included");
  assert.ok(!out.includes("ABOVE GIT ROOT"), "beyond git root excluded");
  assert.ok(out.indexOf("REPO RULES") < out.indexOf("PKG RULES"), "root before closest");

  rmSync(base, { recursive: true, force: true });
});

test("nested: workspace-root AGENTS.md is excluded (already in system prompt)", () => {
  const base = scratch();
  const ws = join(base, "ws");
  mkdirSync(join(ws, "sub"), { recursive: true });
  write(join(ws, "AGENTS.md"), "WORKSPACE ROOT");
  write(join(ws, "sub", "AGENTS.md"), "SUB RULES");
  writeFileSync(join(ws, "sub", "x.ts"), "x", "utf-8");

  const c = new NestedAgentsCollector(ws, 32768);
  const out = c.collect("write", { path: join(ws, "sub", "x.ts") });

  assert.ok(out.includes("SUB RULES"));
  assert.ok(!out.includes("WORKSPACE ROOT"), "workspace root excluded");

  rmSync(base, { recursive: true, force: true });
});

test("nested: each file injected at most once per run (dedup)", () => {
  const base = scratch();
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  write(join(repo, "AGENTS.md"), "REPO RULES");
  writeFileSync(join(repo, "a.ts"), "x", "utf-8");
  writeFileSync(join(repo, "b.ts"), "y", "utf-8");

  const c = new NestedAgentsCollector(join(base, "ws"), 32768);
  const first = c.collect("read", { path: join(repo, "a.ts") });
  const second = c.collect("read", { path: join(repo, "b.ts") });

  assert.ok(first.includes("REPO RULES"));
  assert.equal(second, "", "same file not re-injected");

  rmSync(base, { recursive: true, force: true });
});

test("nested: the same file reached through a symlink is paid for once", () => {
  const base = scratch();
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  write(join(repo, "AGENTS.md"), "REPO RULES");
  writeFileSync(join(repo, "a.ts"), "x", "utf-8");
  // The shape this covers: ~/dev/repo and /home/me/dev/repo, or a symlinked checkout. Keyed on
  // the path string, the budget was spent twice on one file.
  symlinkSync(repo, join(base, "link"));

  const c = new NestedAgentsCollector(join(base, "ws"), 32768);
  assert.ok(c.collect("read", { path: join(repo, "a.ts") }).includes("REPO RULES"));
  assert.equal(c.collect("read", { path: join(base, "link", "a.ts") }), "");

  rmSync(base, { recursive: true, force: true });
});

test("nested: one call touching two trees carries both sets of rules", () => {
  const base = scratch();
  const first = join(base, "one");
  const second = join(base, "two");
  for (const [dir, rules] of [[first, "ONE RULES"], [second, "TWO RULES"]] as const) {
    mkdirSync(join(dir, ".git"), { recursive: true });
    write(join(dir, "AGENTS.md"), rules);
    writeFileSync(join(dir, "f.ts"), "x", "utf-8");
  }

  const c = new NestedAgentsCollector(join(base, "ws"), 32768);
  const out = c.collect("bash", { command: `diff ${first}/f.ts ${second}/f.ts` });

  assert.ok(out.includes("ONE RULES"));
  assert.ok(out.includes("TWO RULES"));

  rmSync(base, { recursive: true, force: true });
});

test("nested: byte budget caps total injected content", () => {
  const base = scratch();
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "pkg"), { recursive: true });
  write(join(repo, "AGENTS.md"), "AAAAAAAAAA"); // 10 bytes
  write(join(repo, "pkg", "AGENTS.md"), "BBBBBBBBBB"); // 10 bytes
  writeFileSync(join(repo, "pkg", "f.ts"), "x", "utf-8");

  const c = new NestedAgentsCollector(join(base, "ws"), 10); // only the first fits
  const out = c.collect("read", { path: join(repo, "pkg", "f.ts") });

  assert.ok(out.includes("AAAAAAAAAA"));
  assert.ok(!out.includes("BBBBBBBBBB"), "second file skipped once cap reached");

  rmSync(base, { recursive: true, force: true });
});

test("nested: untrusted content is normalised", () => {
  const base = scratch();
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  write(join(repo, "AGENTS.md"), "prefer ta\u200bbs");
  writeFileSync(join(repo, "f.ts"), "x", "utf-8");

  const c = new NestedAgentsCollector(join(base, "ws"), 32768);
  const out = c.collect("read", { path: join(repo, "f.ts") });

  assert.ok(out.includes("prefer tabs"), "nested content reaches the prompt");
  assert.ok(!out.includes("\u200b"), "nested content is normalised");

  rmSync(base, { recursive: true, force: true });
});

test("nested: no git root outside workspace only reads target dir", () => {
  const base = scratch();
  // no .git anywhere; target outside the workspace -> boundary is the target dir itself,
  // so a parent AGENTS.md must not be walked into.
  mkdirSync(join(base, "a", "b"), { recursive: true });
  write(join(base, "a", "AGENTS.md"), "PARENT");
  write(join(base, "a", "b", "AGENTS.md"), "TARGET");
  writeFileSync(join(base, "a", "b", "f.ts"), "x", "utf-8");

  const c = new NestedAgentsCollector(join(base, "ws"), 32768);
  const out = c.collect("read", { path: join(base, "a", "b", "f.ts") });

  assert.ok(out.includes("TARGET"));
  assert.ok(!out.includes("PARENT"), "no walk above target without git root or workspace");

  rmSync(base, { recursive: true, force: true });
});

test("extractTargetDirs: file tools use path (dir vs dirname)", () => {
  const base = scratch();
  mkdirSync(join(base, "d"), { recursive: true });
  writeFileSync(join(base, "d", "f.ts"), "x", "utf-8");

  assert.deepEqual(extractTargetDirs("read", { path: join(base, "d", "f.ts") }, base), [join(base, "d")]);
  assert.deepEqual(extractTargetDirs("ls", { path: join(base, "d") }, base), [join(base, "d")]);
  // A file the tool is about to create still names the tree whose rules apply to it.
  assert.deepEqual(extractTargetDirs("write", { path: join(base, "d", "new.ts") }, base), [join(base, "d")]);
  assert.deepEqual(extractTargetDirs("read", {}, base), []);

  rmSync(base, { recursive: true, force: true });
});

test("extractTargetDirs: bash reads workdir, every cd, and the paths that exist", () => {
  const base = scratch();
  const d = join(base, "repo");
  const other = join(base, "other");
  mkdirSync(join(d, "src"), { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(d, "src", "x.ts"), "x", "utf-8");

  assert.deepEqual(extractTargetDirs("bash", { command: "make", workdir: d }, base), [d]);
  assert.deepEqual(extractTargetDirs("bash", { command: `cd ${d} && make` }, base), [d]);
  // The 33% the old leading-cd rule missed: the path is in the command, not in a cd.
  assert.deepEqual(extractTargetDirs("bash", { command: `cat ${d}/src/x.ts` }, base), [join(d, "src")]);
  // A cd that is not the first word counts too.
  assert.deepEqual(extractTargetDirs("bash", { command: `make && cd ${other} && ls` }, base), [other]);
  // Two trees in one command, both reported, root order preserved.
  assert.deepEqual(
    extractTargetDirs("bash", { command: `diff ${d}/src/x.ts ${other}` }, base),
    [join(d, "src"), other],
  );

  rmSync(base, { recursive: true, force: true });
});

test("extractTargetDirs: a token that is not a real path is not a signal", () => {
  const base = scratch();
  mkdirSync(base, { recursive: true });

  // Everything here holds a slash and none of it exists: sed programs, URLs, globs, flags.
  const noise = "sed -i 's/foo/bar/' && curl https://x.dev/a/b --include=src/*.ts";
  assert.deepEqual(extractTargetDirs("bash", { command: noise }, base), []);
  assert.deepEqual(extractTargetDirs("bash", { command: "echo hi" }, base), []);
  assert.deepEqual(extractTargetDirs("web_search", { query: "a/b" }, base), []);

  rmSync(base, { recursive: true, force: true });
});

test("extractTargetDirs: at most four directories per call", () => {
  const base = scratch();
  const dirs = ["a", "b", "c", "d", "e"].map((name) => join(base, name));
  for (const dir of dirs) mkdirSync(dir, { recursive: true });

  const found = extractTargetDirs("bash", { command: `ls ${dirs.join(" ")}` }, base);
  assert.equal(found.length, 4, "one pathological command must not drain the run budget");

  rmSync(base, { recursive: true, force: true });
});

test("extractTargetDirs: spawn's workspaceDir is the tree the sub-agent lives in", () => {
  const base = scratch();
  const dir = join(base, "project");
  mkdirSync(dir, { recursive: true });

  assert.deepEqual(extractTargetDirs("spawn", { task: "x", workspaceDir: dir }, base), [dir]);
  assert.deepEqual(extractTargetDirs("spawn", { task: "x" }, base), []);

  rmSync(base, { recursive: true, force: true });
});

test("extractTargetDirs: relative path resolves against workspace", () => {
  const base = scratch();
  mkdirSync(join(base, "sub"), { recursive: true });
  writeFileSync(join(base, "sub", "f.ts"), "x", "utf-8");

  assert.deepEqual(extractTargetDirs("read", { path: "sub/f.ts" }, base), [join(base, "sub")]);
  assert.deepEqual(extractTargetDirs("bash", { command: "wc -l sub/f.ts" }, base), [join(base, "sub")]);

  rmSync(base, { recursive: true, force: true });
});

test("nested: the session is told about every file the run injected, once each", () => {
  const base = scratch();
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "pkg"), { recursive: true });
  write(join(repo, "AGENTS.md"), "REPO RULES");
  write(join(repo, "pkg", "AGENTS.md"), "PKG RULES");
  writeFileSync(join(repo, "pkg", "f.ts"), "x", "utf-8");

  const seen: Array<{ path: string; bytes: number }> = [];
  const c = new NestedAgentsCollector(join(base, "ws"), 32768, (file) => seen.push(file));
  c.collect("read", { path: join(repo, "pkg", "f.ts") });
  // Second call, same files: the run dedup holds, so the trace must not grow either.
  c.collect("read", { path: join(repo, "pkg", "f.ts") });

  assert.deepEqual(seen.map((f) => f.path), [join(repo, "AGENTS.md"), join(repo, "pkg", "AGENTS.md")]);
  assert.equal(seen[0]?.bytes, Buffer.byteLength("REPO RULES"));

  rmSync(base, { recursive: true, force: true });
});

test("nested: a file skipped by the byte budget is not recorded as read", () => {
  const base = scratch();
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "pkg"), { recursive: true });
  write(join(repo, "AGENTS.md"), "AAAAAAAAAA");
  write(join(repo, "pkg", "AGENTS.md"), "BBBBBBBBBB");
  writeFileSync(join(repo, "pkg", "f.ts"), "x", "utf-8");

  const seen: string[] = [];
  const c = new NestedAgentsCollector(join(base, "ws"), 10, (file) => seen.push(file.path));
  c.collect("read", { path: join(repo, "pkg", "f.ts") });

  assert.deepEqual(seen, [join(repo, "AGENTS.md")]);

  rmSync(base, { recursive: true, force: true });
});

test("recordNestedInjection: a re-read counts a run, it does not duplicate the file", () => {
  const records: NestedAgentsRecord[] = [];
  recordNestedInjection(records, { path: "/repo/AGENTS.md", bytes: 10 }, "2026-08-15T10:00:00.000Z");
  recordNestedInjection(records, { path: "/repo/AGENTS.md", bytes: 12 }, "2026-08-15T11:00:00.000Z");

  assert.equal(records.length, 1);
  assert.equal(records[0]?.count, 2);
  assert.equal(records[0]?.firstAt, "2026-08-15T10:00:00.000Z");
  assert.equal(records[0]?.lastAt, "2026-08-15T11:00:00.000Z");
  // The size follows the file: it is what the page shows, and the file was rewritten.
  assert.equal(records[0]?.bytes, 12);
});

test("recordNestedInjection: over the cap the least recently read file is the one dropped", () => {
  const records: NestedAgentsRecord[] = [];
  for (let i = 0; i < MAX_NESTED_RECORDS; i += 1) {
    const at = new Date(Date.UTC(2026, 7, 15, 0, i)).toISOString();
    recordNestedInjection(records, { path: `/repo/p${i}/AGENTS.md`, bytes: 1 }, at);
  }
  // The oldest timestamp, whatever its position in the list.
  recordNestedInjection(records, { path: "/repo/p0/AGENTS.md", bytes: 1 }, "2026-08-16T00:00:00.000Z");
  recordNestedInjection(records, { path: "/repo/new/AGENTS.md", bytes: 1 }, "2026-08-16T01:00:00.000Z");

  assert.equal(records.length, MAX_NESTED_RECORDS);
  assert.ok(records.some((r) => r.path === "/repo/new/AGENTS.md"), "the new file is kept");
  assert.ok(records.some((r) => r.path === "/repo/p0/AGENTS.md"), "a re-read file is not the oldest any more");
  assert.ok(!records.some((r) => r.path === "/repo/p1/AGENTS.md"), "the least recently read one went");
});

test("nested: disabled path returns nothing when collector not used", () => {
  // The collector itself is unconditional; the enable flag is applied in the bridge.
  // Here we just assert an unknown tool yields no discovery.
  const base = scratch();
  const c = new NestedAgentsCollector(base, 32768);
  assert.equal(c.collect("web_search", { query: "x" }), "");
  rmSync(base, { recursive: true, force: true });
});

test("nested: disabled file is skipped before dedup, so re-enabling mid-run collects it again", () => {
  const base = scratch();
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  write(join(repo, "AGENTS.md"), "REPO RULES");
  writeFileSync(join(repo, "a.ts"), "x", "utf-8");

  const disabledPaths = new Set<string>();
  const c = new NestedAgentsCollector(join(base, "ws"), 32768, undefined, (p) => disabledPaths.has(p));

  // Off: nothing injected, and (the point) the path is NOT marked seen.
  disabledPaths.add(join(repo, "AGENTS.md"));
  assert.equal(c.collect("read", { path: join(repo, "a.ts") }), "");

  // Re-enabled mid-run: the very next call on the same tree gets the file back.
  disabledPaths.delete(join(repo, "AGENTS.md"));
  assert.ok(c.collect("read", { path: join(repo, "a.ts") }).includes("REPO RULES"));

  rmSync(base, { recursive: true, force: true });
});
