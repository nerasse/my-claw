import { type Tool, type ToolResult, str, num, bool } from "./types.ts";
import type { BrowserClient } from "../browser/client.ts";
import { resolveAndCheckUrl } from "./fetch.ts";

// Tracks the current page id across tool calls of ONE subagent run. This used to be a
// module-level global: concurrent browser subagents clobbered each other's page id and
// ended up clicking/snapshotting each other's tabs. Each subagent now owns its state.
export interface BrowserPageState {
  currentPageId: string | null;
}

export function createBrowserPageState(): BrowserPageState {
  return { currentPageId: null };
}

function getPageId(state: BrowserPageState): string {
  if (!state.currentPageId) {
    throw new Error("No active browser page. Call browser_navigate first.");
  }
  return state.currentPageId;
}

async function guardUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol === "file:") {
    throw new Error("file:// protocol is blocked for security.");
  }
  if (await resolveAndCheckUrl(url)) {
    throw new Error(`Navigation to ${parsed.hostname} is blocked: private/internal network address.`);
  }
}

function formatSnapshot(snapshot: { raw: string; refs: number[] }): string {
  const header = snapshot.refs.length > 0
    ? `Interactive refs: ${snapshot.refs.join(", ")}\n\n`
    : "";
  return header + snapshot.raw;
}

export function createBrowserNavigateTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_navigate",
    description: "Navigate to a URL. Reuses the CURRENT tab by default (does not spawn a new tab per call). Set new_tab=true only when you deliberately want a separate tab. Returns a snapshot of the page with interactive element refs.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
        new_tab: { type: "boolean", description: "Open in a new tab instead of reusing the current one (default false)" },
      },
      required: ["url"],
    },
    async execute(args): Promise<ToolResult> {
      const url = str(args, "url");
      const newTab = bool(args, "new_tab", false);
      try {
        await guardUrl(url);
        const result = await client.navigate(url, {
          newTab,
          reusePageId: newTab ? undefined : state.currentPageId ?? undefined,
        });
        state.currentPageId = result.pageId;
        return {
          success: true,
          output: formatSnapshot(result.snapshot),
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserSnapshotTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_snapshot",
    description: "Re-read the current page accessibility tree without acting. Note: navigate, click, and type already return a fresh snapshot — only call this when you need to re-check the page state on its own.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(): Promise<ToolResult> {
      try {
        const snapshot = await client.snapshot(getPageId(state));
        return {
          success: true,
          output: formatSnapshot(snapshot),
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserClickTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_click",
    description: "Click an interactive element by its ref number (e.g., 5). Returns a fresh snapshot of the page after the click.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "number", description: "Element ref number from snapshot" },
      },
      required: ["ref"],
    },
    async execute(args): Promise<ToolResult> {
      const ref = num(args, "ref", 0);
      try {
        const pageId = getPageId(state);
        await client.click(pageId, ref);
        const snapshot = await client.snapshot(pageId);
        return {
          success: true,
          output: formatSnapshot(snapshot),
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserTypeTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_type",
    description: "Type text into a form field by its ref number. Returns a fresh snapshot of the page after typing.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "number", description: "Element ref number from snapshot" },
        text: { type: "string", description: "Text to type" },
      },
      required: ["ref", "text"],
    },
    async execute(args): Promise<ToolResult> {
      const ref = num(args, "ref", 0);
      const text = str(args, "text");
      try {
        const pageId = getPageId(state);
        await client.type(pageId, ref, text);
        const snapshot = await client.snapshot(pageId);
        return {
          success: true,
          output: formatSnapshot(snapshot),
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

import { BrowserSubagent } from "../agent/subagents/browser.ts";
import type { MyClawConfig } from "../core/config.ts";

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

export function createDelegateBrowserTool(config: MyClawConfig): Tool {
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
      const subagent = new BrowserSubagent(config, sidecarUrl);
      try {
        const result = await enqueueBrowserTask(() => subagent.run(instructions, url, signal));
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

export function createBrowserScreenshotTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_screenshot",
    description: "Capture a screenshot. Use when stuck or when the user asks to see the page.",
    parameters: {
      type: "object",
      properties: {
        full_page: { type: "boolean", description: "Capture full page vs viewport only" },
        labels: { type: "boolean", description: "Overlay ref labels on elements for easier identification" },
      },
    },
    async execute(args): Promise<ToolResult> {
      try {
        const useLabels = bool(args, "labels", false);
        const pageId = getPageId(state);
        const attachment = useLabels
          ? await client.screenshotWithLabels(pageId, bool(args, "full_page", false))
          : await client.screenshot(pageId, bool(args, "full_page", false));
        return {
          success: true,
          output: "Screenshot captured.",
          attachments: [attachment],
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserListTabsTool(client: BrowserClient): Tool {
  return {
    name: "browser_list_tabs",
    description: "List all open browser tabs with their index and URL.",
    parameters: { type: "object", properties: {} },
    async execute(): Promise<ToolResult> {
      try {
        const tabs = await client.listTabs();
        const lines = tabs.map((t, i) => `[${i}] ${t.url}`).join("\n");
        return { success: true, output: tabs.length > 0 ? lines : "No tabs open." };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserFocusTabTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_focus_tab",
    description: "Switch to a tab by its index number (from browser_list_tabs).",
    parameters: {
      type: "object",
      properties: {
        index: { type: "number", description: "Tab index" },
      },
      required: ["index"],
    },
    async execute(args): Promise<ToolResult> {
      const index = num(args, "index", 0);
      try {
        const pageId = await client.focusTab(index);
        state.currentPageId = pageId;
        const snapshot = await client.snapshot(pageId);
        return {
          success: true,
          output: `Switched to tab [${index}].\n${formatSnapshot(snapshot)}`,
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserCloseTabTool(client: BrowserClient): Tool {
  return {
    name: "browser_close_tab",
    description: "Close a tab by its index number.",
    parameters: {
      type: "object",
      properties: {
        index: { type: "number", description: "Tab index" },
      },
      required: ["index"],
    },
    async execute(args): Promise<ToolResult> {
      const index = num(args, "index", 0);
      try {
        await client.closeTab(index);
        return { success: true, output: `Tab [${index}] closed.` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
