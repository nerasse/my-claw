import { type Tool, type ToolResult, str, strOpt } from "../types.ts";
import type { MyClawConfig } from "../../core/config.ts";
import type { UnifiedMessage } from "../../channels/types.ts";
import { isAbort, rethrowIfAborted } from "../../core/aborted.ts";
import type { SubAgentRegistry } from "../../subagents/registry.ts";
import type { SubAgentRunner, SubAgentStream } from "../../subagents/runner.ts";
import { judgePins, refuseUnknownModel, tagsOf } from "../model-choice.ts";
import { EFFORT_LEVELS } from "../../llm/resolver.ts";
import { DEFAULT_NOVNC_URL, takeBrowserOutcome, type BrowserSession } from "./session.ts";
import { keptWindows } from "./held.ts";

/**
 * The door to the browser: a task, run by the `browser` agent as a private one-shot sub-agent of
 * the caller, exactly the way `spawn` runs the others. The run is a session of its own, so the app
 * opens it, watches it live, steers it and can `send` to it afterwards to carry on in the same
 * browser; this tool only frames the task, waits for the run and reads back what the run recorded
 * for the caller (a human handoff, a dead sidecar) that its final message cannot carry.
 *
 * With `kept`, no task runs: the call reads or settles the windows earlier tasks kept for this
 * conversation (held.ts). Those are the delegating side's business, so they live on its door.
 *
 * `model` pins the run the way a spawn's does, refused the same way when it names nothing known: a
 * page that needs a strong model (or a cheap one) is the caller's call, and the browser agent's own
 * pin is only the default (`config.agents.browser.llm.defaultModel`).
 */
export function createDelegateBrowserTool(
  config: MyClawConfig,
  runner: SubAgentRunner,
  registry: SubAgentRegistry,
  session: BrowserSession,
  streamProvider?: (subagentId: string) => SubAgentStream | undefined,
  listModelIds?: () => string[],
): Tool {
  const modelIds = (): string[] => listModelIds?.() ?? [];
  return {
    name: "delegate_browser_task",
    description: "Delegate a web browsing task to a specialized subagent. Use for multi-step web interactions like filling forms, booking, or searching on specific websites. Tasks run in parallel on one shared browser, each in windows of its own: parallel calls are fine, even on the same site. The subagent may take screenshots during the task; any captured images are automatically attached to your response and delivered to the user. Do NOT try to find, read, or re-attach these screenshots, and do NOT reference them with MEDIA: — they are already attached. Just describe the result in your reply. " +
      "With `kept` instead of a task: the windows earlier tasks kept (for a human, or for this conversation to continue in): 'list' them with what each waits for and until when, 'extend' one of this conversation's (window, hold), or 'release' them (window, or all) once no longer needed. A kept window closes with its tabs when its time is up; to continue in one, delegate the next step: it is offered that window first.",
    // A getter like spawn's: the tags follow a hot-reload instead of freezing at boot.
    get parameters() {
      const tags = tagsOf(modelIds());
      return {
        type: "object",
        properties: {
          url: { type: "string", description: "Starting URL (a task)" },
          instructions: { type: "string", description: "Detailed instructions for the browsing task" },
          model: {
            type: "string",
            description: `Optional model for this browsing run: ${tags.length > 0 ? `a tag (${tags.join(", ")}) or ` : ""}a model id (provider/model). Default: the browser agent's own model.`,
          },
          effort: {
            type: "string",
            enum: [...EFFORT_LEVELS],
            description: "Optional reasoning effort for this browsing run, overriding the browser agent's own. Omit to keep the scope's.",
          },
          contextCap: {
            type: "number",
            description: "Optional ceiling on the context window this browsing run may use, in tokens. Omit to keep the scope's ceiling.",
          },
          kept: { type: "string", enum: ["list", "release", "extend"], description: "Instead of a task: act on the windows kept for this conversation" },
          window: { type: "number", description: "kept: the window number to release or extend" },
          hold: { type: "string", description: "kept=extend: how long to keep it from now, e.g. 24h. Capped at browser.holdMax." },
          all: { type: "boolean", description: "kept=release: every window kept for this conversation" },
        },
      };
    },
    async execute(args): Promise<ToolResult> {
      // Read enabled live so the config hot-reload watcher can toggle it at runtime.
      if (config.browser?.enabled === false) {
        return { success: false, output: "", error: "Browser tool is disabled (browser.enabled = false in config.json)." };
      }
      const callerSessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
      if (args["kept"] !== undefined) return keptWindows(session.windows, args, callerSessionId);
      const url = str(args, "url");
      const instructions = str(args, "instructions");
      if (!url || !instructions) {
        return { success: false, output: "", error: "A browsing task needs url and instructions (or set kept to act on the kept windows)." };
      }
      const signal = args["__signal"] instanceof AbortSignal ? args["__signal"] : undefined;
      const workspaceDir = typeof args["__workspaceDir"] === "string" ? args["__workspaceDir"] : undefined;
      const toolCallId = typeof args["__toolCallId"] === "string" ? args["__toolCallId"] : undefined;
      const model = strOpt(args, "model");
      // The same refusal spawn gives, from the same place: a browser run is pinned, not guessed.
      const refused = refuseUnknownModel(model, modelIds());
      if (refused) return { success: false, output: "", error: refused };
      // The same two optional pins as a spawn, judged by the same function.
      const asked = judgePins(args);
      if (!asked.ok) return { success: false, output: "", error: asked.error };
      const message = args["__message"] as UnifiedMessage | undefined;
      if (!message) {
        return { success: false, output: "", error: "Missing parent message context" };
      }
      try {
        // The open windows are part of the task, not of a tool the agent would have to think of
        // calling: the window rules in its prompt name this section.
        // Described for the caller: a window kept for this conversation is the one this run is
        // meant to continue in, and without the caller it read as somebody else's.
        const task = `Task: ${instructions}\nStart URL: ${url}\n\n${await session.describeWindows(callerSessionId)}`;
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
          ...(model ? { model } : {}),
          ...(asked.pins.effort || asked.pins.contextCap !== undefined ? { pins: asked.pins } : {}),
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
        const keptNote = outcome.kept
          ? `\nKept for this conversation until ${new Date(outcome.kept.until).toLocaleString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}: window ${outcome.kept.windows.join(", ")}. To continue there, delegate the next step: the task will be offered that window first. Release it with delegate_browser_task(kept: "release", window) once it is no longer needed.`
          : "";
        if (outcome.needsHuman) {
          const novncUrl = config.browser?.novncUrl ?? DEFAULT_NOVNC_URL;
          // Same host as the web viewer: whatever host the server is reached on, the VNC
          // path stays in lockstep with it (port 5900 is pinned by my-claw-vnc).
          let vncHost = "localhost";
          try {
            vncHost = new URL(novncUrl).hostname || vncHost;
          } catch { /* novncUrl is malformed: fall back to localhost */ }
          const screen = outcome.onScreen !== undefined ? ` Window ${outcome.onScreen} is on the VNC screen.` : "";
          return {
            success: false,
            output: `Browser task paused — a human must take over.\n${summary}\nLive browser: the app's Browser page (live view), ${novncUrl} (web) or ${vncHost}:5900 (VNC app).${screen} Resolve the blocker, then reply "continue".${keptNote}`,
            attachments,
          };
        }
        return { success: true, output: `${summary}${keptNote}`, attachments };
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
