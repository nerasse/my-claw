import type { Tool, ToolResult } from "../tools/types.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { mkdir, readFile, access, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { formatError } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";
import { reloadSkills } from "../skills/reload.ts";
import { parsesAsSkill } from "../skills/loader.ts";
import { scanForInjection } from "../agent/prompt/anti-injection.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { snapshot } from "../core/config-store.ts";
import { resolveAgentSkills, scopeAllows, type AgentScope, type AgentToolType, type MyClawConfig } from "../core/config.ts";

/**
 * The calling agent's skill scope, read from the `__agentType` the backends attach to every tool
 * call. Absent means the call did not come from an agent run, which resolves to the orchestrator --
 * the same default the `/skills` command uses for a missing argument. See docs/agent-scoping.md.
 */
function scopeFromArgs(config: MyClawConfig, args: Record<string, unknown>): AgentScope {
  const raw = args["__agentType"];
  const type: AgentToolType = raw === "general" || raw === "research" || raw === "cron" ? raw : "main";
  return resolveAgentSkills(config, type);
}

const MAX_NAME_LENGTH = 64;
const MAX_DESC_LENGTH = 1024;
const VALID_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validateSkillName(name: string): string | null {
  if (!name) return "name is required.";
  if (name.length > MAX_NAME_LENGTH) return `name must be at most ${MAX_NAME_LENGTH} characters (got ${name.length}).`;
  if (!VALID_NAME_RE.test(name)) return `name must be lowercase alphanumeric with hyphens only (e.g., 'deploy-node', 'security-audit'). Got: "${name}".`;
  return null;
}

function validateSkillDescription(desc: string): string | null {
  if (!desc) return "description is required.";
  if (desc.length > MAX_DESC_LENGTH) return `description must be at most ${MAX_DESC_LENGTH} characters (got ${desc.length}).`;
  return null;
}

export function createListSkillsTool(registry: SkillRegistry, config: MyClawConfig): Tool {
  return {
    name: "list_skills",
    description: "List all available skills with their name, description, and source.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (args: Record<string, unknown>) => {
      // Must match the prompt catalog: listing more than the scope would advertise skills that
      // read_skill then refuses.
      const skills = registry.list(scopeFromArgs(config, args));
      if (skills.length === 0) {
        return { success: true, output: "No skills available." };
      }
      const lines = skills.map(
        (s) => `- ${s.name}: ${s.description} (source: ${s.source})`,
      );
      return { success: true, output: lines.join("\n") };
    },
  };
}

export function createReadSkillTool(registry: SkillRegistry, config: MyClawConfig): Tool {
  return {
    name: "read_skill",
    description: "Read the full content of a skill by name. If file_path is provided, reads a specific file within the skill directory (e.g., 'references/format.md'). Call this when a skill matches your task or when the skill references a file you need.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the skill to read" },
        file_path: { type: "string", description: "Optional relative path within the skill directory (e.g., 'references/format.md', 'examples/minimal.md')" },
      },
      required: ["name"],
    },
    execute: async (args: Record<string, unknown>) => {
      const name = String(args["name"] ?? "");
      const filePath = args["file_path"] ? String(args["file_path"]) : undefined;
      const skill = registry.get(name);
      if (!skill) {
        return { success: false, output: `Skill "${name}" not found. Use list_skills() to see available skills.` };
      }
      // Existence is checked first on purpose: "not in scope" for a name that does not exist at all
      // would send the agent looking for a permission problem instead of a typo.
      if (!scopeAllows(scopeFromArgs(config, args), name)) {
        return { success: false, output: `Skill "${name}" is not in this agent's scope. Use list_skills() to see the skills available to you.` };
      }

      const skillDir = dirname(skill.path);

      let rawContent: string;
      if (!filePath) {
        rawContent = skill.content;
      } else {
        const targetPath = resolve(skillDir, filePath);
        if (!targetPath.startsWith(skillDir + "/") && targetPath !== skillDir) {
          return { success: false, output: `Blocked: "${filePath}" escapes skill directory.` };
        }
        try {
          rawContent = await readFile(targetPath, "utf-8");
        } catch (err) {
          return { success: false, output: formatError(`File "${filePath}" in skill "${name}"`, err) };
        }
      }

      hooks.emit("skill:read", { name });
      const resolved = rawContent.replace(/\$\{SKILL_DIR\}/g, skillDir);
      return { success: true, output: scanForInjection(resolved, `skill:${name}`) };
    },
  };
}

