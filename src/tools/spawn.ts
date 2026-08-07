import { resolve } from "node:path";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { SubAgentRunner } from "../subagents/runner.ts";
import { SubAgentRegistry } from "../subagents/registry.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import { rethrowIfAborted } from "../core/aborted.ts";
import type { AgentInfo } from "../agents/types.ts";

export function createSpawnTool(
  runner: SubAgentRunner,
  registry: SubAgentRegistry,
  listModelIds?: () => string[],
  listAgents?: () => AgentInfo[],
): Tool {
  const agents = (): AgentInfo[] => listAgents?.() ?? [];
  return {
    name: "spawn",
    // A getter for the same reason as the parameters below: this sentence is how the model learns
    // which agents exist, and a file dropped in `agents/` must show up without a restart.
    get description() {
      const catalog = agents();
      const types = catalog.length > 0
        ? `Types:\n${catalog.map((a) => `- ${a.name}: ${a.description}`).join("\n")}\n`
        : "";
      return "Spawn a sub-agent. mode='run' = one-shot (deleted after run). mode='session' = persistent on disk, reusable via send(). " +
        types +
        "Provide workspaceDir to isolate the sub-agent's filesystem. " +
        "Optionally pick the sub-agent's model from the listed ones (default: the configured sub-agent model). " +
        "Max 3 concurrent runs, max depth 2.";
    },
    // Getter on purpose: both engines rebuild tool definitions per run, so the model enum
    // follows config hot-reloads instead of freezing at boot.
    get parameters() {
      const models = listModelIds?.() ?? [];
      const names = agents().map((a) => a.name);
      return {
        type: "object",
        properties: {
          name: { type: "string", description: "Display name for the sub-agent (e.g. 'researcher', 'coder')" },
          type: {
            type: "string",
            ...(names.length > 0 ? { enum: names } : {}),
            description: "Sub-agent type",
          },
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
        const known = agents().map((a) => a.name);
        // No hardcoded default any more: with an open set, falling back to a name that may not
        // exist would trade a clear error for a confusing one.
        const type = str(args, "type") || (known.includes("research") ? "research" : known[0] ?? "");
        const mode = str(args, "mode") || "run";
        const task = str(args, "task");
        const workspaceDir = strOpt(args, "workspaceDir");
        const model = strOpt(args, "model");
        if (model) {
          const known = listModelIds?.() ?? [];
          if (!known.includes(model)) {
            return { success: false, output: "", error: `Unknown model "${model}". Available: ${known.join(", ") || "none"}` };
          }
        }
        // The confinement check lives in the runner: only it knows the sub-agent's base
        // workspace (the agent's configured one, else the parent's). See docs/multi-workspace.md.
        const parentWorkspaceDir = typeof args["__workspaceDir"] === "string"
          ? args["__workspaceDir"]
          : process.env["MY_CLAW_WORKSPACE"];
        const message = args["__message"] as UnifiedMessage | undefined;

        if (!message) {
          return { success: false, output: "", error: "Missing parent message context" };
        }
        if (!known.includes(type)) {
          return { success: false, output: "", error: `Unknown agent '${type}'. Available: ${known.join(", ") || "none"}` };
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
          type,
          mode: mode as "run" | "session",
          task,
          workspaceDir,
          parentWorkspaceDir,
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
