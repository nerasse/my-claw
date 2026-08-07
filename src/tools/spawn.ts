import { resolve } from "node:path";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { SubAgentRunner } from "../subagents/runner.ts";
import { SubAgentRegistry } from "../subagents/registry.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import { rethrowIfAborted } from "../core/aborted.ts";

export function createSpawnTool(runner: SubAgentRunner, registry: SubAgentRegistry, listModelIds?: () => string[]): Tool {
  return {
    name: "spawn",
    description:
      "Spawn a sub-agent. mode='run' = one-shot (deleted after run). mode='session' = persistent on disk, reusable via send(). " +
      "Types: 'research' (read-only tools) or 'general' (full tools). " +
      "Provide workspaceDir to isolate the sub-agent's filesystem. " +
      "Optionally pick the sub-agent's model from the listed ones (default: the configured sub-agent model). " +
      "Max 3 concurrent runs, max depth 2.",
    // Getter on purpose: both engines rebuild tool definitions per run, so the model enum
    // follows config hot-reloads instead of freezing at boot.
    get parameters() {
      const models = listModelIds?.() ?? [];
      return {
        type: "object",
        properties: {
          name: { type: "string", description: "Display name for the sub-agent (e.g. 'researcher', 'coder')" },
          type: { type: "string", enum: ["general", "research"], description: "Sub-agent type" },
          mode: { type: "string", enum: ["run", "session"], description: "'run' = one-shot, 'session' = persistent" },
          task: { type: "string", description: "Task description for the sub-agent" },
          workspaceDir: { type: "string", description: "Optional absolute workspace directory for the sub-agent" },
          private: { type: "boolean", description: "Restrict this sub-agent to the current conversation. Default false: sub-agents are usable from any chat." },
          ...(models.length > 0
            ? { model: { type: "string", enum: models, description: "Optional model for this sub-agent" } }
            : {}),
        },
        required: ["name", "type", "mode", "task"],
      };
    },
    async execute(args): Promise<ToolResult> {
      try {
        const name = str(args, "name");
        const type = str(args, "type") || "research";
        const mode = str(args, "mode") || "run";
        const task = str(args, "task");
        const workspaceDir = strOpt(args, "workspaceDir") ??
          (typeof args["__workspaceDir"] === "string" ? args["__workspaceDir"] : undefined);
        const model = strOpt(args, "model");
        if (model) {
          const known = listModelIds?.() ?? [];
          if (!known.includes(model)) {
            return { success: false, output: "", error: `Unknown model "${model}". Available: ${known.join(", ") || "none"}` };
          }
        }
        // The run's own workspace is the boundary, not the process-wide default: with multiple
        // workspaces a secondary-workspace run must spawn sub-agents inside *its* project, and a
        // workspaceDir argument is only ever allowed to drill down from there.
        const parentWorkspace = typeof args["__workspaceDir"] === "string"
          ? args["__workspaceDir"]
          : process.env["MY_CLAW_WORKSPACE"];
        if (workspaceDir && parentWorkspace) {
          const resolved = resolve(workspaceDir);
          if (!resolved.startsWith(parentWorkspace + "/") && resolved !== parentWorkspace) {
            return { success: false, output: "", error: `workspaceDir "${workspaceDir}" must be within the parent workspace.` };
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

        const signal = args["__signal"] as AbortSignal | undefined;
        const callerSessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
        // Global unless asked otherwise, so a sub-agent stays a shared worker by default. A
        // one-shot is forced private inside the runner regardless of what is passed here.
        const visibility = args["private"] === true ? "private" : "global";
        const existing = await registry.listExistingIds();
        const { id, result } = await runner.spawn({
          displayName: name,
          type: type as "general" | "research",
          mode: mode as "run" | "session",
          task,
          workspaceDir,
          parentMessage: message,
          existingIds: existing,
          generateId: (n, e) => registry.generateId(n, e),
          parentSessionId: callerSessionId,
          visibility,
          signal,
          model,
          enqueue: <T,>(i: string, task2: () => Promise<T>) => registry.enqueue(i, task2),
        });
        return { success: !result.startsWith("Error:"), output: result, error: result.startsWith("Error:") ? result : undefined };
      } catch (e) {
        rethrowIfAborted(e, args["__signal"] as AbortSignal | undefined);
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
