import type { Tool, ToolResult } from "./types.ts";
import { str } from "./types.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { resolveWorkspaceDir, type MyClawConfig } from "../core/config.ts";

/**
 * Lists the configured workspaces and switches the current conversation to one of them. The
 * switch is per session: other conversations keep theirs, and future sessions still inherit
 * the orchestrator's configured pin. Workspace resolution reads the session per run, so the
 * change applies from the next run onward.
 */
export function createWorkspacesTool(sessionManager: SessionManager, config: MyClawConfig): Tool {
  return {
    name: "workspaces",
    description:
      "List the configured workspaces (key, path, which one is the default, which one this " +
      "conversation runs in) and switch the current conversation to another workspace. The switch " +
      "applies from the next run onward and never moves or deletes anything.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "switch"],
          description: "list = show every workspace; switch = move this conversation to `key`.",
        },
        key: {
          type: "string",
          description: 'Workspace key to switch to ("default" is legal). Required for action=switch.',
        },
      },
      required: ["action"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const action = str(args, "action");
        const sessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
        const session = sessionId ? await sessionManager.peek(sessionId) : null;
        const currentKey = session?.workspace ?? "default";
        const entries: Array<{ key: string; path: string; def: boolean }> = [
          { key: "default", path: resolveWorkspaceDir(config.workspace), def: true },
          ...Object.entries(config.workspaces ?? {}).map(([key, path]) => ({ key, path, def: false })),
        ];

        if (action === "list") {
          const lines = entries.map((e) => {
            const marker = e.key === currentKey ? " <- current conversation" : e.def ? " (default)" : "";
            return `- ${e.key}: ${e.path}${marker}`;
          });
          return {
            success: true,
            output: lines.join("\n") || "No workspaces configured.",
          };
        }

        if (action === "switch") {
          const key = str(args, "key");
          if (!key) {
            return { success: false, output: "", error: "key is required for action=switch" };
          }
          if (key !== "default" && !entries.some((e) => e.key === key)) {
            return {
              success: false,
              output: "",
              error: `unknown workspace: ${key}. Use action=list to see the valid keys.`,
            };
          }
          if (!session) {
            return { success: false, output: "", error: "no session to switch" };
          }
          await sessionManager.setWorkspace(sessionId, key === "default" ? undefined : key);
          return {
            success: true,
            output: `Workspace switched to "${key}". The change applies from the next run onward.`,
          };
        }

        return { success: false, output: "", error: `unknown action: ${action}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
