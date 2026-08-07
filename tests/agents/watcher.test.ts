import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { reloadAgents } from "../../src/agents/reload.ts";
import { startAgentsWatcher } from "../../src/agents/watcher.ts";

const cleanups: Array<() => void | Promise<void>> = [];

async function tempDirs(): Promise<{ builtInDir: string; customDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "agents-w-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const customDir = join(root, "custom");
  const workspaceDir = join(root, "workspace");
  await mkdir(customDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  return { builtInDir: join(root, "builtin"), customDir, workspaceDir };
}

async function writeAgent(dir: string, name: string, description: string): Promise<void> {
  await writeFile(join(dir, `${name}.md`), `---\ndescription: ${description}\n---\n\nBody for ${name}.\n`);
}

/**
 * Same race as the skills watcher: Bun's fs.watch is not active when watch() returns, so the write
 * under test can beat registration and be lost outright. Poking until the expectation holds is
 * immune to that, and the poke has no `.md` suffix so it can never register as an agent. Its name
 * must not start with a dot: a dotfile created after the watcher attached produces no events.
 */
async function waitFor(pred: () => boolean, pokeDir: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for the agents watcher (poking ${pokeDir})`);
    await writeFile(join(pokeDir, "watcher-poke"), String(Date.now()));
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("reloadAgents rescans and swaps the registry contents", async () => {
  const dirs = await tempDirs();
  const registry = new AgentRegistry();
  assert.equal(registry.list().length, 0);

  await writeAgent(dirs.customDir, "alpha", "first agent");
  assert.equal(await reloadAgents(dirs, registry), 1);
  assert.equal(registry.exists("alpha"), true);
});

test("watcher picks up an agent dropped in at runtime", async () => {
  const dirs = await tempDirs();
  const registry = new AgentRegistry();
  const stop = startAgentsWatcher(dirs, registry, { debounceMs: 20 });
  cleanups.push(() => stop());

  await writeAgent(dirs.customDir, "beta", "added at runtime");
  await waitFor(() => registry.exists("beta"), dirs.customDir);
  assert.equal(registry.exists("beta"), true);
}, 15_000);

test("watcher picks up an edited description without a restart", async () => {
  const dirs = await tempDirs();
  await writeAgent(dirs.workspaceDir, "gamma", "original");
  const registry = new AgentRegistry();
  await reloadAgents(dirs, registry);

  const stop = startAgentsWatcher(dirs, registry, { debounceMs: 20 });
  cleanups.push(() => stop());

  await writeAgent(dirs.workspaceDir, "gamma", "edited");
  const described = (): string | undefined => registry.list().find((a) => a.name === "gamma")?.description;
  await waitFor(() => described() === "edited", dirs.workspaceDir);
  assert.equal(described(), "edited");
}, 15_000);

test("watcher drops a removed agent", async () => {
  const dirs = await tempDirs();
  await writeAgent(dirs.customDir, "delta", "to be removed");
  const registry = new AgentRegistry();
  await reloadAgents(dirs, registry);
  assert.equal(registry.exists("delta"), true);

  const stop = startAgentsWatcher(dirs, registry, { debounceMs: 20 });
  cleanups.push(() => stop());

  await rm(join(dirs.customDir, "delta.md"), { force: true });
  await waitFor(() => !registry.exists("delta"), dirs.customDir);
  assert.equal(registry.exists("delta"), false);
}, 15_000);

test("stop() detaches the watchers", async () => {
  const dirs = await tempDirs();
  const registry = new AgentRegistry();
  let reloads = 0;
  const stop = startAgentsWatcher(dirs, registry, {
    debounceMs: 20,
    reload: async () => { reloads += 1; return 0; },
  });
  await new Promise((r) => setTimeout(r, 50));
  stop();
  await writeAgent(dirs.customDir, "epsilon", "after stop");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(reloads, 0);
});

test("a broken agent keeps its last good version instead of vanishing", async () => {
  const dirs = await tempDirs();
  await writeAgent(dirs.customDir, "zeta", "working");
  const registry = new AgentRegistry();
  await reloadAgents(dirs, registry);

  // Frontmatter destroyed by an edit. Dropping the agent here would remove a spawn target with no
  // explanation; keeping the last good one leaves the author something to compare against.
  await writeFile(join(dirs.customDir, "zeta.md"), "no frontmatter at all");
  await reloadAgents(dirs, registry);
  assert.equal(registry.get("zeta")?.meta.description, "working");
});

test("cleanup", async () => {
  while (cleanups.length) await cleanups.pop()!();
});
