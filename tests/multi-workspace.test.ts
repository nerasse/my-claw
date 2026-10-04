import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptFile, loadCorePrompt, resetPromptFileCache } from "../src/agent/prompt/loader.ts";
import { buildSystemPrompt, type PromptContext } from "../src/agent/prompt/builder.ts";
import { loadAllSkills, resetSkillLastGood } from "../src/skills/loader.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { applyHotReload } from "../src/core/config-watcher.ts";
import {
  parseConfig,
  findUnknownAgentWorkspaces,
  resolveAgentWorkspace,
  resolveWorkspaceDir,
  resolveWorkspaceKey,
  workspaceKeyForDir,
  MY_CLAW_DIR,
  type MyClawConfig,
} from "../src/core/config.ts";
import { createJob, updateJob } from "../src/cron/store.ts";

const cleanups: Array<() => Promise<void>> = [];
const prevWorkspace = process.env["MY_CLAW_WORKSPACE"];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  resetPromptFileCache();
  resetSkillLastGood();
  if (prevWorkspace === undefined) delete process.env["MY_CLAW_WORKSPACE"];
  else process.env["MY_CLAW_WORKSPACE"] = prevWorkspace;
});

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ws-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function configWith(workspaces: Record<string, string>): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: { provider: "t", baseUrl: "u", model: "m" },
    agents: {},
    workspaces,
  } as MyClawConfig;
}

// --- Config validation and resolution ---

test("relative workspace paths are rejected at parse", () => {
  assert.throws(() => parseConfig(JSON.stringify({ workspaces: { bad: "relative/path" } })));
  assert.throws(() => parseConfig(JSON.stringify({ workspaces: { bad: 42 } })));
});

test("the reserved default key and slash keys are rejected", () => {
  assert.throws(() => parseConfig(JSON.stringify({ workspaces: { default: "/tmp/x" } })));
  assert.throws(() => parseConfig(JSON.stringify({ workspaces: { "a/b": "/tmp/x" } })));
});

test("absolute workspace paths parse and resolve", () => {
  const config = parseConfig(JSON.stringify({ workspaces: { sofa: "/tmp/sofa" } }));
  assert.equal(resolveWorkspaceKey(config, "sofa"), "/tmp/sofa");
  assert.equal(resolveWorkspaceKey(config, undefined), resolveWorkspaceDir(undefined));
  assert.equal(resolveWorkspaceDir(undefined), join(MY_CLAW_DIR, "workspace"));
});

test("an unknown workspace key falls back to the default instead of throwing", () => {
  assert.equal(resolveWorkspaceKey(configWith({}), "nope"), resolveWorkspaceDir(undefined));
});

test("editing workspaces is a hot reload, not a reboot", () => {
  const current = configWith({});
  const next = configWith({ sofa: "/tmp/sofa" });
  const result = applyHotReload(current, next);
  assert.ok(result.changed.includes("workspaces"));
  assert.ok(!result.rebootRequired.includes("workspaces"));
  assert.equal(current.workspaces?.["sofa"], "/tmp/sofa");
});

// --- Per-file prompt resolution with fallback ---

test("a missing file in a secondary workspace falls back to the default", async () => {
  const secondary = await tmpDir();
  const def = await tmpDir();
  await writeFile(join(def, "SOUL.md"), "default soul");
  await writeFile(join(secondary, "AGENTS.md"), "project agents");

  assert.equal(await loadPromptFile("SOUL.md", { workspaceDir: secondary, defaultWorkspaceDir: def }), "default soul");
  assert.equal(await loadPromptFile("AGENTS.md", { workspaceDir: secondary, defaultWorkspaceDir: def }), "project agents");
  // Missing in both workspaces: the ladder lands on the shipped template, which is what the
  // instructions page has always shown for that state.
  const template = await readFile(join(import.meta.dir, "..", "docs", "prompt", "USER.md"), "utf-8");
  assert.equal(await loadPromptFile("USER.md", { workspaceDir: secondary, defaultWorkspaceDir: def }), template);
});

test("a file present in the secondary workspace shadows the default", async () => {
  const secondary = await tmpDir();
  const def = await tmpDir();
  await writeFile(join(def, "SOUL.md"), "default soul");
  await writeFile(join(secondary, "SOUL.md"), "project soul");

  assert.equal(await loadPromptFile("SOUL.md", { workspaceDir: secondary, defaultWorkspaceDir: def }), "project soul");
});

