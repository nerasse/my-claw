import { resolve } from "node:path";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { SubAgentRunner } from "../subagents/runner.ts";
import { SubAgentRegistry } from "../subagents/registry.ts";
import type { UnifiedMessage } from "../channels/types.ts";

export function createSpawnTool(runner: SubAgentRunner, registry: SubAgentRegistry): Tool {
  return {
    name: "spawn",
    description:
      "Spawn a sub-agent. mode='run' = one-shot (deleted after run). mode='session' = persistent on disk, reusable via send(). " +
      "Types: 'research' (read-only tools) or 'general' (full tools). " +
      "Provide workspaceDir to isolate the sub-agent's filesystem. " +
      "Max 3 concurrent runs, max depth 2.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name for the sub-agent (e.g. 'researcher', 'coder')" },
        type: { type: "string", enum: ["general", "research"], description: "Sub-agent type" },
        mode: { type: "string", enum: ["run", "session"], description: "'run' = one-shot, 'session' = persistent" },
        task: { type: "string", description: "Task description for the sub-agent" },
        workspaceDir: { type: "string", description: "Optional absolute workspace directory for the sub-agent" },
      },
      required: ["name", "type", "mode", "task"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const name = str(args, "name");
        const type = str(args, "type") || "research";
        const mode = str(args, "mode") || "run";
        const task = str(args, "task");
        const workspaceDir = strOpt(args, "workspaceDir");
        const mainWorkspace = process.env["MY_CLAW_WORKSPACE"];
        if (workspaceDir && mainWorkspace) {
          const resolved = resolve(workspaceDir);
          if (!resolved.startsWith(mainWorkspace + "/") && resolved !== mainWorkspace) {
            return { success: false, output: "", error: `workspaceDir "${workspaceDir}" must be within the main workspace.` };
          }
        }
        const message = args["__message"] as UnifiedMessage | undefined;

        if (!message) {
          return { success: false, output: "", error: "Missing parent message context" };
        }
        if (type !== "general" && type !== "research") {
          return { success: false, output: "", error: `Invalid type '${type}'` };
        }
        if (mode !== "run" && mode !== "session") {
          return { success: false, output: "", error: `Invalid mode '${mode}'` };
        }

        const existing = await registry.listExistingIds();
        const { id, result } = await runner.spawn(name, type as "general" | "research", mode as "run" | "session", task, workspaceDir, message, existing, (n, e) => registry.generateId(n, e));
        return { success: !result.startsWith("Error:"), output: result, error: result.startsWith("Error:") ? result : undefined };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
