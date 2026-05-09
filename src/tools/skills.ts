import type { Tool } from "../tools/types.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { writeFile, mkdir, readFile, access, unlink } from "node:fs/promises";
import { join } from "node:path";

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
        return { success: false, output: `Skill "${name}" not found.` };
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
        } catch {
          return { success: false, output: `File "${filePath}" not found in skill "${name}".` };
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
    description: "Create a new skill in the workspace skills directory. Only the agent can create skills here.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (lowercase, hyphens allowed)" },
        description: { type: "string", description: "Short description of what this skill does" },
        instructions: { type: "string", description: "Full markdown instructions for the skill" },
      },
      required: ["name", "description", "instructions"],
    },
    execute: async (args: Record<string, unknown>) => {
      const name = String(args["name"] ?? "").trim();
      const description = String(args["description"] ?? "").trim();
      const instructions = String(args["instructions"] ?? "").trim();

      if (!name || !description || !instructions) {
        return { success: false, output: "Missing required fields: name, description, instructions." };
      }

      const skillDir = join(workspaceSkillsDir, name);
      await mkdir(skillDir, { recursive: true });

      const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}\n`;
      await writeFile(join(skillDir, "SKILL.md"), content);

      return { success: true, output: `Skill "${name}" created in workspace/skills/.` };
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
