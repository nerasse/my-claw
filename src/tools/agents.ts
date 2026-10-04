import { type Tool, type ToolResult, str } from "./types.ts";
import { SubAgentRunner } from "../subagents/runner.ts";
import { SubAgentRegistry } from "../subagents/registry.ts";

/**
 * The persistent sub-agents this conversation can reach: list them, delete one, or clear its
 * history. One tool for three actions of the same shape, called rarely; `spawn` and `send` stay
 * their own -- docs/subagents.md.
 */
export function createAgentsTool(runner: SubAgentRunner, registry: SubAgentRegistry): Tool {
  return {
    name: "agents",
    description:
      "The persistent sub-agents this conversation can reach. action='list': their ID, display name, type, " +
      "message count, status and visibility (a sub-agent private to another conversation, or scoped to another " +
      "workspace, is not listed). action='kill' (id): delete one permanently, its session history included; its " +
      "workspace directory is NOT touched. action='reset' (id): archive then clear its history, keeping its name, " +
      "type and workspace directory.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "kill", "reset"] },
        id: { type: "string", description: "Sub-agent session ID, for kill and reset (e.g. 'subagent/researcher-a7b3')" },
      },
      required: ["action"],
    },
    async execute(args): Promise<ToolResult> {
      const action = str(args, "action");
      const caller = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
      try {
        if (action === "list") {
          const agents = await runner.list(registry, caller);
          const output = agents
            .map((a) => {
              const scope = a.visibility === "workspace" ? `workspace:${a.workspaceKey ?? "default"}` : a.visibility;
              return `- ${a.id} | ${a.displayName} | ${a.type} | ${a.messageCount} messages | ${a.status} | ${scope}`;
            })
            .join("\n") || "No persistent sub-agents.";
          return { success: true, output };
        }
        if (action !== "kill" && action !== "reset") {
          return { success: false, output: "", error: `Unknown action "${action}": use list, kill or reset.` };
        }
        const id = str(args, "id");
        if (!id) return { success: false, output: "", error: `${action} needs the sub-agent's id (action='list' shows them).` };
        const result = action === "kill" ? await runner.kill(id, caller) : await runner.reset(id, caller);
        const failed = result.startsWith("Error:");
        return { success: !failed, output: result, error: failed ? result : undefined };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
