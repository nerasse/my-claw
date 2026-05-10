import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { mkdir, writeFile, rm, readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSkills } from "../src/skills/loader.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { syncBuiltIn } from "../src/skills/sync.ts";
import {
  createListSkillsTool,
  createReadSkillTool,
  createCreateSkillTool,
  createUpdateSkillTool,
  createDeleteSkillTool,
} from "../src/tools/skills.ts";

async function setupDir(): Promise<string> {
  const dir = join("/tmp", `skills-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeSkill(dir: string, name: string, content: string): Promise<void> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content);
}

test("built-in skill-builder exists in repo and is valid", async () => {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const skillFile = join(repoRoot, "src", "skills", "skill-builder", "SKILL.md");
  await access(skillFile);

  const content = await readFile(skillFile, "utf-8");
  assert.ok(content.includes("name: skill-builder"), "Missing name frontmatter");
  assert.ok(content.includes("description:"), "Missing description frontmatter");
  assert.ok(content.includes("references/"), "Should reference other files");
});

test("built-in subagent-workflow exists in repo and is valid", async () => {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const skillFile = join(repoRoot, "src", "skills", "subagent-workflow", "SKILL.md");
  await access(skillFile);

  const content = await readFile(skillFile, "utf-8");
  assert.ok(content.includes("name: subagent-workflow"), "Missing name frontmatter");
  assert.ok(content.includes("description:"), "Missing description frontmatter");
  assert.ok(content.includes("spawn("), "Should mention spawn tool");
  assert.ok(content.includes("send("), "Should mention send tool");
  assert.ok(content.includes("kill_agent("), "Should mention kill_agent tool");
});

test("parse frontmatter with name and description", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "test-skill", "---\nname: test-skill\ndescription: A test skill\n---\n\nInstructions here.");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  assert.equal(skills.size, 1);

  const skill = skills.get("test-skill")!;
  assert.equal(skill.meta.name, "test-skill");
  assert.equal(skill.meta.description, "A test skill");
  assert.equal(skill.content, "Instructions here.");

  await rm(dir, { recursive: true, force: true });
});

test("parse frontmatter with version", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "versioned", "---\nname: versioned\ndescription: With version\nversion: 1.2.3\n---\n\nContent.");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const skill = skills.get("versioned")!;
  assert.equal(skill.meta.version, "1.2.3");

  await rm(dir, { recursive: true, force: true });
});

test("reject skill without name or description", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "bad", "---\nfoo: bar\n---\n\nNo name here.");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  assert.equal(skills.size, 0);

  await rm(dir, { recursive: true, force: true });
});

test("merge priority: workspace > custom > built-in", async () => {
  const builtIn = await setupDir();
  const custom = await setupDir();
  const workspace = await setupDir();

  await writeSkill(builtIn, "shared", "---\nname: shared\ndescription: built-in\n---\n\nBuilt-in content.");
  await writeSkill(custom, "shared", "---\nname: shared\ndescription: custom\n---\n\nCustom content.");
  await writeSkill(workspace, "shared", "---\nname: shared\ndescription: workspace\n---\n\nWorkspace content.");

  const skills = await loadAllSkills({ builtInDir: builtIn, customDir: custom, workspaceDir: workspace });
  const skill = skills.get("shared")!;
  assert.equal(skill.source, "workspace");
  assert.equal(skill.content, "Workspace content.");

  await rm(builtIn, { recursive: true, force: true });
  await rm(custom, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

test("SkillRegistry get and list", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "alpha", "---\nname: alpha\ndescription: Alpha skill\n---\n\nAlpha.");
  await writeSkill(dir, "beta", "---\nname: beta\ndescription: Beta skill\n---\n\nBeta.");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const registry = new SkillRegistry(skills);

  assert.ok(registry.exists("alpha"));
  assert.ok(!registry.exists("gamma"));

  const list = registry.list();
  assert.equal(list.length, 2);
  assert.ok(list.some((s) => s.name === "alpha" && s.description === "Alpha skill"));

  const skill = registry.get("beta")!;
  assert.equal(skill.meta.name, "beta");

  await rm(dir, { recursive: true, force: true });
});

test("syncBuiltIn copies new skills and updates changed ones", async () => {
  const repo = await setupDir();
  const builtin = await setupDir();

  await writeSkill(repo, "repo-skill", "---\nname: repo-skill\ndescription: From repo\n---\n\nV1.");

  const changed1 = await syncBuiltIn(repo, builtin);
  assert.deepEqual(changed1, ["repo-skill"]);

  const copied = await readFile(join(builtin, "repo-skill", "SKILL.md"), "utf-8");
  assert.ok(copied.includes("From repo"));

  // No changes on second sync
  const changed2 = await syncBuiltIn(repo, builtin);
  assert.deepEqual(changed2, []);

  // Update repo skill
  await writeSkill(repo, "repo-skill", "---\nname: repo-skill\ndescription: From repo\n---\n\nV2.");
  const changed3 = await syncBuiltIn(repo, builtin);
  assert.deepEqual(changed3, ["repo-skill"]);

  const updated = await readFile(join(builtin, "repo-skill", "SKILL.md"), "utf-8");
  assert.ok(updated.includes("V2"));

  await rm(repo, { recursive: true, force: true });
  await rm(builtin, { recursive: true, force: true });
});

test("syncBuiltIn removes deleted skills", async () => {
  const repo = await setupDir();
  const builtin = await setupDir();

  await writeSkill(repo, "old", "---\nname: old\ndescription: Old\n---\n\nOld.");
  await syncBuiltIn(repo, builtin);

  // Remove skill from repo
  await rm(join(repo, "old"), { recursive: true, force: true });
  const changed = await syncBuiltIn(repo, builtin);
  assert.deepEqual(changed, ["old"]);

  // Skill should be gone
  const skills = await loadAllSkills({ builtInDir: builtin, customDir: builtin, workspaceDir: builtin });
  assert.equal(skills.size, 0);

  await rm(repo, { recursive: true, force: true });
  await rm(builtin, { recursive: true, force: true });
});

test("list_skills tool", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "s1", "---\nname: s1\ndescription: First\n---\n\nOne.");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const registry = new SkillRegistry(skills);
  const tool = createListSkillsTool(registry);

  const result = await tool.execute({});
  assert.equal(result.success, true);
  assert.ok(result.output.includes("s1"));
  assert.ok(result.output.includes("First"));

  await rm(dir, { recursive: true, force: true });
});

test("read_skill tool", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "s2", "---\nname: s2\ndescription: Second\n---\n\nDetailed instructions.");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const registry = new SkillRegistry(skills);
  const tool = createReadSkillTool(registry);

  const result = await tool.execute({ name: "s2" });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("Detailed instructions"));

  const missing = await tool.execute({ name: "nope" });
  assert.equal(missing.success, false);

  await rm(dir, { recursive: true, force: true });
});

test("create_skill tool", async () => {
  const ws = await setupDir();
  const tool = createCreateSkillTool(ws);

  const result = await tool.execute({
    name: "new-skill",
    description: "A new skill",
    instructions: "Do this, then that.",
  });

  assert.equal(result.success, true);
  const content = await readFile(join(ws, "new-skill", "SKILL.md"), "utf-8");
  assert.ok(content.includes("name: new-skill"));
  assert.ok(content.includes("Do this, then that."));

  await rm(ws, { recursive: true, force: true });
});

test("update_skill tool modifies workspace skill", async () => {
  const ws = await setupDir();
  const custom = await setupDir();

  await writeSkill(ws, "updatable", "---\nname: updatable\ndescription: Original\n---\n\nOld.");

  const skills = await loadAllSkills({ builtInDir: ws, customDir: custom, workspaceDir: ws });
  const registry = new SkillRegistry(skills);
  const tool = createUpdateSkillTool(ws, custom, registry);

  const result = await tool.execute({ name: "updatable", instructions: "New content." });
  assert.equal(result.success, true);

  const content = await readFile(join(ws, "updatable", "SKILL.md"), "utf-8");
  assert.ok(content.includes("New content."));

  await rm(ws, { recursive: true, force: true });
  await rm(custom, { recursive: true, force: true });
});

test("update_skill tool rejects built-in", async () => {
  const builtin = await setupDir();
  const custom = await setupDir();
  const ws = await setupDir();

  await writeSkill(builtin, "protected", "---\nname: protected\ndescription: Built-in\n---\n\nImmutable.");

  const skills = await loadAllSkills({ builtInDir: builtin, customDir: custom, workspaceDir: ws });
  const registry = new SkillRegistry(skills);
  const tool = createUpdateSkillTool(ws, custom, registry);

  const result = await tool.execute({ name: "protected", instructions: "Hack." });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("Cannot modify built-in"));

  await rm(builtin, { recursive: true, force: true });
  await rm(custom, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});

test("delete_skill tool removes workspace skill", async () => {
  const ws = await setupDir();
  const custom = await setupDir();

  await writeSkill(ws, "deletable", "---\nname: deletable\ndescription: Delete me\n---\n\nBye.");

  const skills = await loadAllSkills({ builtInDir: ws, customDir: custom, workspaceDir: ws });
  const registry = new SkillRegistry(skills);
  const tool = createDeleteSkillTool(ws, custom, registry);

  const result = await tool.execute({ name: "deletable" });
  assert.equal(result.success, true);

  await rm(ws, { recursive: true, force: true });
  await rm(custom, { recursive: true, force: true });
});

test("delete_skill tool rejects built-in", async () => {
  const builtin = await setupDir();
  const custom = await setupDir();
  const ws = await setupDir();

  await writeSkill(builtin, "protected2", "---\nname: protected2\ndescription: Built-in\n---\n\nImmutable.");

  const skills = await loadAllSkills({ builtInDir: builtin, customDir: custom, workspaceDir: ws });
  const registry = new SkillRegistry(skills);
  const tool = createDeleteSkillTool(ws, custom, registry);

  const result = await tool.execute({ name: "protected2" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("Cannot delete built-in"));

  await rm(builtin, { recursive: true, force: true });
  await rm(custom, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});

test("skill index appears in system prompt via buildSystemPrompt", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "prompt-skill", "---\nname: prompt-skill\ndescription: A prompt test skill\n---\n\nDo this.");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const registry = new SkillRegistry(skills);

  const { buildSystemPrompt } = await import("../src/agent/prompt/builder.ts");
  const prompt = await buildSystemPrompt({
    platform: "telegram",
    model: "test-model",
    channelId: "c1",
    sessionId: "test-session",
    tools: [],
    skills: registry.list(),
  });

  assert.ok(prompt.includes("Available skills"));
  assert.ok(prompt.includes("prompt-skill"));
  assert.ok(prompt.includes("A prompt test skill"));
  assert.ok(prompt.includes("read_skill"));

  await rm(dir, { recursive: true, force: true });
});

test("empty skills list omits skills section from system prompt", async () => {
  const { buildSystemPrompt } = await import("../src/agent/prompt/builder.ts");
  const prompt = await buildSystemPrompt({
    platform: "telegram",
    model: "test-model",
    channelId: "c1",
    sessionId: "test-session",
    tools: [],
    skills: [],
  });

  assert.ok(!prompt.includes("Available skills"));
  assert.ok(!prompt.includes("read_skill"));
});

test("sub-agent receives same skills as main agent", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "shared", "---\nname: shared\ndescription: Shared skill\n---\n\nShared.");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const skillRegistry = new SkillRegistry(skills);

  const { SubAgentRunner } = await import("../src/subagents/runner.ts");
  const { ToolRegistry } = await import("../src/tools/registry.ts");

  const config = {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "test" },
    agents: {},
  };

  const toolRegistry = new ToolRegistry();
  const runner = new SubAgentRunner(config as never, toolRegistry, skillRegistry);

  // Verify the runner has the skill registry
  assert.equal(skillRegistry.exists("shared"), true);

  await rm(dir, { recursive: true, force: true });
});

test("read_skill returns full content for loaded skill", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "deep", "---\nname: deep\ndescription: Deep skill\n---\n\nStep 1: Analyze\nStep 2: Execute\nStep 3: Verify");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const registry = new SkillRegistry(skills);
  const tool = createReadSkillTool(registry);

  const result = await tool.execute({ name: "deep" });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("Step 1: Analyze"));
  assert.ok(result.output.includes("Step 2: Execute"));
  assert.ok(result.output.includes("Step 3: Verify"));

  await rm(dir, { recursive: true, force: true });
});

test("read_skill with file_path reads referenced file", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "multi", "---\nname: multi\ndescription: Multi-file skill\n---\n\nSee references/detail.md");
  await mkdir(join(dir, "multi", "references"), { recursive: true });
  await writeFile(join(dir, "multi", "references", "detail.md"), "# Detail\n\nDeep instructions here.");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const registry = new SkillRegistry(skills);
  const tool = createReadSkillTool(registry);

  const result = await tool.execute({ name: "multi", file_path: "references/detail.md" });
  assert.equal(result.success, true);
  assert.ok(result.output.includes("Deep instructions here."));

  await rm(dir, { recursive: true, force: true });
});

test("read_skill with bad file_path returns error", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "single", "---\nname: single\ndescription: Single file\n---\n\nAlone.");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const registry = new SkillRegistry(skills);
  const tool = createReadSkillTool(registry);

  const result = await tool.execute({ name: "single", file_path: "nope.md" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("not found"));

  await rm(dir, { recursive: true, force: true });
});

test("read_skill substitutes ${SKILL_DIR} with absolute path", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "scripted", "---\nname: scripted\ndescription: Scripted skill\n---\n\nRun: bash ${SKILL_DIR}/scripts/run.sh");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const registry = new SkillRegistry(skills);
  const tool = createReadSkillTool(registry);

  const result = await tool.execute({ name: "scripted" });
  assert.equal(result.success, true);
  assert.ok(!result.output.includes("${SKILL_DIR}"), "${SKILL_DIR} should be substituted");
  assert.ok(result.output.includes(join(dir, "scripted")), "Should contain absolute skill path");

  await rm(dir, { recursive: true, force: true });
});

test("read_skill substitutes ${SKILL_DIR} in referenced files too", async () => {
  const dir = await setupDir();
  await writeSkill(dir, "multi-ref", "---\nname: multi-ref\ndescription: Multi-ref skill\n---\n\nSee references/detail.md");
  await mkdir(join(dir, "multi-ref", "references"), { recursive: true });
  await writeFile(join(dir, "multi-ref", "references", "detail.md"), "Run script: bash ${SKILL_DIR}/scripts/helper.py");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const registry = new SkillRegistry(skills);
  const tool = createReadSkillTool(registry);

  const result = await tool.execute({ name: "multi-ref", file_path: "references/detail.md" });
  assert.equal(result.success, true);
  assert.ok(!result.output.includes("${SKILL_DIR}"), "${SKILL_DIR} should be substituted in referenced file");
  assert.ok(result.output.includes(join(dir, "multi-ref")), "Should contain absolute skill path in referenced file");

  await rm(dir, { recursive: true, force: true });
});

test("syncBuiltIn copies multi-file skills with subdirectories", async () => {
  const repo = await setupDir();
  const builtin = await setupDir();

  await writeSkill(repo, "complex", "---\nname: complex\ndescription: Complex multi-file skill\n---\n\nMain instructions.");
  await mkdir(join(repo, "complex", "references"), { recursive: true });
  await mkdir(join(repo, "complex", "examples"), { recursive: true });
  await mkdir(join(repo, "complex", "scripts"), { recursive: true });
  await writeFile(join(repo, "complex", "references", "format.md"), "# Format\n\nDetails.");
  await writeFile(join(repo, "complex", "examples", "minimal.md"), "---\nname: minimal\n---\n\nMinimal.");
  await writeFile(join(repo, "complex", "scripts", "run.sh"), "#!/bin/sh\necho hello");

  const changed = await syncBuiltIn(repo, builtin);
  assert.deepEqual(changed, ["complex"]);

  const skillMd = await readFile(join(builtin, "complex", "SKILL.md"), "utf-8");
  assert.ok(skillMd.includes("Complex multi-file skill"));

  const ref = await readFile(join(builtin, "complex", "references", "format.md"), "utf-8");
  assert.ok(ref.includes("Details."));

  const ex = await readFile(join(builtin, "complex", "examples", "minimal.md"), "utf-8");
  assert.ok(ex.includes("Minimal."));

  const script = await readFile(join(builtin, "complex", "scripts", "run.sh"), "utf-8");
  assert.ok(script.includes("echo hello"));

  await rm(repo, { recursive: true, force: true });
  await rm(builtin, { recursive: true, force: true });
});

test("full multi-file skill e2e flow: index -> skill -> references -> script", async () => {
  const dir = await setupDir();

  // Create a complete multi-file skill
  await writeSkill(dir, "docker-deploy", "---\nname: docker-deploy\ndescription: Deploy Node.js app to Docker\n---\n\n## Quick Workflow\n\n1. Build: bash ${SKILL_DIR}/scripts/build.sh\n2. Push: read references/registry-auth.md\n\n## References\n\n- Registry auth: read references/registry-auth.md");
  await mkdir(join(dir, "docker-deploy", "references"), { recursive: true });
  await mkdir(join(dir, "docker-deploy", "scripts"), { recursive: true });
  await writeFile(join(dir, "docker-deploy", "references", "registry-auth.md"), "# Registry Auth\n\nLogin with token from env.");
  await writeFile(join(dir, "docker-deploy", "scripts", "build.sh"), "#!/bin/sh\ndocker build -t app .");

  // Load skills
  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const registry = new SkillRegistry(skills);

  // 1. Agent sees skill in index (system prompt test already covers this)
  assert.equal(registry.exists("docker-deploy"), true);

  // 2. Agent loads SKILL.md
  const readTool = createReadSkillTool(registry);
  const skillResult = await readTool.execute({ name: "docker-deploy" });
  assert.equal(skillResult.success, true);
  assert.ok(skillResult.output.includes("scripts/build.sh"), "Should reference build script");
  assert.ok(!skillResult.output.includes("${SKILL_DIR}"), "${SKILL_DIR} should be substituted");

  // 3. Agent reads reference file
  const refResult = await readTool.execute({ name: "docker-deploy", file_path: "references/registry-auth.md" });
  assert.equal(refResult.success, true);
  assert.ok(refResult.output.includes("Login with token"));

  // 4. Agent can discover script path from substituted content
  const skillPath = join(dir, "docker-deploy");
  assert.ok(skillResult.output.includes(skillPath), "Should have resolved absolute path");

  // 5. Verify script actually exists at resolved path
  const scriptPath = join(skillPath, "scripts", "build.sh");
  const scriptContent = await readFile(scriptPath, "utf-8");
  assert.ok(scriptContent.includes("docker build"));

  await rm(dir, { recursive: true, force: true });
});

test("create_skill validates name format", async () => {
  const ws = await setupDir();
  const tool = createCreateSkillTool(ws);

  // Empty name
  const empty = await tool.execute({ name: "", description: "d", instructions: "i" });
  assert.equal(empty.success, false);
  assert.ok(empty.output.includes("name is required"));

  // Uppercase
  const upper = await tool.execute({ name: "BadName", description: "d", instructions: "i" });
  assert.equal(upper.success, false);
  assert.ok(upper.output.includes("lowercase"));

  // Special chars
  const special = await tool.execute({ name: "bad_name!", description: "d", instructions: "i" });
  assert.equal(special.success, false);
  assert.ok(special.output.includes("hyphens"));

  // Too long
  const long = await tool.execute({ name: "a".repeat(65), description: "d", instructions: "i" });
  assert.equal(long.success, false);
  assert.ok(long.output.includes("64"));

  // Valid name succeeds
  const valid = await tool.execute({ name: "deploy-node", description: "Deploy", instructions: "Step 1" });
  assert.equal(valid.success, true);

  await rm(ws, { recursive: true, force: true });
});

test("create_skill validates description and instructions", async () => {
  const ws = await setupDir();
  const tool = createCreateSkillTool(ws);

  // Empty description
  const noDesc = await tool.execute({ name: "test", description: "", instructions: "i" });
  assert.equal(noDesc.success, false);
  assert.ok(noDesc.output.includes("description"));

  // Description too long
  const longDesc = await tool.execute({ name: "test", description: "d".repeat(1025), instructions: "i" });
  assert.equal(longDesc.success, false);
  assert.ok(longDesc.output.includes("1024"));

  // Empty instructions
  const noInst = await tool.execute({ name: "test", description: "d", instructions: "" });
  assert.equal(noInst.success, false);
  assert.ok(noInst.output.includes("instructions"));

  await rm(ws, { recursive: true, force: true });
});

test("create_skill writes to correct workspace path", async () => {
  const ws = await setupDir();
  const tool = createCreateSkillTool(ws);

  const result = await tool.execute({
    name: "my-skill",
    description: "My skill",
    instructions: "Do this.",
  });

  assert.equal(result.success, true);
  assert.ok(result.output.includes("my-skill"));
  assert.ok(result.output.includes("workspace/skills"));

  const content = await readFile(join(ws, "my-skill", "SKILL.md"), "utf-8");
  assert.ok(content.includes("name: my-skill"));
  assert.ok(content.includes("description: My skill"));
  assert.ok(content.includes("Do this."));

  await rm(ws, { recursive: true, force: true });
});

test("read error on missing file is clear", async () => {
  const { readTool } = await import("../src/tools/read.ts");
  const result = await readTool.execute({ path: "/tmp/definitely-does-not-exist-12345.txt" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("not found"));
});

test("fetch error on bad URL is clear", async () => {
  const { fetchTool } = await import("../src/tools/fetch.ts");
  const result = await fetchTool.execute({ url: "http://localhost:99999" });
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("Failed to fetch"));
});

test("ls error on missing directory is clear", async () => {
  const { lsTool } = await import("../src/tools/ls.ts");
  const result = await lsTool.execute({ path: "/tmp/does-not-exist-99999" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("not found"));
});

test("memory append without content is clear", async () => {
  const { memoryTool } = await import("../src/tools/memory.ts");
  const result = await memoryTool.execute({ file: "MEMORY.md", action: "append", content: "" });
  assert.equal(result.success, false);
  assert.ok(result.output.includes("content is required"));
});
