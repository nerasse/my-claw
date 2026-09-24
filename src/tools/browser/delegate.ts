import { type Tool, type ToolResult, str } from "../types.ts";
import type { MyClawConfig } from "../../core/config.ts";
import type { UnifiedMessage } from "../../channels/types.ts";
import { isAbort, rethrowIfAborted } from "../../core/aborted.ts";
import type { SubAgentRegistry } from "../../subagents/registry.ts";
import type { SubAgentRunner, SubAgentStream } from "../../subagents/runner.ts";
import { DEFAULT_NOVNC_URL, takeBrowserOutcome, type BrowserSession } from "./session.ts";

/**
 * The door to the browser: a task, run by the `browser` agent as a private one-shot sub-agent of
 * the caller, exactly the way `spawn` runs the others. The run is a session of its own, so the app
 * opens it, watches it live, steers it and can `send` to it afterwards to carry on in the same
 * browser; this tool only frames the task, waits for the run and reads back what the run recorded
 * for the caller (a human handoff, a dead sidecar) that its final message cannot carry.
 */
export function createDelegateBrowserTool(
  config: MyClawConfig,
  runner: SubAgentRunner,
  registry: SubAgentRegistry,
  session: BrowserSession,
  streamProvider?: (subagentId: string) => SubAgentStream | undefined,
): Tool {
  return {
    name: "delegate_browser_task",
    description: "Delegate a web browsing task to a specialized subagent. Use for multi-step web interactions like filling forms, booking, or searching on specific websites. Tasks run in parallel on one shared browser, each in windows of its own: parallel calls are fine, even on the same site. The subagent may take screenshots during the task; any captured images are automatically attached to your response and delivered to the user. Do NOT try to find, read, or re-attach these screenshots, and do NOT reference them with MEDIA: — they are already attached. Just describe the result in your reply.",
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
      const url = str(args, "url");
      const instructions = str(args, "instructions");
      const signal = args["__signal"] instanceof AbortSignal ? args["__signal"] : undefined;
      const callerSessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
      const workspaceDir = typeof args["__workspaceDir"] === "string" ? args["__workspaceDir"] : undefined;
      const toolCallId = typeof args["__toolCallId"] === "string" ? args["__toolCallId"] : undefined;
      const message = args["__message"] as UnifiedMessage | undefined;
      if (!message) {
        return { success: false, output: "", error: "Missing parent message context" };
      }
      try {
        // The open windows are part of the task, not of a tool the agent would have to think of
        // calling: the window rules in its prompt name this section.
        const task = `Task: ${instructions}\nStart URL: ${url}\n\n${await session.describeWindows()}`;
        const { id, result, attachments } = await runner.spawn({
          displayName: "browser",
          type: "browser",
          mode: "run",
          task,
          parentWorkspaceDir: workspaceDir,
          parentMessage: message,
          existingIds: await registry.listExistingIds(),
          generateId: (name, existing) => registry.generateId(name, existing),
          parentSessionId: callerSessionId,
          visibility: "private",
          signal,
          enqueue: <T,>(runId: string, run: () => Promise<T>) => registry.enqueue(runId, run),
          ...(toolCallId ? { toolCallId } : {}),
          ...(streamProvider ? { streamProvider } : {}),
        });
        if (result.startsWith("Error:")) return { success: false, output: "", error: result, attachments };

        const outcome = takeBrowserOutcome(id);
        if (outcome?.infraError) {
          return {
            success: false,
            output: "",
            error: `Browser infrastructure is unavailable — the browser sidecar (${session.sidecarUrl()}) or its Chromium is not reachable: ${outcome.infraError}`,
            attachments,
          };
        }
        // A run that ended without `browser_done` ran out of budget or gave up: whatever it said last
        // is the finding, reported as a failure so the caller does not take it for a completed task.
        if (!outcome?.summary) {
          return { success: false, output: "", error: result || "Browser task ended without a result.", attachments };
        }
        const summary = outcome.summary;
        if (outcome.needsHuman) {
          const novncUrl = config.browser?.novncUrl ?? DEFAULT_NOVNC_URL;
          // Same host as the web viewer: whatever host the server is reached on, the VNC
          // path stays in lockstep with it (port 5900 is pinned by my-claw-vnc).
          let vncHost = "localhost";
          try {
            vncHost = new URL(novncUrl).hostname || vncHost;
          } catch { /* novncUrl is malformed: fall back to localhost */ }
          return {
            success: false,
            output: `Browser task paused — a human must take over.\n${summary}\nLive browser: ${novncUrl} (web) or ${vncHost}:5900 (VNC app). Resolve the blocker, then reply "continue".`,
            attachments,
          };
        }
        return { success: true, output: summary, attachments };
      } catch (e) {
        // Same rule as spawn/send: the caller's Stop is the caller's, and a delegated run that was
        // stopped on its own says that instead (docs/stop.md).
        rethrowIfAborted(e, signal);
        if (isAbort(e)) {
          return { success: false, output: "", error: "The delegated browser run was stopped before it answered. Tell the user, and say what it had already done." };
        }
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
