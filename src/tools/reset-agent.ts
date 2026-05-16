import { type Tool, type ToolResult, str } from "./types.ts";
import { SubAgentRunner } from "../subagents/runner.ts";

export function createResetAgentTool(runner: SubAgentRunner): Tool {
  return {
    name: "reset_agent",
    description: "Reset a persistent sub-agent's session history (archived then cleared). The display name, type, and workspace directory are preserved.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Sub-agent session ID (e.g. 'subagent/researcher-a7b3')" },
      },
      required: ["id"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const id = str(args, "id");
        const result = await runner.reset(id);
        return { success: !result.startsWith("Error:"), output: result, error: result.startsWith("Error:") ? result : undefined };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