export function createManageSkillsTool(
  skillRegistry: SkillRegistry,
  builtinDir: string,
  customDir: string,
  workspaceSkillsDir: string,
): Tool {
  async function refreshRegistry(): Promise<void> {
    await reloadSkills({ builtInDir: builtinDir, customDir, workspaceDir: workspaceSkillsDir }, skillRegistry);
  }

  return {
    name: "manage_skills",
    description: "Manage the skill registry. Actions: create, update, delete, reload. After create/update/delete, the registry auto-refreshes. Use reload to force a rescan from disk.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "delete", "reload"],
          description: "Action to perform: create a new skill, update an existing one, delete a skill, or reload the registry from disk",
        },
        name: {
          type: "string",
          description: "Skill name (lowercase, hyphens, max 64 chars). Required for create/update/delete.",
        },
        description: {
          type: "string",
          description: "Short description of what this skill does, max 1024 chars. Required for create.",
        },
        instructions: {
          type: "string",
          description: "Full markdown instructions for the skill. Required for create/update.",
        },
      },
      required: ["action"],
    },
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const action = String(args["action"] ?? "").trim();

      if (action === "reload") {
        try {
          await refreshRegistry();
          const count = skillRegistry.list().length;
          return { success: true, output: `Skills reloaded. ${count} skills available.` };
        } catch (err) {
          return { success: false, output: formatError("Failed to reload skills", err) };
        }
      }

      const name = String(args["name"] ?? "").trim();

      if (action === "create") {
        const description = String(args["description"] ?? "").trim();
        const instructions = String(args["instructions"] ?? "").trim();

        const nameError = validateSkillName(name);
        if (nameError) {
          return { success: false, output: `Invalid skill name: ${nameError}` };
        }

        const descError = validateSkillDescription(description);
        if (descError) {
          return { success: false, output: `Invalid description: ${descError}` };
        }

        if (!instructions) {
          return { success: false, output: "instructions is required (cannot be empty)." };
        }

        const skillDir = join(workspaceSkillsDir, name);
        try {
          await mkdir(skillDir, { recursive: true });
        } catch (err) {
          return { success: false, output: formatError(`Failed to create skill directory "${name}"`, err) };
        }

        const safeName = name.replace(/[\n\r]/g, " ").trim();
        const safeDescription = description.replace(/[\n\r]/g, " ").trim();
        const content = `---\nname: ${safeName}\ndescription: ${safeDescription}\n---\n\n${instructions}\n`;
        try {
          await writeFileAtomically(join(skillDir, "SKILL.md"), content);
        } catch (err) {
          return { success: false, output: formatError(`Failed to write SKILL.md for "${name}"`, err) };
        }

        await refreshRegistry();
        hooks.emit("skill:created", { name });
        return { success: true, output: `Skill "${name}" created and registry refreshed.\nPath: ${skillDir}/SKILL.md\nTip: use write() to add references/ and examples/ files if needed.` };
      }

      if (action === "update") {
        const instructions = String(args["instructions"] ?? "").trim();

        if (!instructions) {
          return { success: false, output: "instructions is required for update." };
        }

        const skill = skillRegistry.get(name);
        if (!skill) {
          return { success: false, output: `Skill "${name}" not found.` };
        }
        if (skill.source === "built-in") {
          return { success: false, output: `Cannot modify built-in skill "${name}".` };
        }

        const baseDir = skill.source === "workspace" ? workspaceSkillsDir : customDir;
        const skillFile = join(baseDir, name, "SKILL.md");

        try {
          await access(skillFile);
        } catch {
          return { success: false, output: `Skill file not found for "${name}".` };
        }

        let existing = "";
        try {
          existing = await readFile(skillFile, "utf-8");
        } catch {
          return { success: false, output: `Failed to read skill "${name}".` };
        }

        const lines = existing.split("\n");
        let frontmatterEnd = -1;
        for (let i = 1; i < lines.length; i++) {
          if (lines[i]!.trim() === "---") { frontmatterEnd = i; break; }
        }
        const header = frontmatterEnd >= 0 ? lines.slice(0, frontmatterEnd + 1).join("\n") : `---\nname: ${name}\n---`;
        const newContent = `${header}\n\n${instructions}\n`;
        // The header is copied verbatim from the old file, so a malformed one propagates. Refuse
        // before writing: an unparseable SKILL.md drops out of the registry, i.e. the skill would
        // delete itself while reporting success.
        if (!parsesAsSkill(newContent)) {
          return { success: false, output: `Refused: the result would not parse as a skill (frontmatter of "${name}" is malformed).` };
        }
        await snapshot(skillFile, { origin: "pre-write", note: `manage_skills update ${name}` });
        await writeFileAtomically(skillFile, newContent);

        await refreshRegistry();
        hooks.emit("skill:updated", { name });
        return { success: true, output: `Skill "${name}" updated and registry refreshed.` };
      }

      if (action === "delete") {
        const skill = skillRegistry.get(name);
        if (!skill) {
          return { success: false, output: `Skill "${name}" not found.` };
        }
        if (skill.source === "built-in") {
          return { success: false, output: `Cannot delete built-in skill "${name}".` };
        }

        const baseDir = skill.source === "workspace" ? workspaceSkillsDir : customDir;
        const skillDir = join(baseDir, name);

        try {
          await rm(skillDir, { recursive: true, force: true });
        } catch {
          return { success: false, output: `Failed to delete skill "${name}".` };
        }

        await refreshRegistry();
        hooks.emit("skill:deleted", { name });
        return { success: true, output: `Skill "${name}" deleted and registry refreshed.` };
      }

      return { success: false, output: `Unknown action '${action}'. Use: create, update, delete, reload.` };
    },
  };
}
