import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { reloadSkills } from "../../src/skills/reload.ts";
import { startSkillsWatcher } from "../../src/skills/watcher.ts";

const cleanups: Array<() => void | Promise<void>> = [];
async function tempDirs(): Promise<{ builtInDir: string; customDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "skills-w-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const customDir = join(root, "custom");
  const workspaceDir = join(root, "workspace");
  const builtInDir = join(root, "builtin");
  await mkdir(customDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  return { builtInDir, customDir, workspaceDir };
}

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody for ${name}.\n`);
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  for (let i = 0; i < timeoutMs / 20 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
}

test("reloadSkills rescans dirs and swaps the registry contents", async () => {
  const dirs = await tempDirs();
  const registry = new SkillRegistry();
  assert.equal(registry.list().length, 0);

  await writeSkill(dirs.customDir, "alpha", "first skill");
  const count = await reloadSkills(dirs, registry);
  assert.equal(count, 1);
  assert.equal(registry.exists("alpha"), true);
});

test("watcher picks up a newly added skill dir without restart", async () => {
  const dirs = await tempDirs();
  const registry = new SkillRegistry();
  const stop = startSkillsWatcher(dirs, registry, { debounceMs: 20 });
  cleanups.push(() => stop());
  // Give the async watcher setup a tick to attach the tier watchers.
  await new Promise((r) => setTimeout(r, 50));

  await writeSkill(dirs.customDir, "beta", "added at runtime");
  await waitFor(() => registry.exists("beta"));
  assert.equal(registry.exists("beta"), true);
});

test("watcher picks up an edit to an existing SKILL.md", async () => {
  const dirs = await tempDirs();
  // Skill must exist before start so its child watcher is attached.
  await writeSkill(dirs.workspaceDir, "gamma", "original description");
  const registry = new SkillRegistry();
  await reloadSkills(dirs, registry);
  assert.equal(registry.list().find((s) => s.name === "gamma")?.description, "original description");

  const stop = startSkillsWatcher(dirs, registry, { debounceMs: 20 });
  cleanups.push(() => stop());
  await new Promise((r) => setTimeout(r, 50));

  await writeSkill(dirs.workspaceDir, "gamma", "edited description");
  await waitFor(() => registry.list().find((s) => s.name === "gamma")?.description === "edited description");
  assert.equal(registry.list().find((s) => s.name === "gamma")?.description, "edited description");
});

test("watcher drops a removed skill", async () => {
  const dirs = await tempDirs();
  await writeSkill(dirs.customDir, "delta", "to be removed");
  const registry = new SkillRegistry();
  await reloadSkills(dirs, registry);
  assert.equal(registry.exists("delta"), true);

  const stop = startSkillsWatcher(dirs, registry, { debounceMs: 20 });
  cleanups.push(() => stop());
  await new Promise((r) => setTimeout(r, 50));

  await rm(join(dirs.customDir, "delta"), { recursive: true, force: true });
  await waitFor(() => !registry.exists("delta"));
  assert.equal(registry.exists("delta"), false);
});

test("stop() detaches watchers (no reload after stop)", async () => {
  const dirs = await tempDirs();
  const registry = new SkillRegistry();
  let reloads = 0;
  const stop = startSkillsWatcher(dirs, registry, {
    debounceMs: 20,
    reload: async () => { reloads += 1; return 0; },
  });
  await new Promise((r) => setTimeout(r, 50));
  stop();
  await writeSkill(dirs.customDir, "epsilon", "after stop");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(reloads, 0);
});

test("cleanup", async () => {
  while (cleanups.length) await cleanups.pop()!();
});
