import type { SubAgentConfigKey } from "../core/config.ts";

export type SubAgentType = SubAgentConfigKey;

export type { SubAgentMeta } from "../sessions/store.ts";

export interface SubAgentInfo {
  id: string;
  displayName: string;
  type: SubAgentType;
  messageCount: number;
  status: "idle" | "running";
}
