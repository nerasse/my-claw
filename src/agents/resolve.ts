import {
  agentConfigOf,
  inheritedScope,
  readAgentScope,
  resolveAgentLlm,
  resolveAgentWorkspace,
  resolveContextCap,
  resolveMaxIterations,
  type AgentLlmConfig,
  type AgentScope,
  type AgentToolType,
  type MyClawConfig,
} from "../core/config.ts";
import type { AgentRegistry } from "./registry.ts";
import { AGENT_BASES, PROMPT_LAYERS, type PromptLayerName } from "./types.ts";

/**
 * One agent's effective behaviour: the config entry over the agent file over the built-in default.
 *
 * This is the single place a name becomes behaviour. The tool axis used to be a closed union, and
 * the compiler guaranteed every branch was handled; with file-defined agents the set is open, so
 * that guarantee is replaced by every caller going through here. See docs/file-agents.md.
 */
export interface ResolvedAgent {
  /** The name as callers spell it: `main`, `cron`, or an agent name. */
  type: AgentToolType;
  /** The tool baseline `getForAgent` applies. Never widened by a file. */
  base: AgentToolType;
  /** Tool names the file allows, intersected with the baseline. Absent = the whole baseline. */
  allow?: readonly string[];
  /** The agent's own instructions, empty for the reserved roles and for a name with no file. */
  prompt?: string;
  /** Workspace prompt files this agent sits on. */
  instructions: PromptLayerName[];
  skills: AgentScope;
  mcp: AgentScope;
  llm?: AgentLlmConfig;
  workspace?: string;
  maxIterations: number;
  contextCap: number | undefined;
  /** False when the name matched no file: a spawn of it is a mistake worth reporting. */
  known: boolean;
}

/** Roles that are never file-defined, so no registry lookup is attempted for them. */
function isReservedRole(type: AgentToolType): boolean {
  return type === "main" || type === "cron";
}

/**
 * The baseline for a name no file defines.
 *
 * A name that is itself a baseline keeps it, so `research` stays read-only even when its file is
 * missing -- the guarantee must not depend on a sync having run. Anything else falls to `general`,
 * the deny-by-default end of `getForAgent`, rather than to the orchestrator's full registry.
 */
function fallbackBase(type: AgentToolType): AgentToolType {
  if (isReservedRole(type)) return type;
  return (AGENT_BASES as readonly string[]).includes(type) ? type : "general";
}

export function resolveAgent(
  config: MyClawConfig,
  registry: AgentRegistry | undefined,
  type: AgentToolType,
  layer?: string,
): ResolvedAgent {
  const file = isReservedRole(type) ? undefined : registry?.get(type, layer);

  // Skills: config entry, then the file, then the orchestrator's, then everything.
  const skills = readAgentScope(config, type, "skills")
    ?? file?.meta.skills
    ?? inheritedScope(config, "skills")
    ?? "all";

  // MCP keeps the research carve-out: an agent on the read-only baseline that never had servers
  // must not inherit every one of them on upgrade. Only an explicit grant, from config or file.
  const ownMcp = readAgentScope(config, type, "mcp") ?? file?.meta.mcp;
  const baseline = file?.meta.base ?? fallbackBase(type);
  const mcp = ownMcp ?? (baseline === "research" ? [] : inheritedScope(config, "mcp") ?? "all");

  return {
    type,
    base: baseline,
    ...(file?.meta.tools ? { allow: file.meta.tools } : {}),
    ...(file?.prompt ? { prompt: file.prompt } : {}),
    instructions: file?.meta.instructions ?? [...PROMPT_LAYERS],
    skills,
    mcp,
    llm: resolveAgentLlm(config, type, file?.meta.model),
    workspace: resolveAgentWorkspace(config, type, file?.meta.workspace),
    maxIterations: resolveMaxIterations(config, type, file?.meta.maxIterations),
    contextCap: agentConfigOf(config, type)?.context?.cap === undefined && file?.meta.contextCap !== undefined
      ? resolveContextCapFor(config, file.meta.contextCap)
      : resolveContextCap(config, type),
    known: isReservedRole(type) || file !== undefined,
  };
}

/** The file's cap run through the same normalisation the config one gets: `0` lifts the ceiling. */
function resolveContextCapFor(config: MyClawConfig, cap: number): number | undefined {
  return resolveContextCap({ ...config, context: { ...config.context, cap } }, undefined);
}
