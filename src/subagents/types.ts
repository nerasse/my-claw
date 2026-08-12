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
  visibility: "global" | "private";
  model?: string;
  createdAt: string;
}
