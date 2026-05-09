import type { Tool } from "../tools/types.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { writeFile, mkdir, readFile, access, unlink } from "node:fs/promises";
import { join } from "node:path";
import { formatError } from "../utils/errors.ts";

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

export function createListSkillsTool(registry: SkillRegistry): Tool {
  return {
    name: "list_skills",
    description: "List all available skills with their name, description, and source.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      const skills = registry.list();
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

export function createReadSkillTool(registry: SkillRegistry): Tool {
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

      const { dirname } = await import("node:path");
      const skillDir = dirname(skill.path);

      let rawContent: string;
      if (!filePath) {
        rawContent = skill.content;
      } else {
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const targetPath = join(skillDir, filePath);
        try {
          rawContent = await readFile(targetPath, "utf-8");
        } catch (err) {
          return { success: false, output: formatError(`File "${filePath}" in skill "${name}"`, err) };
        }
      }

      const resolved = rawContent.replace(/\$\{SKILL_DIR\}/g, skillDir);
      return { success: true, output: resolved };
    },
  };
}

export function createCreateSkillTool(workspaceSkillsDir: string): Tool {
  return {
    name: "create_skill",
    description: "Create a new skill in the workspace skills directory. Validates name format (lowercase, hyphens, max 64 chars) and description length (max 1024 chars).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name: lowercase alphanumeric with hyphens, max 64 chars (e.g., 'deploy-node')" },
        description: { type: "string", description: "Short description of what this skill does, max 1024 chars" },
        instructions: { type: "string", description: "Full markdown instructions for the skill" },
      },
      required: ["name", "description", "instructions"],
    },
    execute: async (args: Record<string, unknown>) => {
      const name = String(args["name"] ?? "").trim();
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

      const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}\n`;
      try {
        await writeFile(join(skillDir, "SKILL.md"), content);
      } catch (err) {
        return { success: false, output: formatError(`Failed to write SKILL.md for "${name}"`, err) };
      }

      return { success: true, output: `Skill "${name}" created in workspace/skills/.\nPath: ${skillDir}/SKILL.md\nTip: use write() to add references/ and examples/ files if needed.` };
    },
  };
}

export function createUpdateSkillTool(
  workspaceSkillsDir: string,
  customSkillsDir: string,
  registry: SkillRegistry,
): Tool {
  return {
    name: "update_skill",
    description: "Update the instructions of an existing workspace or custom skill. Built-in skills cannot be modified.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the skill to update" },
        instructions: { type: "string", description: "New markdown instructions" },
      },
      required: ["name", "instructions"],
    },
    execute: async (args: Record<string, unknown>) => {
      const name = String(args["name"] ?? "").trim();
      const instructions = String(args["instructions"] ?? "").trim();

      const skill = registry.get(name);
      if (!skill) {
        return { success: false, output: `Skill "${name}" not found.` };
      }
      if (skill.source === "built-in") {
        return { success: false, output: `Cannot modify built-in skill "${name}".` };
      }

      const baseDir = skill.source === "workspace" ? workspaceSkillsDir : customSkillsDir;
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
      const frontmatterEnd = lines.findIndex((line) => line.trim() === "---" && lines.indexOf(line) > 0);
      const header = frontmatterEnd >= 0 ? lines.slice(0, frontmatterEnd + 1).join("\n") : `---\nname: ${name}\n---`;
      const newContent = `${header}\n\n${instructions}\n`;
      await writeFile(skillFile, newContent);

      return { success: true, output: `Skill "${name}" updated.` };
    },
  };
}

export function createDeleteSkillTool(
  workspaceSkillsDir: string,
  customSkillsDir: string,
  registry: SkillRegistry,
): Tool {
  return {
    name: "delete_skill",
    description: "Delete a workspace or custom skill. Built-in skills cannot be deleted.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the skill to delete" },
      },
      required: ["name"],
    },
    execute: async (args: Record<string, unknown>) => {
      const name = String(args["name"] ?? "").trim();

      const skill = registry.get(name);
      if (!skill) {
        return { success: false, output: `Skill "${name}" not found.` };
      }
      if (skill.source === "built-in") {
        return { success: false, output: `Cannot delete built-in skill "${name}".` };
      }

      const baseDir = skill.source === "workspace" ? workspaceSkillsDir : customSkillsDir;
      const skillFile = join(baseDir, name, "SKILL.md");

      try {
        await unlink(skillFile);
      } catch {
        return { success: false, output: `Failed to delete skill "${name}".` };
      }

      return { success: true, output: `Skill "${name}" deleted.` };
    },
  };
}
