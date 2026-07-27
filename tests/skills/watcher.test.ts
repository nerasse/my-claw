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

/**
 * Bun's fs.watch is not active when watch() returns, so the mutation under test can beat
 * registration and be lost outright -- a longer wait never recovers it. The watcher rescans
 * every dir on any event, so poking the directory until the expectation holds is immune to
 * that race. The poke is a plain file, which `src/skills/loader.ts:67` skips because it is not
 * a directory, so it can never register as a skill. Its name must NOT start with a dot:
 * measured in Bun 1.3, a dotfile created after the watcher attached produces no events at all
 * (a pre-existing dotfile does, which is why production `.env` rotation works).
 * Throws on timeout: a bounded loop that returns quietly reports a value mismatch instead of
 * "the watcher never fired".
 */
async function waitFor(pred: () => boolean, pokeDir: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for the skills watcher (poking ${pokeDir})`);
    await writeFile(join(pokeDir, "watcher-poke"), String(Date.now()));
    await new Promise((r) => setTimeout(r, 50));
  }
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

  await writeSkill(dirs.customDir, "beta", "added at runtime");
  await waitFor(() => registry.exists("beta"), dirs.customDir);
  assert.equal(registry.exists("beta"), true);
}, 15_000);

test("watcher picks up an edit to an existing SKILL.md", async () => {
  const dirs = await tempDirs();
  // Skill must exist before start so its child watcher is attached.
  await writeSkill(dirs.workspaceDir, "gamma", "original description");
  const registry = new SkillRegistry();
  await reloadSkills(dirs, registry);
  assert.equal(registry.list().find((s) => s.name === "gamma")?.description, "original description");

  const stop = startSkillsWatcher(dirs, registry, { debounceMs: 20 });
  cleanups.push(() => stop());

  await writeSkill(dirs.workspaceDir, "gamma", "edited description");
  await waitFor(() => registry.list().find((s) => s.name === "gamma")?.description === "edited description", dirs.workspaceDir);
  assert.equal(registry.list().find((s) => s.name === "gamma")?.description, "edited description");
}, 15_000);

test("watcher drops a removed skill", async () => {
  const dirs = await tempDirs();
  await writeSkill(dirs.customDir, "delta", "to be removed");
  const registry = new SkillRegistry();
  await reloadSkills(dirs, registry);
  assert.equal(registry.exists("delta"), true);

  const stop = startSkillsWatcher(dirs, registry, { debounceMs: 20 });
  cleanups.push(() => stop());

  await rm(join(dirs.customDir, "delta"), { recursive: true, force: true });
  await waitFor(() => !registry.exists("delta"), dirs.customDir);
  assert.equal(registry.exists("delta"), false);
}, 15_000);

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
