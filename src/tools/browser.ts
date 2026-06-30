import { type Tool, type ToolResult, str, num, bool } from "./types.ts";
import type { BrowserClient } from "../browser/client.ts";
import { resolveAndCheckUrl } from "./fetch.ts";

// Track the current page id across tool calls within a single agent turn
let currentPageId: string | null = null;

export function setCurrentPageId(pageId: string | null): void {
  currentPageId = pageId;
}

function getPageId(): string {
  if (!currentPageId) {
    throw new Error("No active browser page. Call browser_navigate first.");
  }
  return currentPageId;
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

export function createBrowserNavigateTool(client: BrowserClient): Tool {
  return {
    name: "browser_navigate",
    description: "Open a URL in a new browser tab. Returns a snapshot of the page with interactive element refs.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
      },
      required: ["url"],
    },
    async execute(args): Promise<ToolResult> {
      const url = str(args, "url");
      try {
        await guardUrl(url);
        const result = await client.navigate(url);
        currentPageId = result.pageId;
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

export function createBrowserSnapshotTool(client: BrowserClient): Tool {
  return {
    name: "browser_snapshot",
    description: "Capture the current page accessibility tree. Use after every action to verify state.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(): Promise<ToolResult> {
      try {
        const snapshot = await client.snapshot(getPageId());
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

export function createBrowserClickTool(client: BrowserClient): Tool {
  return {
    name: "browser_click",
    description: "Click an interactive element by its ref number (e.g., 5).",
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
        const pageId = getPageId();
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

export function createBrowserTypeTool(client: BrowserClient): Tool {
  return {
    name: "browser_type",
    description: "Type text into a form field by its ref number.",
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
        const pageId = getPageId();
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

export const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
export const DEFAULT_NOVNC_URL = "http://localhost:6080";
export const DEFAULT_SIDECAR_URL = "http://127.0.0.1:9223";

export function createDelegateBrowserTool(config: MyClawConfig): Tool {
  return {
    name: "delegate_browser_task",
    description: "Delegate a web browsing task to a specialized subagent. Use for multi-step web interactions like filling forms, booking, or searching on specific websites. The subagent may take screenshots during the task; any captured images are automatically attached to the response and delivered to the user.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Starting URL" },
        instructions: { type: "string", description: "Detailed instructions for the browsing task" },
      },
      required: ["url", "instructions"],
    },
    async execute(args): Promise<ToolResult> {
      // Read enabled/cdpUrl live so the config hot-reload watcher can toggle them at runtime.
      if (config.browser?.enabled === false) {
        return { success: false, output: "", error: "Browser tool is disabled (browser.enabled = false in config.json)." };
      }
      const sidecarUrl = config.browser?.sidecarUrl ?? DEFAULT_SIDECAR_URL;
      const url = str(args, "url");
      const instructions = str(args, "instructions");
      const subagent = new BrowserSubagent(config, sidecarUrl);
      try {
        const result = await subagent.run(instructions, url);
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

export function createBrowserScreenshotTool(client: BrowserClient): Tool {
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
        const pageId = getPageId();
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

export function createBrowserFocusTabTool(client: BrowserClient): Tool {
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
        currentPageId = pageId;
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
