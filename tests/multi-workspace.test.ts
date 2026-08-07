import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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

test("an unknown workspace key throws loudly instead of resolving to the default", () => {
  assert.throws(() => resolveWorkspaceKey(configWith({}), "nope"), /Unknown workspace key/);
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

  assert.equal(await loadPromptFile("SOUL.md", secondary, def), "default soul");
  assert.equal(await loadPromptFile("AGENTS.md", secondary, def), "project agents");
  assert.equal(await loadPromptFile("USER.md", secondary, def), "");
});

test("a file present in the secondary workspace shadows the default", async () => {
  const secondary = await tmpDir();
  const def = await tmpDir();
  await writeFile(join(def, "SOUL.md"), "default soul");
  await writeFile(join(secondary, "SOUL.md"), "project soul");

  assert.equal(await loadPromptFile("SOUL.md", secondary, def), "project soul");
});

test("prompts from two workspaces coexist in the cache", async () => {
  const secondary = await tmpDir();
  const def = await tmpDir();
  await writeFile(join(secondary, "AGENTS.md"), "A");
  await writeFile(join(def, "AGENTS.md"), "B");
  assert.equal(await loadPromptFile("AGENTS.md", secondary, def), "A");
  assert.equal(await loadPromptFile("AGENTS.md", def, def), "B");
  // The cache is keyed per absolute path: deleting the secondary's file falls back to the
  // default instead of serving the secondary's cached copy.
  await rm(join(secondary, "AGENTS.md"));
  assert.equal(await loadPromptFile("AGENTS.md", secondary, def), "B");
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
  const names = (s: string | undefined) => registry.list("all", s).map((i) => i.name);
  assert.ok(names("b").includes("shared"));
  assert.ok(!names("b").includes("default-ws-skill"));
  assert.ok(names(undefined).includes("default-ws-skill"));
  assert.ok(!names(undefined).includes("from A"));

  // The browse catalog is the opposite: every workspace, so the app can show them all.
  const catalog = registry.listAll();
  assert.deepEqual(
    catalog.filter((s) => s.name === "shared").map((s) => s.workspace ?? "-").sort(),
    ["-", "a", "b"],
  );
  assert.ok(catalog.some((s) => s.name === "default-ws-skill" && s.workspace === "default"));
});

test("read_skill and list_skills follow the run's workspace", async () => {
  const dir = await tmpDir();
  const a = await tmpDir();
  await writeSkill(dir, "shared", "custom copy");
  await writeSkill(a, "shared", "A copy");
  const all = await loadAllSkills({
    builtInDir: dir,
    customDir: dir,
    workspaces: [{ key: "a", dir: a }],
  });
  const registry = new SkillRegistry(all);

  const { createReadSkillTool, createListSkillsTool } = await import("../src/tools/skills.ts");
  const config = configWith({ a });
  const read = createReadSkillTool(registry, config);
  const list = createListSkillsTool(registry, config);

  const inA = await read.execute({ name: "shared", __workspaceDir: a });
  assert.match(inA.output, /A copy/);
  const inDefault = await read.execute({ name: "shared", __workspaceDir: dir });
  assert.match(inDefault.output, /custom copy/);
  const listed = await list.execute({ __workspaceDir: a });
  assert.match(listed.output, /shared/);
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
