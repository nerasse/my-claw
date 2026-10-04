/**
 * The browser agent reads its workspace's rules (docs/browser.md). It used to get neither the
 * AGENTS.md of the workspace nor the skills, so the conversation driving it had to copy the rules
 * of an application (wording, what never to state) into every brief. What it gets is exactly that
 * and no more: two read-only tools, under the same skill scope as any agent, and still no MCP, no
 * shell, no file writes.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { resolveAgent } from "../../src/agents/resolve.ts";
import { createReadSkillTool } from "../../src/tools/skills.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { loadAllSkills } from "../../src/skills/loader.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { Tool } from "../../src/tools/types.ts";

const stub = (name: string): Tool => ({ name, description: "", parameters: {}, execute: async () => ({ success: true, output: "" }) });

const base = { whitelist: [], blacklist: [], channels: {}, llm: { models: [] }, agents: {} } as unknown as MyClawConfig;

test("the browser's tools: its own, plus reading skills, and nothing that writes or reaches out", () => {
  const registry = new ToolRegistry();
  for (const name of ["browser_navigate", "browser_done", "read_skill", "bash", "write", "fetch", "memory", "manage_skills"]) {
    registry.register(stub(name));
  }
  registry.setDynamicProvider(() => [stub("mcp__gmail__search")]);
  const names = registry.getForAgent("browser").map((t) => t.name).sort();
  expect(names).toEqual(["browser_done", "browser_navigate", "read_skill"]);
});

test("its skill scope follows the ordinary chain, so the config can narrow it or take it away", () => {
  expect(resolveAgent(base, undefined, "browser").skills).toBe("all");
  const narrowed = { ...base, agents: { browser: { skills: ["career-routine"] } } } as unknown as MyClawConfig;
  expect(resolveAgent(narrowed, undefined, "browser").skills).toEqual(["career-routine"]);
  const none = { ...base, agents: { browser: { skills: [] } } } as unknown as MyClawConfig;
  expect(resolveAgent(none, undefined, "browser").skills).toEqual([]);
  // A page is untrusted content: no MCP server is reachable from it, whatever the config says.
  const mcp = { ...base, agents: { browser: { mcp: "all" } } } as unknown as MyClawConfig;
  expect(resolveAgent(mcp, undefined, "browser").mcp).toEqual([]);
});

test("read_skill refuses a file a link inside the skill points out of it", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-link-"));
  const skills = join(root, "skills");
  await mkdir(join(skills, "career"), { recursive: true });
  await writeFile(join(skills, "career", "SKILL.md"), "---\nname: career\ndescription: d\n---\n\nbody");
  await writeFile(join(root, "secret.env"), "API_KEY=do-not-read");
  await symlink(join(root, "secret.env"), join(skills, "career", "notes.md"));
  await writeFile(join(skills, "career", "real.md"), "inside");

  const registry = new SkillRegistry(await loadAllSkills({ builtInDir: skills, customDir: skills }));
  const tool = createReadSkillTool(registry, base);
  const escaped = await tool.execute({ name: "career", file_path: "notes.md" });
  expect(escaped.success).toBe(false);
  expect(escaped.output).toContain("leads out of the skill directory");
  expect(escaped.output).not.toContain("do-not-read");
  expect((await tool.execute({ name: "career", file_path: "real.md" })).output).toContain("inside");
});
