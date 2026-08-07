import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_BASES,
  PROMPT_LAYERS,
  RESERVED_AGENT_NAMES,
  type AgentBase,
  type AgentMeta,
  type FileAgent,
  type PromptLayerName,
} from "./types.ts";
import type { AgentScope } from "../core/config.ts";
import { snapshot } from "../core/config-store.ts";
import { log } from "../utils/logger.ts";
import { parseFrontmatter, listField } from "../utils/frontmatter.ts";

/**
 * Every agent's name and description enters the spawn tool schema on every orchestrator run, so the
 * catalog is a recurring token cost rather than a one-off read. Skills need no such cap because a
 * skill body is loaded on demand; an agent's metadata is not. See docs/file-agents.md.
 */
export const MAX_AGENTS_PER_TIER = 50;
export const MAX_AGENT_BYTES = 64 * 1024;
export const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_NAME_LENGTH = 64;
const VALID_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AGENT_FILE_SUFFIX = ".md";

/** Why a file in `agents/` did not become an agent. Reported, never thrown. */
export type AgentRejection =
  | "invalid-name"
  | "reserved-name"
  | "too-large"
  | "no-frontmatter"
  | "no-description";

function parseScope(raw: string | undefined): AgentScope | undefined {
  const list = listField(raw);
  if (list === undefined) return undefined;
  return list.includes("*") ? "all" : list;
}

function parseBase(raw: string | undefined, path: string): AgentBase {
  if (raw === undefined) return "general";
  if ((AGENT_BASES as readonly string[]).includes(raw)) return raw as AgentBase;
  // The narrower baseline is not the safe one to guess: silently downgrading a general agent to
  // read-only would look like a broken agent, while the general baseline is already a sub-agent set.
  void log("warn", "agent declares an unknown base, falling back to general", { path, base: raw });
  return "general";
}

function parseInstructions(raw: string | undefined, path: string): PromptLayerName[] {
  if (raw === undefined) return [...PROMPT_LAYERS];
  const requested = listField(raw) ?? [];
  if (requested.length === 1 && requested[0]!.toLowerCase() === "none") return [];
  const layers: PromptLayerName[] = [];
  for (const item of requested) {
    const upper = item.toUpperCase();
    const known = PROMPT_LAYERS.find((layer) => layer === upper);
    if (known) {
      if (!layers.includes(known)) layers.push(known);
    } else {
      void log("warn", "agent asks for an unknown prompt layer, ignored", { path, layer: item });
    }
  }
  // Keep the builder's fixed order regardless of how the file spelled it: the layer order is a
  // property of the prompt, not of the author's typing.
  return PROMPT_LAYERS.filter((layer) => layers.includes(layer));
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function nonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** The name a file defines, or a rejection. Exported so a writer can check what the reader accepts. */
export function agentNameOf(fileName: string): { name: string } | { rejected: AgentRejection } {
  if (!fileName.endsWith(AGENT_FILE_SUFFIX)) return { rejected: "invalid-name" };
  const name = fileName.slice(0, -AGENT_FILE_SUFFIX.length);
  if (!VALID_NAME_RE.test(name) || name.length > MAX_NAME_LENGTH) return { rejected: "invalid-name" };
  if (RESERVED_AGENT_NAMES.includes(name)) return { rejected: "reserved-name" };
  return { name };
}

/**
 * Single definition of "this text defines an agent", so a writer can check what a reader will
 * accept instead of re-implementing the rules.
 */
export function parseAgentFile(
  text: string,
  name: string,
  path: string,
): { meta: AgentMeta; prompt: string } | { rejected: AgentRejection } {
  if (Buffer.byteLength(text, "utf-8") > MAX_AGENT_BYTES) return { rejected: "too-large" };

  const parsed = parseFrontmatter(text);
  if (!parsed) return { rejected: "no-frontmatter" };

  const description = parsed.fields["description"];
  if (!description) return { rejected: "no-description" };

  const model = parsed.fields["model"];
  const workspace = parsed.fields["workspace"];
  const tools = listField(parsed.fields["tools"]);
  const skills = parseScope(parsed.fields["skills"]);
  const mcp = parseScope(parsed.fields["mcp"]);
  const maxIterations = positiveInt(parsed.fields["maxIterations"]);
  const contextCap = nonNegativeInt(parsed.fields["contextCap"]);

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    void log("warn", "agent description truncated", { path, name, length: description.length });
  }

  return {
    meta: {
      description: description.slice(0, MAX_DESCRIPTION_LENGTH),
      base: parseBase(parsed.fields["base"], path),
      instructions: parseInstructions(parsed.fields["instructions"], path),
      ...(tools ? { tools } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(mcp !== undefined ? { mcp } : {}),
      ...(model ? { model } : {}),
      ...(workspace ? { workspace } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(contextCap !== undefined ? { contextCap } : {}),
    },
    prompt: parsed.body,
  };
}

/** Last version of each agent file that parsed. Same reason as skills: an agent edited into a broken
 *  frontmatter must not vanish from `/agents` with no explanation. */
const lastGood = new Map<string, FileAgent>();

/** Only needed by tests: agent paths repeat across files and a kept version would leak. */
export function resetAgentLastGood(): void {
  lastGood.clear();
}

async function loadAgentFromFile(
  path: string,
  name: string,
  source: FileAgent["source"],
): Promise<FileAgent | null> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    // Gone, not broken: forget it so a deleted agent really disappears.
    lastGood.delete(path);
    return null;
  }

  const parsed = parseAgentFile(text, name, path);
  if ("rejected" in parsed) {
    const kept = lastGood.get(path);
    void log("warn", kept ? "agent file no longer parses, keeping the last good version" : "agent file rejected", {
      path,
      reason: parsed.rejected,
    });
    return kept ?? null;
  }

  const agent: FileAgent = { name, meta: parsed.meta, prompt: parsed.prompt, path, source };
  lastGood.set(path, agent);
  // Built-ins are resynced from the repo by hash at every boot, so snapshotting them would archive
  // a copy of the release on each upgrade for something already versioned here.
  if (source !== "built-in") void snapshot(path, { origin: "reload", note: name });
  return agent;
}

