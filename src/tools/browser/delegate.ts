import { type Tool, type ToolResult, str } from "../types.ts";
import { BrowserSubagent } from "../../agent/subagents/browser.ts";
import type { MyClawConfig } from "../../core/config.ts";
import type { AgentRegistry } from "../../agents/registry.ts";

export const DEFAULT_NOVNC_URL = "http://localhost:6080";
export const DEFAULT_SIDECAR_URL = "http://127.0.0.1:9223";

// There is ONE shared Chromium behind the sidecar. Parallel browser tasks used to fight
// over tabs/focus/refs and corrupt each other; tasks are therefore serialized here.
let browserTaskQueue: Promise<unknown> = Promise.resolve();

export function enqueueBrowserTask<T>(run: () => Promise<T>): Promise<T> {
  const result = browserTaskQueue.then(run, run);
  browserTaskQueue = result.catch(() => undefined);
  return result;
}

export function createDelegateBrowserTool(config: MyClawConfig, agentRegistry?: AgentRegistry): Tool {
  return {
    name: "delegate_browser_task",
    description: "Delegate a web browsing task to a specialized subagent. Use for multi-step web interactions like filling forms, booking, or searching on specific websites. There is ONE shared browser: tasks run strictly one at a time, and parallel calls are queued — prefer a single well-scoped task (or sequential calls) over a parallel batch. The subagent may take screenshots during the task; any captured images are automatically attached to your response and delivered to the user. Do NOT try to find, read, or re-attach these screenshots, and do NOT reference them with MEDIA: — they are already attached. Just describe the result in your reply.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Starting URL" },
        instructions: { type: "string", description: "Detailed instructions for the browsing task" },
      },
      required: ["url", "instructions"],
    },
    async execute(args): Promise<ToolResult> {
      // Read enabled live so the config hot-reload watcher can toggle it at runtime.
      if (config.browser?.enabled === false) {
        return { success: false, output: "", error: "Browser tool is disabled (browser.enabled = false in config.json)." };
      }
      const sidecarUrl = config.browser?.sidecarUrl ?? DEFAULT_SIDECAR_URL;
      const url = str(args, "url");
      const instructions = str(args, "instructions");
      const signal = args["__signal"] instanceof AbortSignal ? args["__signal"] : undefined;
      const callerSessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : undefined;
      const workspaceDir = typeof args["__workspaceDir"] === "string" ? args["__workspaceDir"] : undefined;
      const subagent = new BrowserSubagent(config, sidecarUrl, callerSessionId, workspaceDir, agentRegistry);
      try {
        const task = enqueueBrowserTask(() => subagent.run(instructions, url, signal));
        // If /stop fires while this task is still queued behind another, return promptly instead
        // of waiting for the whole queue to drain — the queued run no-ops at step 0 when aborted.
        if (signal) {
          const aborted = Symbol("aborted");
          const abortPromise = new Promise<typeof aborted>((resolve) => {
            if (signal.aborted) return resolve(aborted);
            signal.addEventListener("abort", () => resolve(aborted), { once: true });
          });
          const raced = await Promise.race([task, abortPromise]);
          if (raced === aborted) {
            task.catch(() => undefined); // abandon: prevent an unhandled rejection
            return { success: false, output: "", error: "Browser task stopped by user." };
          }
        }
        const result = await task;
        if (result.needs_human) {
          const novncUrl = config.browser?.novncUrl ?? DEFAULT_NOVNC_URL;
          return {
            success: false,
            output: `Browser task paused — a human must take over.\n${result.summary}\nOpen the live browser at ${novncUrl}, resolve the blocker, then reply "continue".`,
            attachments: result.attachments ?? [],
          };
        }
        if (!result.success) {
          return {
            success: false,
            output: "",
            error: result.summary || "Browser task failed.",
            attachments: result.attachments ?? [],
          };
        }
        return {
          success: true,
          output: result.summary || "Task completed.",
          attachments: result.attachments ?? [],
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      } finally {
        await subagent.cleanup();
      }
    },
  };
}
