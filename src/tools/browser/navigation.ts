import { type Tool, type ToolResult, str, num, bool } from "../types.ts";
import type { BrowserClient } from "../../browser/client.ts";
import { type BrowserPageState, getPageId, guardUrl, formatSnapshot } from "./state.ts";

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
        return { success: true, output: formatSnapshot(result.snapshot) };
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
        return { success: true, output: formatSnapshot(snapshot) };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
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
        return { success: true, output: "Screenshot captured.", attachments: [attachment] };
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
        return { success: true, output: `Switched to tab [${index}].\n${formatSnapshot(snapshot)}` };
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
