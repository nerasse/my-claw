import type { AgentScope } from "../core/config.ts";
import type { PromptLayerName } from "../agent/prompt/files.ts";

/**
 * The tool baseline an agent narrows from. Not a free choice of tools: a file may subtract from one
 * of these sets and never add to it, so a workspace file cannot grant itself capability.
 * See docs/file-agents.md.
 */
export type AgentBase = "general" | "research";

export const AGENT_BASES: readonly AgentBase[] = ["general", "research"];

/**
 * Roles rather than spawnable agents, so a file cannot claim their name. `nested` is here for a
 * different reason: it shares the `config.agents` namespace without being an agent, so an agent
 * called `nested` would read the nested-AGENTS.md settings as its own overrides.
 */
export const RESERVED_AGENT_NAMES: readonly string[] = ["orchestrator", "cron", "main", "nested"];

export interface AgentMeta {
  /** What the orchestrator reads to decide whether to spawn this agent. */
  description: string;
  base: AgentBase;
  /** Tool names, intersected with the baseline. Absent = the whole baseline. */
  tools?: string[];
  skills?: AgentScope;
  mcp?: AgentScope;
  model?: string;
  /** Workspace key the agent runs in. Distinct from `FileAgent.layer`, which is where it was found. */
  workspace?: string;
  maxIterations?: number;
  contextCap?: number;
  /** Workspace prompt layers included before the agent's own prompt. */
  instructions: PromptLayerName[];
}

export interface FileAgent {
  /** Derived from the filename, never from a frontmatter field. See docs/file-agents.md. */
  name: string;
  meta: AgentMeta;
  /** The file body: the agent's own instructions. May be empty. */
  prompt: string;
  path: string;
  source: "built-in" | "custom" | "workspace";
  /**
   * Key of the workspace layer the file was found in, unset for built-in, custom and the default
   * workspace. Named `layer` rather than `workspace` because `meta.workspace` is a different thing
   * entirely: where the agent runs, not where it was declared.
   */
  layer?: string;
}

export interface AgentInfo {
  name: string;
  description: string;
  base: AgentBase;
  source: FileAgent["source"];
  path: string;
  layer?: string;
  model?: string;
  workspace?: string;
}
