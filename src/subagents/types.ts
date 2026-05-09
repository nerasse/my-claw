export type SubAgentType = "general" | "research";

export interface SubAgentMeta {
  displayName: string;
  type: SubAgentType;
  workspaceDir?: string;
  createdBy: string;
  createdAt: string;
}

export interface SubAgentInfo {
  id: string;
  displayName: string;
  type: SubAgentType;
  messageCount: number;
  status: "idle" | "running";
}
