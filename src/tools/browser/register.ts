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
  createBrowserFocusTabTool,
  createBrowserListTabsTool,
  createBrowserNavigateTool,
  createBrowserReloadTool,
  createBrowserScreenshotTool,
  createBrowserSnapshotTool,
} from "./navigation.ts";
import { createBrowserDoneTool, guardedBrowserTool, type BrowserSession } from "./session.ts";

/**
 * The browser agent's toolbox, in the process-wide registry.
 *
 * Registered once and handed out by `getForAgent("browser")` alone: the raw tools drive the one
 * shared Chromium, so every other agent keeps `delegate_browser_task` as its only door. They read
 * the calling run's workspace from their arguments and the low-level flags from the live config,
 * which is what lets one registration serve every conversation and survive a hot-reload.
 */
export function registerBrowserTools(registry: ToolRegistry, config: MyClawConfig, session: BrowserSession): void {
  const { client, pageState } = session;
  const lowLevel: BrowserLowLevelOptions = {
    get config() {
      return config.browser;
    },
    workspaceDir: config.workspace,
  };
  const tools = [
    createBrowserNavigateTool(client, pageState),
    createBrowserReloadTool(client, pageState),
    createBrowserSnapshotTool(client, pageState),
    createBrowserFindTool(client, pageState),
    createBrowserNetworkTool(client, pageState),
    createBrowserResponseTool(client, pageState),
    createBrowserFetchTool(client, pageState),
    createBrowserTextTool(client, pageState),
    createBrowserClickTool(client, pageState),
    createBrowserTypeTool(client, pageState),
    createBrowserSelectOptionTool(client, pageState),
    createBrowserUploadFileTool(client, pageState, config.workspace),
    createBrowserPressKeyTool(client, pageState),
    createBrowserScrollTool(client, pageState),
    createBrowserHoverTool(client, pageState),
    createBrowserDragTool(client, pageState),
    createBrowserClickAtTool(client, pageState),
    createBrowserWaitForTool(client, pageState),
    createBrowserActTool(client, pageState, config.workspace),
    createBrowserHandleDialogTool(client, pageState),
    createBrowserDownloadTool(client, pageState, lowLevel),
    createBrowserPdfTool(client, pageState, lowLevel),
    createBrowserEvalTool(client, pageState, lowLevel),
    createBrowserCdpTool(client, pageState, lowLevel),
    createBrowserScreenshotTool(client, pageState),
    createBrowserListTabsTool(client),
    createBrowserFocusTabTool(client, pageState),
    createBrowserCloseTabTool(client),
  ];
  for (const tool of tools) registry.register(guardedBrowserTool(tool));
  registry.register(createBrowserDoneTool());
}
