import type { Tool, ToolResult } from "./types.ts";
import { str } from "./types.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { resolveWorkspaceDir, type MyClawConfig } from "../core/config.ts";
import { addWorkspace, removeWorkspace, renameWorkspace, setWorkspacePath } from "../core/config-edit.ts";

export interface WorkspacesToolDeps {
  sessionManager: SessionManager;
  /** The live config object, mutated in place by the hot-reload appliers. */
  config: MyClawConfig;
  /** Hot-reload after a config write, so the answer describes the running config, like the app. */
  reload?: () => Promise<unknown>;
}

/**
 * Lists, creates, renames, repoints, removes and switches workspaces. The switch is per
 * session: other conversations keep theirs, and future sessions still inherit the
 * orchestrator's configured pin. The CRUD actions edit config.json through the same
 * validated, snapshot + journal path as the app, and apply without a restart.
 */
export function createWorkspacesTool(deps: WorkspacesToolDeps): Tool {
  const { sessionManager, config, reload } = deps;
  return {
    name: "workspaces",
    description:
      "List, create, rename, repoint, remove and switch between workspaces (config.workspaces). " +
      "A workspace roots the filesystem tools, prompt files and skills of a run. The switch is " +
      "per conversation and applies from the next run onward; create/rename/remove/path edit the " +
      "shared config and apply without restart. The default workspace can never be created, " +
      "renamed, removed or repointed here.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "switch", "create", "remove", "rename", "path"],
          description: "list = show every workspace; switch = move this conversation; create/remove/rename/path = edit the shared config.",
        },
        key: {
          type: "string",
          description: 'Workspace key ("default" is legal for switch only). Required for switch/create/remove/path.',
        },
        path: {
          type: "string",
          description: "Absolute directory for the workspace (create/path). The directory is created if missing.",
        },
        from: {
          type: "string",
          description: "Current workspace key (rename).",
        },
        to: {
          type: "string",
          description: "New workspace key (rename). Agents pinned to the old key are rewritten with it.",
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
        const lines = (): string[] => {
          const entries: Array<{ key: string; path: string; def: boolean }> = [
            { key: "default", path: resolveWorkspaceDir(config.workspace), def: true },
            ...Object.entries(config.workspaces ?? {}).map(([key, path]) => ({ key, path, def: false })),
          ];
          return entries.map((e) => {
            const marker = e.key === currentKey ? " <- current conversation" : e.def ? " (default)" : "";
            return `- ${e.key}: ${e.path}${marker}`;
          });
        };

        if (action === "list") {
          return { success: true, output: lines().join("\n") || "No workspaces configured." };
        }

        if (action === "switch") {
          const key = str(args, "key");
          if (!key) {
            return { success: false, output: "", error: "key is required for action=switch" };
          }
          if (key !== "default" && !(config.workspaces ?? {})[key]) {
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

        const reloadAndList = async (): Promise<string[]> => {
          if (reload) await reload().catch(() => undefined);
          return lines();
        };

        if (action === "create") {
          const key = str(args, "key");
          const path = str(args, "path");
          const result = await addWorkspace(key, path);
          if (!result.ok) return { success: false, output: "", error: result.error };
          return {
            success: true,
            output: [`Workspace created: "${key}" -> ${path}`, ...(await reloadAndList())].join("\n"),
          };
        }

        if (action === "remove") {
          const key = str(args, "key");
          if (!key) return { success: false, output: "", error: "key is required for action=remove" };
          const result = await removeWorkspace(key);
          if (!result.ok) return { success: false, output: "", error: result.error };
          const listing = await reloadAndList();
          // The pins are deliberately left: they surface as red flags in the app, and the agent
          // says so instead of silently rewriting scopes nobody asked it to touch.
          const note = `Agent pins that referenced "${key}" stay and are flagged red in the app.`;
          return { success: true, output: [`Workspace removed: "${key}". ${note}`, ...listing].join("\n") };
        }

        if (action === "rename") {
          const from = str(args, "from");
          const to = str(args, "to");
          const result = await renameWorkspace(from, to);
          if (!result.ok) return { success: false, output: "", error: result.error };
          const listing = await reloadAndList();
          return {
            success: true,
            output: [`Workspace renamed: "${from}" -> "${to}". Agent pins were rewritten with it.`, ...listing].join("\n"),
          };
        }

        if (action === "path") {
          const key = str(args, "key");
          const path = str(args, "path");
          const result = await setWorkspacePath(key, path);
          if (!result.ok) return { success: false, output: "", error: result.error };
          return {
            success: true,
            output: [`Workspace "${key}" now points at ${path}.`, ...(await reloadAndList())].join("\n"),
          };
        }

        return { success: false, output: "", error: `unknown action: ${action}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
