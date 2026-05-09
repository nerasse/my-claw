import type { Tool, ToolResult } from "./types.ts";
import { SubAgentRunner } from "../subagents/runner.ts";
import { SubAgentRegistry } from "../subagents/registry.ts";

export function createListAgentsTool(runner: SubAgentRunner, registry: SubAgentRegistry): Tool {
  return {
    name: "list_agents",
    description: "List all persistent sub-agents with their ID, display name, type, message count, and status.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(): Promise<ToolResult> {
      try {
        const agents = await runner.list(registry);
        const output = agents
          .map((a) => `- ${a.id} | ${a.displayName} | ${a.type} | ${a.messageCount} messages | ${a.status}`)
          .join("\n") || "No persistent sub-agents.";
        return { success: true, output };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