test("prompts from two workspaces coexist in the cache", async () => {
  const secondary = await tmpDir();
  const def = await tmpDir();
  await writeFile(join(secondary, "AGENTS.md"), "A");
  await writeFile(join(def, "AGENTS.md"), "B");
  assert.equal(await loadPromptFile("AGENTS.md", { workspaceDir: secondary, defaultWorkspaceDir: def }), "A");
  assert.equal(await loadPromptFile("AGENTS.md", { workspaceDir: def, defaultWorkspaceDir: def }), "B");
  // The cache is keyed per absolute path: deleting the secondary's file falls back to the
  // default instead of serving the secondary's cached copy.
  await rm(join(secondary, "AGENTS.md"));
  assert.equal(await loadPromptFile("AGENTS.md", { workspaceDir: secondary, defaultWorkspaceDir: def }), "B");
});

test("the built prompt uses the run's workspace and falls back per file", async () => {
  const secondary = await tmpDir();
  const def = await tmpDir();
  await writeFile(join(def, "SOUL.md"), "default soul");
  await writeFile(join(secondary, "AGENTS.md"), "project agents");

  const ctx: PromptContext = {
    platform: "test",
    model: "m",
    sessionId: "s",
    tools: [],
    skills: [],
    workspaceDir: secondary,
    defaultWorkspaceDir: def,
  };
  const prompt = await buildSystemPrompt(ctx);
  assert.ok(prompt.includes("default soul"));
  assert.ok(prompt.includes("project agents"));
});

// --- Workspace-scoped skills ---

