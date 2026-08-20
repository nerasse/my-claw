import type { Tool, ToolResult } from "./types.ts";
import { SubAgentRunner } from "../subagents/runner.ts";
import { SubAgentRegistry } from "../subagents/registry.ts";

export function createListAgentsTool(runner: SubAgentRunner, registry: SubAgentRegistry): Tool {
  return {
    name: "list_agents",
    description: "List the persistent sub-agents this conversation can reach, with their ID, display name, type, message count, status and visibility. A sub-agent private to another conversation, or scoped to another workspace, is not listed.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(args): Promise<ToolResult> {
      try {
        const callerSessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
        const agents = await runner.list(registry, callerSessionId);
        const output = agents
          .map((a) => {
            const scope = a.visibility === "workspace" ? `workspace:${a.workspaceKey ?? "default"}` : a.visibility;
            return `- ${a.id} | ${a.displayName} | ${a.type} | ${a.messageCount} messages | ${a.status} | ${scope}`;
          })
          .join("\n") || "No persistent sub-agents.";
        return { success: true, output };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
