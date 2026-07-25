import { access } from "node:fs/promises";
import { type Tool, type ToolResult, str, num, numOpt } from "../types.ts";
import type { BrowserClient } from "../../browser/client.ts";
import { resolveWorkspacePath } from "../workspace.ts";
import { type BrowserPageState, getPageId, formatSnapshot } from "./state.ts";

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
        return { success: true, output: formatSnapshot(snapshot) };
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
        return { success: true, output: formatSnapshot(snapshot) };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserUploadFileTool(
  client: BrowserClient,
  state: BrowserPageState,
  workspaceDir?: string,
): Tool {
  return {
    name: "browser_upload_file",
    description: "Upload a local file to the page (profile photo, attachment, document). This handles the native OS file dialog, which clicking alone cannot. Pass the absolute path of the file. `ref` is optional and only useful when the page has several upload widgets: the file input itself is usually hidden and therefore has no ref, so leave it out and the right input is found for you.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the local file to upload" },
        ref: { type: "number", description: "Optional ref of the file input, or of the button that opens the picker" },
      },
      required: ["path"],
    },
    async execute(args): Promise<ToolResult> {
      let resolved: string;
      try {
        resolved = resolveWorkspacePath(str(args, "path"), workspaceDir);
      } catch (e) {
        return { success: false, output: "", error: String((e as Error).message) };
      }
      try {
        await access(resolved);
      } catch {
        return { success: false, output: "", error: `File not found: ${resolved}` };
      }
      try {
        const pageId = getPageId(state);
        const info = await client.uploadFile(pageId, [resolved], numOpt(args, "ref"));
        const snapshot = await client.snapshot(pageId);
        return {
          success: true,
          output: `Uploaded ${resolved} (via ${info.via}).\n${formatSnapshot(snapshot)}`,
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserSelectOptionTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_select_option",
    description: "Choose a value in a dropdown by the ref of the dropdown itself. Handles native <select> as well as custom comboboxes (React div role=combobox) whose options are not real <option> elements. Use this instead of trying to click the option yourself.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "number", description: "Ref of the dropdown / combobox" },
        value: { type: "string", description: "Visible label of the option to choose (e.g. \"July\", \"1997\")" },
      },
      required: ["ref", "value"],
    },
    async execute(args): Promise<ToolResult> {
      const ref = num(args, "ref", 0);
      const value = str(args, "value");
      try {
        const pageId = getPageId(state);
        const info = await client.selectOption(pageId, ref, value);
        const snapshot = await client.snapshot(pageId);
        return {
          success: true,
          output: `Selected "${value}" (via ${info.via}). Verify it took effect below.\n${formatSnapshot(snapshot)}`,
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserPressKeyTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_press_key",
    description: "Press a keyboard key: Enter, Tab, Escape, ArrowDown, ArrowUp, PageDown, Backspace... Targets the given ref, or the currently focused element. The keyboard is often the only way to operate a custom dropdown or submit a form with no visible button.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name, e.g. Enter, Escape, ArrowDown" },
        ref: { type: "number", description: "Optional element ref to focus before pressing" },
      },
      required: ["key"],
    },
    async execute(args): Promise<ToolResult> {
      const key = str(args, "key");
      try {
        const pageId = getPageId(state);
        await client.pressKey(pageId, key, numOpt(args, "ref"));
        const snapshot = await client.snapshot(pageId);
        return { success: true, output: `Pressed ${key}.\n${formatSnapshot(snapshot)}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserScrollTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_scroll",
    description: "Scroll the page, or bring one element into view by ref. Elements listed as \"offscreen\" in a snapshot must be scrolled to before they can be clicked reliably, and lazy-loaded content only appears once scrolled.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", description: "up, down, left or right (default down)" },
        amount: { type: "number", description: "Distance in pixels (default 600)" },
        ref: { type: "number", description: "Optional ref to scroll into view instead of scrolling the page" },
      },
    },
    async execute(args): Promise<ToolResult> {
      const direction = str(args, "direction") || "down";
      try {
        const pageId = getPageId(state);
        await client.scroll(pageId, direction, numOpt(args, "amount"), numOpt(args, "ref"));
        const snapshot = await client.snapshot(pageId);
        return { success: true, output: formatSnapshot(snapshot) };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
