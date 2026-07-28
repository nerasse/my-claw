import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/core/config.ts";
import { loadPromptFile, resetPromptFileCache } from "../../src/agent/prompt/loader.ts";
import { loadAllSkills, resetSkillLastGood } from "../../src/skills/loader.ts";
import { PluginLoader } from "../../src/tools/plugins.ts";
import { isTracked } from "../../src/core/config-store.ts";

describe("structural guard", () => {
  test("accepts a config with sections missing", () => {
    // Deleting a section stays legal: the watcher empties the live section, which is what a
    // restart produces too. The guard only exists to reject unusable types.
    const config = parseConfig(JSON.stringify({ channels: {} }));
    expect(config.llm).toBeUndefined();
  });

  test("rejects a hot section of the wrong type", () => {
    expect(() => parseConfig(JSON.stringify({ llm: "oops" }))).toThrow(/"llm" must be an object/);
    expect(() => parseConfig(JSON.stringify({ voice: 42 }))).toThrow(/"voice" must be an object/);
    expect(() => parseConfig(JSON.stringify({ llm: ["a"] }))).toThrow(/got array/);
  });

  test("rejects array sections given a non-array", () => {
    expect(() => parseConfig(JSON.stringify({ whitelist: "me" }))).toThrow(/"whitelist" must be an array/);
  });

  test("rejects a top-level non-object", () => {
    expect(() => parseConfig("[]")).toThrow(/must contain a JSON object/);
    expect(() => parseConfig("42")).toThrow(/must contain a JSON object/);
  });

  test("null sections pass through as absent", () => {
    expect(() => parseConfig(JSON.stringify({ llm: null }))).not.toThrow();
  });

  test("a config with no channels key defaults instead of crashing", () => {
    // applySecretOverrides dereferences config.channels.telegram; the type says the key is
    // required, which is why nothing ever checked it.
    const config = parseConfig(JSON.stringify({ llm: {} }));
    expect(config.channels).toEqual({});
  });
});

describe("prompt loader keeps the last good content", () => {
  let ws: string;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "claw-prompt-"));
    process.env["MY_CLAW_WORKSPACE"] = ws;
    resetPromptFileCache();
  });

  afterEach(async () => {
    delete process.env["MY_CLAW_WORKSPACE"];
    await rm(ws, { recursive: true, force: true });
  });

  test("a deleted file keeps serving the last content instead of an empty layer", async () => {
    await writeFile(join(ws, "SOUL.md"), "je suis moi");
    expect(await loadPromptFile("SOUL.md")).toBe("je suis moi");

    await rm(join(ws, "SOUL.md"));
    // Previously returned "" and dropped the cache, silently removing a whole prompt layer.
    expect(await loadPromptFile("SOUL.md")).toBe("je suis moi");
  });

  test("a never-readable file still yields an empty string", async () => {
    expect(await loadPromptFile("ABSENT.md")).toBe("");
  });

  test("an edit still lands on the next read", async () => {
    await writeFile(join(ws, "USER.md"), "v1");
    expect(await loadPromptFile("USER.md")).toBe("v1");
    await writeFile(join(ws, "USER.md"), "v2");
    resetPromptFileCache();
    expect(await loadPromptFile("USER.md")).toBe("v2");
  });
});

describe("skills keep the last parseable version", () => {
  let root: string;
  let tier: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claw-skills-"));
    tier = join(root, "skills");
    await mkdir(join(tier, "demo"), { recursive: true });
    resetSkillLastGood();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const dirs = (): { builtInDir: string; customDir: string; workspaceDir: string } => ({
    builtInDir: join(root, "absent-builtin"),
    customDir: tier,
    workspaceDir: join(root, "absent-workspace"),
  });

  test("a frontmatter broken by an edit does not make the skill vanish", async () => {
    const file = join(tier, "demo", "SKILL.md");
    await writeFile(file, "---\nname: demo\ndescription: fait des choses\n---\ncorps v1");
    expect((await loadAllSkills(dirs())).get("demo")?.content).toBe("corps v1");

    await writeFile(file, "corps sans frontmatter");
    const after = await loadAllSkills(dirs());
    expect(after.get("demo")?.content).toBe("corps v1");
  });

  test("a deleted skill really disappears", async () => {
    const file = join(tier, "demo", "SKILL.md");
    await writeFile(file, "---\nname: demo\ndescription: d\n---\ncorps");
    expect((await loadAllSkills(dirs())).has("demo")).toBe(true);

    await rm(join(tier, "demo"), { recursive: true, force: true });
    expect((await loadAllSkills(dirs())).has("demo")).toBe(false);
  });

  test("a skill that never parsed is not invented", async () => {
    await writeFile(join(tier, "demo", "SKILL.md"), "pas de frontmatter du tout");
    expect((await loadAllSkills(dirs())).has("demo")).toBe(false);
  });

  test("built-in skills are not snapshotted", async () => {
    // They are resynced from the repo by hash at every boot, so archiving them would store a copy
    // of the release on each upgrade for something this repo already versions.
    const builtIn = join(root, "builtin");
    await mkdir(join(builtIn, "bi"), { recursive: true });
    await writeFile(join(builtIn, "bi", "SKILL.md"), "---\nname: bi\ndescription: d\n---\ncorps");
    await loadAllSkills({ ...dirs(), builtInDir: builtIn });

    expect(await isTracked(join(builtIn, "bi", "SKILL.md"))).toBe(false);
    expect(await isTracked(join(tier, "demo", "SKILL.md"))).toBe(false);
  });
});

describe("plugin loader keeps the last good set", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claw-plugins-"));
  });

  afterEach(async () => {
    await chmod(root, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  test("an unreadable tools.d keeps the tools already loaded", async () => {
    const dir = join(root, "tools.d");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "ping.ts"),
      `export const tool = {
        name: "ping", description: "pong", parameters: { type: "object", properties: {} },
        execute: async () => ({ success: true, output: "pong" }),
      };`,
    );
    const loader = new PluginLoader(dir, new Set());
    expect(await loader.load()).toBe(1);

    await rm(dir, { recursive: true, force: true });
    // Previously reset to [], so a transient error looked like "plugins were never configured".
    expect(await loader.load()).toBe(1);
    expect(loader.getTools()).toHaveLength(1);
  });

  test("an absent tools.d on first load is still zero tools", async () => {
    const loader = new PluginLoader(join(root, "never"), new Set());
    expect(await loader.load()).toBe(0);
  });
});
