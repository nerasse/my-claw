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
import { AGENT_BASES } from "./types.ts";
import { PROMPT_LAYERS, type PromptLayerName } from "../agent/prompt/files.ts";

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
  /**
   * The `model:` the agent file declared, kept apart from `llm` (which has already folded it under
   * the config entry). The run resolution needs the two separately to say which of them a model
   * came from -- "pinned in the agent file" and "pinned in config.agents" are fixed in different
   * places, so a notice that confuses them sends the owner to the wrong file.
   */
  fileModel?: string;
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

/**
 * Run-local scope overrides (a cron job's own skills/mcp/tools fields). They slot above the
 * config entry: a job is more specific than the agent it runs as, exactly like its model
 * override. Absent fields inherit the chain below unchanged.
 */
export interface ResolvedAgentScopeOverrides {
  skills?: string[];
  mcp?: string[];
  tools?: string[];
}

export function resolveAgent(
  config: MyClawConfig,
  registry: AgentRegistry | undefined,
  type: AgentToolType,
  layer?: string,
  overrides?: ResolvedAgentScopeOverrides,
): ResolvedAgent {
  const file = isReservedRole(type) ? undefined : registry?.get(type, layer);

  // Run-local scope overrides carry the config shape ("*" = all), so they need the same
  // normalisation the config lists get before the wildcard can mean anything.
  const overrideScope = (field: "skills" | "mcp" | "tools"): AgentScope | undefined => {
    const list = overrides?.[field];
    return list && list.includes("*") ? "all" : list;
  };

  // Skills: run overrides, then the config entry, then the file, then the orchestrator's, then everything.
  const skills = overrideScope("skills")
    ?? readAgentScope(config, type, "skills")
    ?? file?.meta.skills
    ?? inheritedScope(config, "skills")
    ?? "all";

  // MCP keeps the research carve-out: an agent on the read-only baseline that never had servers
  // must not inherit every one of them on upgrade. Only an explicit grant, from the run
  // overrides, the config or the file.
  const ownMcp = overrideScope("mcp") ?? readAgentScope(config, type, "mcp") ?? file?.meta.mcp;
  const baseline = file?.meta.base ?? fallbackBase(type);
  const mcp = ownMcp ?? (baseline === "research" ? [] : inheritedScope(config, "mcp") ?? "all");

  // The run's tool list intersects the baseline exactly like a file's: a name outside it is
  // dropped at run time, so the editor flags it red instead of letting it silently vanish.
  // A "all" override is the default no-narrowing state, so it is expressed as no allow list.
  const toolsOverride = overrideScope("tools");
  const allow = toolsOverride !== undefined ? (toolsOverride === "all" ? undefined : toolsOverride) : file?.meta.tools;

  return {
    type,
    base: baseline,
    ...(allow ? { allow } : {}),
    ...(file?.prompt ? { prompt: file.prompt } : {}),
    instructions: file?.meta.instructions ?? [...PROMPT_LAYERS],
    skills,
    mcp,
    llm: resolveAgentLlm(config, type, file?.meta.model),
    ...(file?.meta.model ? { fileModel: file.meta.model } : {}),
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
