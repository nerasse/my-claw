import type { Tool, ToolResult } from "../tools/types.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { mkdir, readFile, access, rm, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { formatError } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";
import { reloadSkills } from "../skills/reload.ts";
import { parsesAsSkill } from "../skills/loader.ts";
import { normalizeUntrusted } from "../agent/prompt/normalize-untrusted.ts";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import { snapshot } from "../core/config-store.ts";
import {
  resolveAgentSkills,
  resolveWorkspaceDir,
  scopeAllows,
  type AgentScope,
  type AgentToolType,
  type MyClawConfig,
} from "../core/config.ts";

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

/** Key of the workspace this run belongs to, from the dir the backends injected. Undefined for
 *  default-workspace runs: they resolve to the unscoped global skills. */
function workspaceKeyFromArgs(config: MyClawConfig, args: Record<string, unknown>): string | undefined {
  const workspaceDir = args["__workspaceDir"];
  if (typeof workspaceDir !== "string" || !workspaceDir) return undefined;
  if (workspaceDir === resolveWorkspaceDir(config.workspace)) return undefined;
  for (const [key, dir] of Object.entries(config.workspaces ?? {})) {
    if (workspaceDir === dir) return key;
  }
  return undefined;
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

/** The session id the backends attach to every tool call, when the call came from an agent run. */
function sessionIdFromArgs(args: Record<string, unknown>): string | undefined {
  const raw = args["__sessionId"];
  return typeof raw === "string" && raw ? raw : undefined;
}

/** Skills this session turned off: they disappear from the catalog AND from list/read. */
async function skillsOffFor(sessionManager: SessionManager | undefined, sessionId: string | undefined): Promise<Set<string>> {
  if (!sessionManager || !sessionId) return new Set();
  const session = await sessionManager.peek(sessionId);
  return new Set(session?.skillsOff ?? []);
}

/**
 * The skills this caller may read, by name: its scope, its run's workspace, minus what its session
 * turned off. The same set the prompt catalog lists, so a refusal can say what is there instead of
 * sending the agent to a listing tool that would only repeat its own prompt (`list_skills` went,
 * 2026-10-04).
 */
async function readableSkills(
  registry: SkillRegistry,
  config: MyClawConfig,
  sessionManager: SessionManager | undefined,
  args: Record<string, unknown>,
): Promise<string> {
  const off = await skillsOffFor(sessionManager, sessionIdFromArgs(args));
  const names = registry.list(scopeFromArgs(config, args), workspaceKeyFromArgs(config, args))
    .map((s) => s.name)
    .filter((name) => !off.has(name))
    .sort();
  return names.length > 0 ? `Skills available to you: ${names.join(", ")}.` : "No skill is available to you.";
}

async function readSkill(
  registry: SkillRegistry,
  config: MyClawConfig,
  sessionManager: SessionManager | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const name = String(args["name"] ?? "");
  const filePath = args["file_path"] ? String(args["file_path"]) : undefined;
  const off = await skillsOffFor(sessionManager, sessionIdFromArgs(args));
  if (off.has(name)) {
    return { success: false, output: `Skill "${name}" is not in this session's scope. ${await readableSkills(registry, config, sessionManager, args)}` };
  }
  const skill = registry.get(name, workspaceKeyFromArgs(config, args));
  if (!skill) {
    return { success: false, output: `Skill "${name}" not found. ${await readableSkills(registry, config, sessionManager, args)}` };
  }
  // Existence is checked first on purpose: "not in scope" for a name that does not exist at all
  // would send the agent looking for a permission problem instead of a typo.
  if (!scopeAllows(scopeFromArgs(config, args), name)) {
    return { success: false, output: `Skill "${name}" is not in this agent's scope. ${await readableSkills(registry, config, sessionManager, args)}` };
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
      // The path check above reads names, and a link inside the skill directory can still point
      // anywhere (a skill is often a cloned repository). Where the file really is decides.
      const [realDir, realTarget] = await Promise.all([realpath(skillDir), realpath(targetPath)]);
      if (!realTarget.startsWith(realDir + "/")) {
        return { success: false, output: `Blocked: "${filePath}" leads out of the skill directory.` };
      }
      rawContent = await readFile(targetPath, "utf-8");
    } catch (err) {
      return { success: false, output: formatError(`File "${filePath}" in skill "${name}"`, err) };
    }
  }

  hooks.emit("skill:read", { name });
  const resolved = rawContent.replace(/\$\{SKILL_DIR\}/g, () => skillDir);
  return { success: true, output: normalizeUntrusted(resolved, `skill:${name}`) };
}

/** Where skills are written: the built-in source (refused), the custom tier, the default workspace's. */
export interface SkillDirs {
  builtinDir: string;
  customDir: string;
  workspaceSkillsDir: string;
}

