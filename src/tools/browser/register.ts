import type { MyClawConfig } from "../../core/config.ts";
import type { ToolRegistry } from "../registry.ts";
import { createBrowserActTool } from "./act.ts";
import {
  createBrowserClickAtTool,
  createBrowserClickTool,
  createBrowserDragTool,
  createBrowserHoverTool,
  createBrowserPressKeyTool,
  createBrowserScrollTool,
  createBrowserSelectOptionTool,
  createBrowserTypeTool,
  createBrowserUploadFileTool,
  createBrowserWaitForTool,
} from "./actions.ts";
import { createBrowserFindTool, createBrowserNetworkTool, createBrowserResponseTool, createBrowserFetchTool, createBrowserTextTool } from "./inspect.ts";
import {
  type BrowserLowLevelOptions,
  createBrowserCdpTool,
  createBrowserDownloadTool,
  createBrowserEvalTool,
  createBrowserHandleDialogTool,
  createBrowserPdfTool,
} from "./lowlevel.ts";
import {
  createBrowserCloseTabTool,
  createBrowserCloseWindowTool,
  createBrowserFocusTabTool,
  createBrowserListWindowsTool,
  createBrowserNavigateTool,
  createBrowserNewWindowTool,
  createBrowserReloadTool,
  createBrowserScreenshotTool,
  createBrowserSnapshotTool,
} from "./navigation.ts";
import { createBrowserDoneTool, guardedBrowserTool, type BrowserSession } from "./session.ts";
import { createBrowserReadOutputTool } from "./output.ts";

/**
 * The browser agent's toolbox, in the process-wide registry.
 *
 * Registered once and handed out by `getForAgent("browser")` alone: the raw tools drive the one
 * shared Chromium, so every other agent keeps `delegate_browser_task` as its only door. They read
 * the calling run's workspace from their arguments and the low-level flags from the live config,
 * which is what lets one registration serve every conversation and survive a hot-reload. Which
 * run works in which window is `session.windows`, keyed by the run each call comes from.
 */
export function registerBrowserTools(registry: ToolRegistry, config: MyClawConfig, session: BrowserSession): void {
  const { client, windows } = session;
  const lowLevel: BrowserLowLevelOptions = {
    get config() {
      return config.browser;
    },
    workspaceDir: config.workspace,
  };
  const tools = [
    createBrowserNavigateTool(client, windows),
    createBrowserReloadTool(client, windows),
    createBrowserSnapshotTool(client, windows),
    createBrowserFindTool(client, windows),
    createBrowserNetworkTool(client, windows),
    createBrowserResponseTool(client, windows),
    createBrowserFetchTool(client, windows),
    createBrowserTextTool(client, windows),
    createBrowserReadOutputTool(),
    createBrowserClickTool(client, windows),
    createBrowserTypeTool(client, windows),
    createBrowserSelectOptionTool(client, windows),
    createBrowserUploadFileTool(client, windows, config.workspace),
    createBrowserPressKeyTool(client, windows),
    createBrowserScrollTool(client, windows),
    createBrowserHoverTool(client, windows),
    createBrowserDragTool(client, windows),
    createBrowserClickAtTool(client, windows),
    createBrowserWaitForTool(client, windows),
    createBrowserActTool(client, windows, config.workspace),
    createBrowserHandleDialogTool(client, windows),
    createBrowserDownloadTool(client, windows, lowLevel),
    createBrowserPdfTool(client, windows, lowLevel),
    createBrowserEvalTool(client, windows, lowLevel),
    createBrowserCdpTool(client, windows, lowLevel),
    createBrowserScreenshotTool(client, windows),
    createBrowserListWindowsTool(windows),
    createBrowserNewWindowTool(windows),
    createBrowserCloseWindowTool(windows),
    createBrowserFocusTabTool(client, windows),
    createBrowserCloseTabTool(windows),
  ];
  for (const tool of tools) registry.register(guardedBrowserTool(tool));
  registry.register(createBrowserDoneTool());
}
