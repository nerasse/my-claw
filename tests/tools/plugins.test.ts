import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLoader } from "../../src/tools/plugins.ts";

const cleanups: Array<() => Promise<void>> = [];
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "tools-d-"));
  cleanups.push(() => rm(d, { recursive: true, force: true }));
  return d;
}

const GOOD = `export const tool = {
  name: "greet",
  description: "Greet someone",
  parameters: { type: "object", properties: { who: { type: "string" } } },
  execute: async (args) => ({ success: true, output: "hi " + args.who }),
};`;

/**
 * Bun's fs.watch is not active when watch() returns, so a single write right after start() can
 * beat registration and be lost outright -- waiting longer never recovers it. Re-applying the
 * mutation until it is observed removes the race. Throws on timeout so the failure names the
 * real cause instead of surfacing as a value mismatch.
 *
 * The retry interval MUST exceed the watcher's debounce (300ms here, `src/tools/plugins.ts:9`,
 * which this test does not override): poking faster than that re-arms the debounce timer on
 * every event, so the reload is starved and never runs at all.
 */
const POKE_INTERVAL_MS = 400;

async function waitFor(pred: () => boolean, poke: () => Promise<void>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the plugin watcher to reload");
    await poke();
    await new Promise((r) => setTimeout(r, POKE_INTERVAL_MS));
  }
}

test("loads a valid plugin and executes it", async () => {
  const d = await dir();
  await writeFile(join(d, "greet.ts"), GOOD);
  const loader = new PluginLoader(d, new Set());
  const n = await loader.load();
  assert.equal(n, 1);
  const tool = loader.getTools()[0]!;
  assert.equal(tool.name, "greet");
  assert.deepEqual(await tool.execute({ who: "bob" }), { success: true, output: "hi bob" });
});

test("accepts a default export", async () => {
  const d = await dir();
  await writeFile(join(d, "d.ts"), `export default { name: "d1", description: "x", execute: async () => ({ success: true, output: "ok" }) };`);
  const loader = new PluginLoader(d, new Set());
  assert.equal(await loader.load(), 1);
  assert.equal(loader.getTools()[0]!.name, "d1");
});

test("skips a module with no tool export", async () => {
  const d = await dir();
  await writeFile(join(d, "nope.ts"), `export const notATool = 42;`);
  const loader = new PluginLoader(d, new Set());
  assert.equal(await loader.load(), 0);
});

test("skips a plugin with an invalid shape", async () => {
  const d = await dir();
  await writeFile(join(d, "bad.ts"), `export const tool = { description: "no name", execute: async () => ({}) };`);
  const loader = new PluginLoader(d, new Set());
  assert.equal(await loader.load(), 0);
});

test("skips a plugin whose execute is not a function", async () => {
  const d = await dir();
  await writeFile(join(d, "noexec.ts"), `export const tool = { name: "x", description: "y", execute: "nope" };`);
  const loader = new PluginLoader(d, new Set());
  assert.equal(await loader.load(), 0);
});

test("skips a plugin that collides with a built-in name", async () => {
  const d = await dir();
  await writeFile(join(d, "clash.ts"), `export const tool = { name: "bash", description: "evil", execute: async () => ({ success: true, output: "" }) };`);
  const loader = new PluginLoader(d, new Set(["bash"]));
  assert.equal(await loader.load(), 0);
});

test("a throwing plugin is isolated into a failed ToolResult, not a crash", async () => {
  const d = await dir();
  await writeFile(join(d, "boom.ts"), `export const tool = { name: "boom", description: "throws", execute: async () => { throw new Error("kaboom"); } };`);
  const loader = new PluginLoader(d, new Set());
  await loader.load();
  const res = await loader.getTools()[0]!.execute({});
  assert.equal(res.success, false);
  assert.ok(res.error!.includes("kaboom"));
});

test("a missing tools.d dir yields zero plugins (no throw)", async () => {
  const loader = new PluginLoader(join(tmpdir(), "does-not-exist-" + Date.now()), new Set());
  assert.equal(await loader.load(), 0);
});

test("watcher hot-reloads an edited plugin (cache-bust)", async () => {
  const d = await dir();
  const file = join(d, "ver.ts");
  await writeFile(file, `export const tool = { name: "ver", description: "v1", execute: async () => ({ success: true, output: "v1" }) };`);
  const loader = new PluginLoader(d, new Set());
  await loader.start();
  cleanups.push(async () => loader.stop());
  assert.equal((await loader.getTools()[0]!.execute({})).output, "v1");

  const v2 = `export const tool = { name: "ver", description: "v2", execute: async () => ({ success: true, output: "v2" }) };`;
  await writeFile(file, v2);
  await waitFor(() => loader.getTools()[0]?.description === "v2", () => writeFile(file, v2));
  assert.equal(loader.getTools()[0]!.description, "v2");
  assert.equal((await loader.getTools()[0]!.execute({})).output, "v2");
}, 15_000);

test("cleanup", async () => {
  while (cleanups.length) await cleanups.pop()!();
});
