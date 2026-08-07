import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { reloadAgents, editableAgentTierDirs, type AgentDirs } from "../../src/agents/reload.ts";
import { startAgentsWatcher } from "../../src/agents/watcher.ts";
import { resolveAgent } from "../../src/agents/resolve.ts";
import { createSpawnTool } from "../../src/tools/spawn.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { SubAgentRunner } from "../../src/subagents/runner.ts";
import type { SubAgentRegistry } from "../../src/subagents/registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { Tool } from "../../src/tools/types.ts";

const cleanups: Array<() => void | Promise<void>> = [];

function config(): MyClawConfig {
  return { whitelist: [], blacklist: [], channels: {}, llm: { provider: "t", baseUrl: "u", model: "m" }, agents: {} } as MyClawConfig;
}

async function tempDirs(): Promise<AgentDirs> {
  const root = await mkdtemp(join(tmpdir(), "agents-hot-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const customDir = join(root, "custom");
  await mkdir(customDir, { recursive: true });
  return { builtInDir: join(root, "builtin"), customDir };
}

async function waitFor(pred: () => boolean, pokeDir: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the agents watcher");
    await writeFile(join(pokeDir, "watcher-poke"), String(Date.now()));
    await new Promise((r) => setTimeout(r, 50));
  }
}

function stub(name: string): Tool {
  return { name, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ success: true, output: "" }) };
}

test("a file dropped at runtime becomes spawnable without a restart", async () => {
  const dirs = await tempDirs();
  const registry = new AgentRegistry();
  const stop = startAgentsWatcher(dirs, registry, {
    debounceMs: 20,
    getTierDirs: () => editableAgentTierDirs(dirs),
    reload: () => reloadAgents(dirs, registry),
  });
  cleanups.push(() => stop());

  // The spawn tool holds the registry by reference and reads it through a getter, the same shape
  // index.ts wires. Nothing here re-creates the tool: that is the point.
  const spawn = createSpawnTool(
    {} as SubAgentRunner,
    {} as SubAgentRegistry,
    () => [],
    () => registry.list(),
  );
  const enumOf = (): string[] | undefined =>
    (spawn.parameters as { properties: Record<string, { enum?: string[] }> }).properties["type"]?.enum;

  assert.equal(enumOf(), undefined, "no agents yet, so no enum to offer");

  await writeFile(join(dirs.customDir, "reviewer.md"), `---\ndescription: Reviews diffs\n---\n\nReview carefully.`);
  await waitFor(() => registry.exists("reviewer"), dirs.customDir);

  assert.deepEqual(enumOf(), ["reviewer"]);
  assert.match(spawn.description, /reviewer: Reviews diffs/);
}, 15_000);

test("editing a file changes the prompt and the tools of the next run", async () => {
  const dirs = await tempDirs();
  const registry = new AgentRegistry();
  const tools = new ToolRegistry();
  for (const name of ["read", "grep", "bash"]) tools.register(stub(name));

  await writeFile(join(dirs.customDir, "helper.md"), `---\ndescription: Helps\ntools: read, bash\n---\n\nFirst mandate.`);
  await reloadAgents(dirs, registry);

  const before = resolveAgent(config(), registry, "helper");
  assert.equal(before.prompt, "First mandate.");
  assert.deepEqual(
    tools.getForAgent(before.base, [], before.mcp, before.allow).map((t) => t.name).sort(),
    ["bash", "read"],
  );

  // Same registry object, rewritten file: a run after this must see both changes.
  await writeFile(join(dirs.customDir, "helper.md"), `---\ndescription: Helps\ntools: read\n---\n\nSecond mandate.`);
  await reloadAgents(dirs, registry);

  const after = resolveAgent(config(), registry, "helper");
  assert.equal(after.prompt, "Second mandate.");
  assert.deepEqual(tools.getForAgent(after.base, [], after.mcp, after.allow).map((t) => t.name), ["read"]);
});

test("a workspace added to a hot-reloaded config brings its agents with it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agents-ws-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const customDir = join(root, "custom");
  const projectDir = join(root, "project", "agents");
  await mkdir(customDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "deployer.md"), `---\ndescription: Deploys\n---\n`);

  // The tier list is a function, not a snapshot, so a workspace appearing in config.workspaces
  // after boot is scanned without a restart.
  let workspaces: Array<{ key: string; dir: string }> = [];
  const dirs = (): AgentDirs => ({ builtInDir: join(root, "builtin"), customDir, workspaces });
  const registry = new AgentRegistry();

  await reloadAgents(dirs(), registry);
  assert.equal(registry.exists("deployer", "project"), false);

  workspaces = [{ key: "project", dir: projectDir }];
  await reloadAgents(dirs(), registry);
  assert.equal(registry.exists("deployer", "project"), true);
  assert.ok(editableAgentTierDirs(dirs()).includes(projectDir), "and the watcher would follow it too");
});

test("deleting a file stops the agent being offered", async () => {
  const dirs = await tempDirs();
  const registry = new AgentRegistry();
  await writeFile(join(dirs.customDir, "temp.md"), `---\ndescription: Temporary\n---\n`);
  await reloadAgents(dirs, registry);
  assert.equal(registry.exists("temp"), true);

  await rm(join(dirs.customDir, "temp.md"));
  await reloadAgents(dirs, registry);
  assert.equal(registry.exists("temp"), false, "a deleted agent must not survive in the registry");
});

test("cleanup", async () => {
  while (cleanups.length) await cleanups.pop()!();
});