async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}`);
}

test("the same skill name in two workspaces never collides globally", async () => {
  const builtin = await tmpDir();
  const custom = await tmpDir();
  const defaultWs = await tmpDir();
  const a = await tmpDir();
  const b = await tmpDir();
  await writeSkill(builtin, "shared", "built-in");
  await writeSkill(custom, "shared", "custom");
  await writeSkill(defaultWs, "default-ws-skill", "default");
  await writeSkill(a, "shared", "from A");
  await writeSkill(b, "shared", "from B");

  const all = await loadAllSkills({
    builtInDir: builtin,
    customDir: custom,
    workspaceDir: defaultWs,
    workspaces: [
      { key: "a", dir: a },
      { key: "b", dir: b },
    ],
  });
  const registry = new SkillRegistry(all);

  // In workspace A, A's skill wins; in workspace B, B's. The custom layer wins elsewhere.
  assert.equal(registry.get("shared", "a")!.content.trim(), "from A");
  assert.equal(registry.get("shared", "b")!.content.trim(), "from B");
  assert.equal(registry.get("shared")!.content.trim(), "custom");

  // A run in B sees built-in + custom + B's skills, never A's nor the default workspace's.
  // Counted, not `includes`: the layers used to be listed side by side, which no `includes`
  // assertion can see.
  const names = (s: string | undefined) => registry.list("all", s).map((i) => i.name);
  const occurrences = (s: string | undefined, name: string) => names(s).filter((n) => n === name).length;
  assert.equal(occurrences("b", "shared"), 1);
  assert.equal(registry.list("all", "b").find((i) => i.name === "shared")!.workspace, "b");
  assert.equal(occurrences("b", "default-ws-skill"), 0);
  assert.equal(occurrences(undefined, "default-ws-skill"), 1);
  assert.equal(occurrences(undefined, "shared"), 1);
  // The default workspace has no "shared" of its own, so custom is what a default run resolves.
  assert.equal(registry.list("all", undefined).find((i) => i.name === "shared")!.source, "custom");

  // The browse catalog is the opposite: every workspace, so the app can show them all.
  const catalog = registry.listAll();
  assert.deepEqual(
    catalog.filter((s) => s.name === "shared").map((s) => s.workspace ?? "-").sort(),
    ["-", "a", "b"],
  );
  assert.ok(catalog.some((s) => s.name === "default-ws-skill" && s.workspace === "default"));

  // The catalog says which copy wins, or showing three of them is misleading rather than honest.
  const global = catalog.find((s) => s.name === "shared" && s.workspace === undefined)!;
  assert.deepEqual(global.overriddenIn, ["a", "b"]);
  assert.equal(global.overrides, undefined);
  assert.equal(catalog.find((s) => s.name === "shared" && s.workspace === "a")!.overrides, "custom");
  assert.equal(catalog.find((s) => s.name === "default-ws-skill")!.overrides, undefined);
  assert.equal(catalog.find((s) => s.name === "default-ws-skill")!.overriddenIn, undefined);

  // The resolved view never carries them: it has no masked entry left to explain.
  assert.equal(registry.list("all", "a").find((s) => s.name === "shared")!.overriddenIn, undefined);
});

test("a workspace skill that masks a built-in says so", async () => {
  const builtin = await tmpDir();
  const a = await tmpDir();
  await writeSkill(builtin, "forgejo", "shipped");
  await writeSkill(a, "forgejo", "forked");

  const registry = new SkillRegistry(
    await loadAllSkills({ builtInDir: builtin, customDir: await tmpDir(), workspaces: [{ key: "a", dir: a }] }),
  );

  assert.equal(registry.listAll().find((s) => s.workspace === "a")!.overrides, "built-in");
});

test("read_skill follows the run's workspace", async () => {
  const dir = await tmpDir();
  const a = await tmpDir();
  await writeSkill(dir, "shared", "custom copy");
  await writeSkill(a, "only-a", "A only");
  await writeSkill(a, "shared", "A copy");
  const all = await loadAllSkills({
    builtInDir: dir,
    customDir: dir,
    workspaces: [{ key: "a", dir: a }],
  });
  const registry = new SkillRegistry(all);

  const { createReadSkillTool } = await import("../src/tools/skills.ts");
  const config = configWith({ a });
  const read = createReadSkillTool(registry, config);

  const inA = await read.execute({ name: "shared", __workspaceDir: a });
  assert.match(inA.output, /A copy/);
  const inDefault = await read.execute({ name: "shared", __workspaceDir: dir });
  assert.match(inDefault.output, /custom copy/);
  // What a refusal names follows the workspace too: another project's skills are not offered.
  assert.match((await read.execute({ name: "nope", __workspaceDir: a })).output, /only-a/);
  assert.doesNotMatch((await read.execute({ name: "nope", __workspaceDir: dir })).output, /only-a/);
});

// --- Per-agent workspaces ---

test("an agent's configured workspace resolves, without inheriting from the orchestrator", () => {
  const config = {
    ...configWith({ sofa: "/tmp/sofa" }),
    agents: { orchestrator: { workspace: "sofa" }, research: {} },
  } as MyClawConfig;

  assert.equal(resolveAgentWorkspace(config, "main"), "sofa");
  // No inheritance: pinning the main agent must not drag every sub-agent and cron job with it.
  assert.equal(resolveAgentWorkspace(config, "research"), undefined);
  assert.equal(resolveAgentWorkspace(config, "cron"), undefined);
});

test("an agent workspace key that matches nothing is reported at boot", () => {
  const config = {
    ...configWith({ sofa: "/tmp/sofa" }),
    agents: { research: { workspace: "ghost" }, cron: { workspace: "sofa" } },
  } as MyClawConfig;

  assert.deepEqual(findUnknownAgentWorkspaces(config), [
    { path: "agents.research.workspace", key: "ghost" },
  ]);
});

test("a directory maps back to its workspace key", () => {
  const config = configWith({ sofa: "/tmp/sofa" });
  assert.equal(workspaceKeyForDir(config, "/tmp/sofa"), "sofa");
  assert.equal(workspaceKeyForDir(config, resolveWorkspaceDir(config.workspace)), undefined);
  assert.equal(workspaceKeyForDir(config, "/tmp/elsewhere"), undefined);
  assert.equal(workspaceKeyForDir(config, undefined), undefined);
});

// --- Cron workspace field ---

test("a job carries its workspace key through create and update", () => {
  const job = createJob({
    prompt: "task",
    schedule: "every 30m",
    origin: null,
    deliver: "local",
    workspace: "sofa",
  });
  assert.equal(job.workspace, "sofa");

  const updated = updateJob([job], job.id, { workspace: "" });
  assert.equal(updated!.workspace, undefined);
});
