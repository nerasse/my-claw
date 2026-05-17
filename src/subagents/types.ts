export type SubAgentType = "general" | "research";

export type { SubAgentMeta } from "../sessions/store.ts";

export interface SubAgentInfo {
  id: string;
  displayName: string;
  type: SubAgentType;
  messageCount: number;
  status: "idle" | "running";
}
