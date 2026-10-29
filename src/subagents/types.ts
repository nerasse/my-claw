/**
 * The name of a spawnable agent. Open since agents are file-defined: the set is the agent registry,
 * not a union the compiler can close. See docs/file-agents.md.
 */
export type SubAgentType = string;

export type { SubAgentMeta } from "../sessions/store.ts";

/**
 * How a sub-agent's last run ended, as its own log records it.
 *
 * Not a second source of truth: every value is read off the log's markers, which is what a reopened
 * thread reads too. `lost` is a `run_start` with no matching `run_end`, the state a server killed
 * mid-run leaves behind; `blocked` is the one that matters for orchestration -- a run that ended on
 * a failure with the owner's quota retry armed, so nothing is wrong except time.
 */
export type SubAgentLifecycle = "never-run" | "running" | "complete" | "failed" | "stopped" | "lost" | "blocked";

export interface SubAgentCallerInfo {
  sessionId: string;
  creator: boolean;
  firstAt: string;
  lastAt: string;
  runs: number;
  title?: string;
  unreachable?: "gone";
}

export interface SubAgentInfo {
  id: string;
  displayName: string;
  type: SubAgentType;
  messageCount: number;
  status: "idle" | "running";
  /** The rest is what a roster needs and `list` already had loaded -- docs/subagent-navigation.md. */
  visibility: "global" | "workspace" | "private";
  /** Which workspace a `workspace`-visible agent belongs to; absent means the default one. */
  workspaceKey?: string;
  /**
   * Where the agent's own tools resolve their paths, which is not `workspaceKey`: that one names
   * the orchestrator it belongs to, this one the directory it writes in. Absent on an agent
   * spawned before the field existed.
   */
  workspaceDir?: string;
  model?: string;
  createdAt: string;
}

/**
 * One sub-agent as `agents(action='inspect')` describes it.
 *
 * The roster row plus everything a caller deciding what to do next needs, read from the same log the
 * run itself read: no second bookkeeping, and no claim about the model beyond what the session
 * recorded as its pin.
 */
export interface SubAgentDetail extends SubAgentInfo {
  lifecycle: SubAgentLifecycle;
  /** Whether this agent's runs may leave their model when its provider fails. */
  fallbackPolicy?: "forbid";
  /** Read off the log: the last tool the agent ran, and whether it succeeded. */
  lastTool?: { name: string; ok: boolean };
  /** The owner's armed quota wait, when the last run ended on a spent quota. */
  quotaRetry?: { at: string; attempts: number; windows: string[] };
  /** Whether a resume would find something to pick up, from the log's own answer. */
  resumable: boolean;
  /** What a caller may do next, in the words of the tool that does it. */
  nextActions: string[];
}
