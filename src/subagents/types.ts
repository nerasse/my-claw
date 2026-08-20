/**
 * The name of a spawnable agent. Open since agents are file-defined: the set is the agent registry,
 * not a union the compiler can close. See docs/file-agents.md.
 */
export type SubAgentType = string;

export type { SubAgentMeta } from "../sessions/store.ts";

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
  model?: string;
  createdAt: string;
}
