import { join } from "node:path";
import { type Tool, type ToolResult, str, strOpt, numOpt, bool } from "../types.ts";
import type { BrowserClient } from "../../browser/client.ts";
import type { BrowserConfig } from "../../core/config.ts";
import { resolveWorkspacePath } from "../workspace.ts";
import { log } from "../../utils/logger.ts";
import { windowed, workspaceOf } from "./state.ts";
import type { BrowserWindows } from "./windows.ts";
import { downloadRoot } from "./downloads.ts";
import { globToRegExp } from "../../utils/glob.ts";

/** Methods the subagent may drive when allowCdp is on. Deliberately narrow: page structure,
 *  input synthesis and rendering. Anything touching the browser session itself is refused by
 *  the sidecar regardless of what is listed here. */
const DEFAULT_CDP_ALLOWLIST = [
  "DOM.*",
  "Input.*",
  "Emulation.*",
  "Runtime.evaluate",
  "Page.navigate",
  "Page.captureScreenshot",
  "Page.printToPDF",
];

export function isCdpMethodAllowed(method: string, allowlist?: string[]): boolean {
  const patterns = allowlist?.length ? allowlist : DEFAULT_CDP_ALLOWLIST;
  return patterns.some((pattern) => globToRegExp(pattern).test(method));
}

export interface BrowserLowLevelOptions {
  config?: BrowserConfig;
  workspaceDir?: string;
}

function downloadDirFor(opts: BrowserLowLevelOptions, args: Record<string, unknown>): string {
  return downloadRoot(opts.config, args, opts.workspaceDir);
}

/** Audit trail for the powerful tools. Written before the call so a crash still leaves a
 *  trace of what was attempted. */
async function audit(tool: string, detail: Record<string, unknown>): Promise<void> {
  await log("info", "browser low-level call", { tool, ...detail });
}

export function createBrowserEvalTool(
  client: BrowserClient,
  pages: BrowserWindows,
  opts: BrowserLowLevelOptions,
): Tool {
  return {
    name: "browser_eval",
    description: "Run JavaScript inside the page and get a value back. Pass a statement BODY and use `return` (e.g. `return document.title`). Use it to read state the snapshot does not show, or to drive a widget that resists every normal action. Only for what the other tools cannot express.",
    parameters: windowed({
      type: "object",
      properties: {
        js: { type: "string", description: "JavaScript statement body; use return to produce a value" },
      },
      required: ["js"],
    }),
    async execute(args): Promise<ToolResult> {
      if (!opts.config?.allowEval) {
        return {
          success: false,
          output: "",
          error: "browser_eval is disabled. Set browser.allowEval = true in config.json to enable it.",
        };
      }
      const js = str(args, "js");
      try {
        const pageId = await pages.page(args);
        await audit("browser_eval", { js: js.slice(0, 500) });
        const result = await client.evaluate(pageId, js);
        return { success: true, output: result.value };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserCdpTool(
  client: BrowserClient,
  pages: BrowserWindows,
  opts: BrowserLowLevelOptions,
): Tool {
  return {
    name: "browser_cdp",
    description: "Send a raw Chrome DevTools Protocol command to the current page (e.g. DOM.getDocument, Input.dispatchKeyEvent). Last resort when nothing else reaches the element. Methods are restricted to an allowlist, and anything touching the browser session (cookies, storage, other targets) is permanently refused.",
    parameters: windowed({
      type: "object",
      properties: {
        method: { type: "string", description: "CDP method, e.g. DOM.getDocument" },
        params: { type: "object", description: "Method parameters" },
      },
      required: ["method"],
    }),
    async execute(args): Promise<ToolResult> {
      if (!opts.config?.allowCdp) {
        return {
          success: false,
          output: "",
          error: "browser_cdp is disabled. Set browser.allowCdp = true in config.json to enable it.",
        };
      }
      const method = str(args, "method");
      const allowlist = opts.config.cdpAllowlist;
      if (!isCdpMethodAllowed(method, allowlist)) {
        return {
          success: false,
          output: "",
          error: `CDP method "${method}" is not allowed. Allowed: ${(allowlist?.length ? allowlist : DEFAULT_CDP_ALLOWLIST).join(", ")}.`,
        };
      }
      const params = (args["params"] ?? {}) as Record<string, unknown>;
      try {
        const pageId = await pages.page(args);
        await audit("browser_cdp", { method, params: JSON.stringify(params).slice(0, 500) });
        const result = await client.cdp(pageId, method, params);
        return { success: true, output: result.result };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserHandleDialogTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_handle_dialog",
    description: "Decide how the NEXT native dialog on this page is answered (alert, confirm, prompt). Call it before the click that triggers the dialog. Without it dialogs are auto-accepted, because an unanswered one freezes the page.",
    parameters: windowed({
      type: "object",
      properties: {
        accept: { type: "boolean", description: "true to accept/OK, false to dismiss/Cancel" },
        prompt_text: { type: "string", description: "Text to type into a prompt() dialog" },
      },
      required: ["accept"],
    }),
    async execute(args): Promise<ToolResult> {
      try {
        const accept = bool(args, "accept", true);
        await client.handleDialog(await pages.page(args), accept, strOpt(args, "prompt_text"));
        return { success: true, output: `Next dialog will be ${accept ? "accepted" : "dismissed"}.` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserPdfTool(
  client: BrowserClient,
  pages: BrowserWindows,
  opts: BrowserLowLevelOptions,
): Tool {
  return {
    name: "browser_pdf",
    description: "Save the current page as a PDF and return the local path. Useful to archive a result (invoice, ticket, confirmation) rather than describing it.",
    parameters: windowed({
      type: "object",
      properties: {
        path: { type: "string", description: "Destination path; defaults to the download directory" },
      },
    }),
    async execute(args): Promise<ToolResult> {
      const requested = strOpt(args, "path");
      const destination = requested
        ? resolveWorkspacePath(requested, workspaceOf(args, opts.workspaceDir))
        : join(downloadDirFor(opts, args), `page-${Date.now()}.pdf`);
      try {
        const result = await client.pdf(await pages.page(args), destination);
        return { success: true, output: `Saved PDF to ${result.path}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
