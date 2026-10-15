import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeClientConfig } from "../../src/node-client/config.ts";
import { manifestFor, runTool, toolByName } from "../../src/node-client/tools.ts";

let dir: string;
let config: NodeClientConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "node-tools-test-"));
  config = { server: "wss://myclaw.example/node", workdir: dir };
});

const signal = (): AbortSignal => new AbortController().signal;

describe("node client tools", () => {
  test("the manifest only carries what the config exposes", () => {
    expect(manifestFor(config).map((t) => t.name)).toEqual(["bash", "read", "write", "apply_patch", "search", "ls"]);
    const readOnly = manifestFor({ ...config, readOnly: true }).map((t) => t.name);
    expect(readOnly).not.toContain("write");
    expect(readOnly).not.toContain("apply_patch");
    expect(toolByName(config, "write")).toBeDefined();
    expect(toolByName({ ...config, readOnly: true }, "write")).toBeUndefined();
  });

  test("bash runs in the workdir and reports its output", async () => {
    const result = await runTool(config, "bash", { command: "pwd && echo hi" }, signal());
    expect(result.ok).toBe(true);
    expect(result.output).toContain(dir);
    expect(result.output).toContain("hi");
  });

  test("bash reports a failing exit code and keeps the output", async () => {
    const result = await runTool(config, "bash", { command: "echo before-fail; exit 3" }, signal());
    expect(result.ok).toBe(false);
    expect(result.output).toContain("before-fail");
    expect(result.error).toContain("code 3");
  });

  test("bash times out and is killed", async () => {
    const started = Date.now();
    const result = await runTool(config, "bash", { command: "sleep 30", timeoutMs: 1000 }, signal());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("bash is killed when the call is cancelled", async () => {
    const controller = new AbortController();
    const pending = runTool(config, "bash", { command: "sleep 30", timeoutMs: 60_000 }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Command cancelled.");
  });

  test("write creates parents, read reads back, apply_patch edits anchors", async () => {
    const file = join(dir, "sub", "file.txt");
    expect((await runTool(config, "write", { path: file, content: "alpha\nbeta\ngamma\n" }, signal())).ok).toBe(true);
    expect((await runTool(config, "read", { path: file }, signal())).output).toBe("alpha\nbeta\ngamma\n");

    const patched = await runTool(config, "apply_patch", { path: file, edits: [{ old: "beta", new: "BETA" }] }, signal());
    expect(patched.ok).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("an ambiguous anchor refuses and writes nothing; all=true replaces every one", async () => {
    const file = join(dir, "dup.txt");
    await writeFile(file, "x\nx\nx\n");
    const ambiguous = await runTool(config, "apply_patch", { path: file, edits: [{ old: "x", new: "y" }] }, signal());
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toContain("appears 3 times");
    expect(await readFile(file, "utf-8")).toBe("x\nx\nx\n");

    const all = await runTool(config, "apply_patch", { path: file, edits: [{ old: "x", new: "y", all: true }] }, signal());
    expect(all.ok).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("y\ny\ny\n");
  });

  test("one failing edit leaves the file exactly as it was", async () => {
    const file = join(dir, "all-or-nothing.txt");
    await writeFile(file, "one\ntwo\n");
    const result = await runTool(
      config,
      "apply_patch",
      { path: file, edits: [{ old: "one", new: "1" }, { old: "nope", new: "2" }] },
      signal(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("anchor not found");
    expect(await readFile(file, "utf-8")).toBe("one\ntwo\n");
  });

  test("apply_patch names a missing file and points at write", async () => {
    const result = await runTool(config, "apply_patch", { path: join(dir, "absent.txt"), edits: [{ old: "a", new: "b" }] }, signal());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Create it with write");
  });

  test("search finds content, counts, and lists names; .git is skipped", async () => {
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "src", "a.ts"), "const alpha = 1;\nconst beta = 2;\n");
    await writeFile(join(dir, "src", "b.txt"), "alpha again\n");
    await writeFile(join(dir, ".git", "hidden.txt"), "alpha hidden\n");

    const content = await runTool(config, "search", { path: dir, pattern: "alpha", mode: "content" }, signal());
    expect(content.ok).toBe(true);
    expect(content.output).toContain("a.ts:1:const alpha = 1;");
    expect(content.output).toContain("b.txt:1:alpha again");
    expect(content.output).not.toContain("hidden");

    const counts = await runTool(config, "search", { path: dir, pattern: "alpha", mode: "count" }, signal());
    expect(counts.output).toContain("a.ts:1");
    expect(counts.output).toContain("b.txt:1");

    const files = await runTool(config, "search", { path: dir, pattern: "alpha", mode: "files" }, signal());
    expect(files.output.split("\n").sort()).toEqual([join(dir, "src", "a.ts"), join(dir, "src", "b.txt")]);

    const byGlob = await runTool(config, "search", { path: dir, glob: "*.ts" }, signal());
    expect(byGlob.output).toContain("a.ts");
    expect(byGlob.output).not.toContain("b.txt");

    const insensitive = await runTool(config, "search", { path: dir, pattern: "ALPHA", ignoreCase: true, mode: "files" }, signal());
    expect(insensitive.output).toContain("a.ts");
  });

  test("search says so when nothing matches, and refuses an invalid regex", async () => {
    await writeFile(join(dir, "x.txt"), "hello\n");
    const none = await runTool(config, "search", { path: dir, pattern: "zzz" }, signal());
    expect(none.ok).toBe(true);
    expect(none.output).toContain("No matches");
    const bad = await runTool(config, "search", { path: dir, pattern: "(" }, signal());
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("Invalid pattern");
  });

  test("ls lists a directory, read refuses binaries", async () => {
    await writeFile(join(dir, "one.txt"), "1");
    await mkdir(join(dir, "subdir"));
    const listed = await runTool(config, "ls", { path: dir }, signal());
    expect(listed.output).toContain("one.txt");
    expect(listed.output).toContain("d subdir");

    const binary = join(dir, "bin");
    await writeFile(binary, Buffer.from([0x00, 0x01, 0x02]));
    const read = await runTool(config, "read", { path: binary }, signal());
    expect(read.ok).toBe(false);
    expect(read.output).toContain("Binary file");
  });

  test("the roots ceiling fences read and write but not bash", async () => {
    const fenced: NodeClientConfig = { ...config, roots: [dir] };
    const outside = join(tmpdir(), `outside-${Date.now()}.txt`);
    const write = await runTool(fenced, "write", { path: outside, content: "nope" }, signal());
    expect(write.ok).toBe(false);
    expect(write.error).toContain("allowed roots");
    const read = await runTool(fenced, "read", { path: outside }, signal());
    expect(read.ok).toBe(false);
    expect(read.error).toContain("allowed roots");
  });

  test("an unknown or unexposed tool is refused by name", async () => {
    const result = await runTool({ ...config, tools: ["ls"] }, "bash", { command: "echo hi" }, signal());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('"bash" is not exposed');
  });
});