async function scanDir(dir: string, source: FileAgent["source"], layer?: string): Promise<FileAgent[]> {
  const agents: FileAgent[] = [];
  try {
    await access(dir);
  } catch {
    return agents;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  // Sorted so the per-tier cap drops a stable set rather than whatever the filesystem returned first.
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const resolved = agentNameOf(entry.name);
    if ("rejected" in resolved) {
      // A non-markdown file next to the agents is not a mistake worth shouting about.
      if (resolved.rejected !== "invalid-name" || entry.name.endsWith(AGENT_FILE_SUFFIX)) {
        void log("warn", "agent file skipped", { path: join(dir, entry.name), reason: resolved.rejected });
      }
      continue;
    }
    if (agents.length >= MAX_AGENTS_PER_TIER) {
      void log("warn", "agent tier over the cap, extra files ignored", { dir, cap: MAX_AGENTS_PER_TIER });
      break;
    }
    const agent = await loadAgentFromFile(join(dir, entry.name), resolved.name, source);
    if (agent) {
      if (layer) agent.layer = layer;
      agents.push(agent);
    }
  }

  return agents;
}

/** One workspace agents layer: its key and its `<workspace>/agents` directory. */
export interface WorkspaceAgentLayer {
  key: string;
  dir: string;
}

export interface AgentDirs {
  builtInDir: string;
  customDir: string;
  /** The default workspace's layer, seen by default-workspace runs only. */
  workspaceDir?: string;
  workspaces?: WorkspaceAgentLayer[];
}

function mergeAgents(layers: FileAgent[][]): Map<string, FileAgent> {
  const merged = new Map<string, FileAgent>();
  for (const layer of layers) {
    for (const agent of layer) {
      const key = agent.layer ? `${agent.layer}/${agent.name}` : agent.name;
      const shadowed = merged.get(key);
      // Skills overwrite in silence. An agent carries a tool set and a prompt, so learning which of
      // two files is live matters more than the noise costs.
      if (shadowed) {
        void log("info", "agent shadows a lower tier", {
          name: agent.name,
          winner: agent.path,
          shadowed: shadowed.path,
        });
      }
      merged.set(key, agent);
    }
  }
  return merged;
}

export async function loadAllAgents(options: AgentDirs): Promise<Map<string, FileAgent>> {
  const builtIn = await scanDir(options.builtInDir, "built-in");
  const custom = await scanDir(options.customDir, "custom");
  const layers: FileAgent[][] = [builtIn, custom];
  if (options.workspaceDir) layers.push(await scanDir(options.workspaceDir, "workspace", "default"));
  for (const workspace of options.workspaces ?? []) {
    layers.push(await scanDir(workspace.dir, "workspace", workspace.key));
  }
  return mergeAgents(layers);
}