const READ_DESCRIPTION =
  "Load a skill's full instructions by name: your prompt lists the skills available to you. If file_path is " +
  "given, reads that file within the skill directory instead (e.g. 'references/format.md'). Call it when a skill " +
  "matches your task or when a skill points to a file you need.";

const READ_PROPERTIES = {
  name: { type: "string", description: "The skill's name" },
  file_path: { type: "string", description: "Optional relative path within the skill directory (e.g. 'references/format.md')" },
};

/**
 * One tool for the skills: read one (the default), and for the orchestrator create, update,
 * delete and reload. They were `read_skill` and `manage_skills` until 2026-10-04.
 *
 * Writing stays the orchestrator's alone, as it was with two tools. Every other agent is handed
 * `readOnly` (`ToolRegistry.getForAgent`): a schema with no action at all, and an `execute` that
 * refuses one. A tool call runs from the list its agent was given, so a sub-agent naming
 * `action: "create"` reaches the read-only tool and nothing else.
 */
export function createSkillsTool(
  skillRegistry: SkillRegistry,
  config: MyClawConfig,
  dirs: SkillDirs,
  sessionManager?: SessionManager,
): Tool {
  const { builtinDir, customDir, workspaceSkillsDir } = dirs;
  async function refreshRegistry(): Promise<void> {
    await reloadSkills(
      {
        builtInDir: builtinDir,
        customDir,
        workspaceDir: workspaceSkillsDir,
        workspaces: Object.entries(config.workspaces ?? {}).map(([key, dir]) => ({ key, dir: join(dir, "skills") })),
      },
      skillRegistry,
    );
  }

  /** The dir a skill lives in, whatever workspace it belongs to. */
  function skillBaseDir(skill: { source: string; workspace?: string }): string {
    if (skill.source !== "workspace") return customDir;
    const dir = skill.workspace ? config.workspaces?.[skill.workspace] : undefined;
    if (dir) return join(dir, "skills");
    return workspaceSkillsDir;
  }

  /** Where this run's created skills land: its own workspace's skills dir when in one. */
  function runWorkspaceSkillsDir(args: Record<string, unknown>): string {
    const key = workspaceKeyFromArgs(config, args);
    const dir = key ? config.workspaces?.[key] : undefined;
    if (dir) return join(dir, "skills");
    return workspaceSkillsDir;
  }

  const readOnly: Tool = {
    name: "skills",
    description: READ_DESCRIPTION,
    parameters: { type: "object", properties: READ_PROPERTIES, required: ["name"] },
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const action = String(args["action"] ?? "read").trim();
      if (action !== "read") return { success: false, output: "Only the orchestrator writes skills: this agent can read them." };
      return readSkill(skillRegistry, config, sessionManager, args);
    },
  };

  return {
    name: "skills",
    description:
      `${READ_DESCRIPTION} Other actions write the skill registry: create (name, description, instructions), ` +
      "update (name, instructions), delete (name), reload (a rescan from disk). The registry refreshes by itself after " +
      "create, update and delete.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "create", "update", "delete", "reload"],
          description: "read (default) loads a skill; the others write the registry",
        },
        ...READ_PROPERTIES,
        description: { type: "string", description: "create: what the skill does, one line, max 1024 chars" },
        instructions: { type: "string", description: "create, update: the full markdown instructions" },
      },
    },
    readOnly,
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const action = String(args["action"] ?? "read").trim();
      if (action === "read") return readSkill(skillRegistry, config, sessionManager, args);

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

        const skillDir = join(runWorkspaceSkillsDir(args), name);
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

        const skill = skillRegistry.get(name, workspaceKeyFromArgs(config, args));
        if (!skill) {
          return { success: false, output: `Skill "${name}" not found.` };
        }
        if (skill.source === "built-in") {
          return { success: false, output: `Cannot modify built-in skill "${name}".` };
        }

        const baseDir = skillBaseDir(skill);
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
        await snapshot(skillFile, { origin: "pre-write", note: `skills update ${name}` });
        await writeFileAtomically(skillFile, newContent);

        await refreshRegistry();
        hooks.emit("skill:updated", { name });
        return { success: true, output: `Skill "${name}" updated and registry refreshed.` };
      }

      if (action === "delete") {
        const skill = skillRegistry.get(name, workspaceKeyFromArgs(config, args));
        if (!skill) {
          return { success: false, output: `Skill "${name}" not found.` };
        }
        if (skill.source === "built-in") {
          return { success: false, output: `Cannot delete built-in skill "${name}".` };
        }

        const skillDir = join(skillBaseDir(skill), name);

        try {
          await rm(skillDir, { recursive: true, force: true });
        } catch {
          return { success: false, output: `Failed to delete skill "${name}".` };
        }

        await refreshRegistry();
        hooks.emit("skill:deleted", { name });
        return { success: true, output: `Skill "${name}" deleted and registry refreshed.` };
      }

      return { success: false, output: `Unknown action '${action}'. Use: read, create, update, delete, reload.` };
    },
  };
}
