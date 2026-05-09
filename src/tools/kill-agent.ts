import type { Tool, ToolResult } from "./types.ts";
import { SubAgentRunner } from "../subagents/runner.ts";

export function createKillAgentTool(runner: SubAgentRunner): Tool {
  return {
    name: "kill_agent",
    description: "Delete a persistent sub-agent permanently. Its session history is removed. The workspace directory is NOT touched.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Sub-agent session ID (e.g. 'subagent/researcher-a7b3')" },
      },
      required: ["id"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const id = args["id"] as string;
        const result = await runner.kill(id);
        return { success: !result.startsWith("Error:"), output: result, error: result.startsWith("Error:") ? result : undefined };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
