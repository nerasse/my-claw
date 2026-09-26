import { type Tool, type ToolResult, str, bool } from "../types.ts";
import type { BrowserClient } from "../../browser/client.ts";
import { formatSnapshot, guardUrl, windowed } from "./state.ts";
import type { BrowserWindows } from "./windows.ts";

function sessionOf(args: Record<string, unknown>): string {
  return typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
}

export function createBrowserNavigateTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_navigate",
    description: "Navigate to a URL in a window. Reuses your CURRENT tab in that window by default (does not spawn a new tab per call). Set new_tab=true only when you deliberately want a separate tab, which opens in the same window. Returns a snapshot of the page with interactive element refs.",
    parameters: windowed({
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
        new_tab: { type: "boolean", description: "Open in a new tab of this window instead of reusing the current one (default false)" },
      },
      required: ["url"],
    }),
    async execute(args): Promise<ToolResult> {
      const url = str(args, "url");
      const newTab = bool(args, "new_tab", false);
      try {
        await guardUrl(url);
        const windowId = await pages.window(args);
        const result = newTab
          ? await client.navigate(url, { windowId, newTab: true })
          : await client.navigate(url, { pageId: await pages.page(args), windowId });
        pages.moved(args, windowId, result.pageId, newTab);
        return { success: true, output: formatSnapshot(result.snapshot) };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserSnapshotTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_snapshot",
    description: "Re-read the current page accessibility tree without acting. Note: navigate, click, and type already return a fresh snapshot — only call this when you need to re-check the page state on its own.",
    parameters: windowed({ type: "object", properties: {} }),
    async execute(args): Promise<ToolResult> {
      try {
        const snapshot = await client.snapshot(await pages.page(args));
        return { success: true, output: formatSnapshot(snapshot) };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserReloadTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_reload",
    description:
      "Reload the CURRENT page and get a fresh snapshot. Use it when the page is showing stale state (a dashboard whose data moved on) instead of navigating to the same URL again, which loses the tab's context. Returns a snapshot with new refs.",
    parameters: windowed({ type: "object", properties: {} }),
    async execute(args): Promise<ToolResult> {
      try {
        const result = await client.reload(await pages.page(args));
        return { success: true, output: formatSnapshot(result.snapshot) };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserScreenshotTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_screenshot",
    description: "Capture a screenshot. Use when stuck or when the user asks to see the page.",
    parameters: windowed({
      type: "object",
      properties: {
        full_page: { type: "boolean", description: "Capture full page vs viewport only" },
        labels: { type: "boolean", description: "Overlay ref labels on elements for easier identification" },
      },
    }),
    async execute(args): Promise<ToolResult> {
      try {
        const useLabels = bool(args, "labels", false);
        const pageId = await pages.page(args);
        const shot = useLabels
          ? await client.screenshotWithLabels(pageId, bool(args, "full_page", false))
          : await client.screenshot(pageId, bool(args, "full_page", false));
        // The viewport is metadata for the agent, not part of the attachment contract.
        const { viewport, ...attachment } = shot;
        const size = viewport ? ` Viewport is ${viewport.width}x${viewport.height}; browser_click_at takes fractions of it.` : "";
        return { success: true, output: `Screenshot captured.${size}`, attachments: [attachment] };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserListWindowsTool(pages: BrowserWindows): Tool {
  return {
    name: "browser_list_windows",
    description:
      "List the browser's windows with their tabs, and who is using each. Pick where to work from it: a FREE window already on the site you need first, then any free window, and browser_new_window only when none fits. A window in use by another task is never yours to touch: take another one, even for the same site. Using a free window makes it yours automatically until your task ends; there is nothing to lock or release.",
    parameters: { type: "object", properties: {} },
    async execute(args): Promise<ToolResult> {
      try {
        return { success: true, output: await pages.describe(sessionOf(args)) };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserNewWindowTool(pages: BrowserWindows): Tool {
  return {
    name: "browser_new_window",
    description:
      "Open a new window on a URL, yours until your task ends. Use it when no free window fits, or to work on a site another task already has open. Returns the window number and a snapshot.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open in the new window" },
      },
      required: ["url"],
    },
    async execute(args): Promise<ToolResult> {
      const url = str(args, "url");
      try {
        await guardUrl(url);
        const { alias, result } = await pages.newWindow(args, url);
        return { success: true, output: `Opened window ${alias}; it is yours.\n${formatSnapshot(result.snapshot)}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserCloseWindowTool(pages: BrowserWindows): Tool {
  return {
    name: "browser_close_window",
    description: "Close a window and all its tabs. Only close a window you no longer need; the owner may be using one that is free.",
    parameters: windowed({ type: "object", properties: {} }),
    async execute(args): Promise<ToolResult> {
      try {
        const alias = await pages.closeWindow(args);
        return { success: true, output: `Window ${alias} closed.` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserFocusTabTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_focus_tab",
    description: "Switch to a tab of a window, by its number in that window (from browser_list_windows). It becomes your current tab there.",
    parameters: windowed({
      type: "object",
      properties: {
        tab: { type: "number", description: "Tab number within the window" },
      },
      required: ["tab"],
    }),
    async execute(args): Promise<ToolResult> {
      try {
        const { alias, tab, pageId } = await pages.focusTab(args);
        const snapshot = await client.snapshot(pageId);
        return { success: true, output: `Switched to tab [${tab}] of window ${alias}.\n${formatSnapshot(snapshot)}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserCloseTabTool(pages: BrowserWindows): Tool {
  return {
    name: "browser_close_tab",
    description: "Close a tab of a window, by its number in that window.",
    parameters: windowed({
      type: "object",
      properties: {
        tab: { type: "number", description: "Tab number within the window" },
      },
      required: ["tab"],
    }),
    async execute(args): Promise<ToolResult> {
      try {
        const { alias, tab } = await pages.closeTab(args);
        return { success: true, output: `Tab [${tab}] of window ${alias} closed.` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
