import { access } from "node:fs/promises";
import { type Tool, type ToolResult, str, strOpt, num, numOpt } from "../types.ts";
import type { BrowserClient } from "../../browser/client.ts";
import { resolveWorkspacePath } from "../workspace.ts";
import { type BrowserPageState, getPageId, formatSnapshot, workspaceOf } from "./state.ts";

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
        resolved = resolveWorkspacePath(str(args, "path"), workspaceOf(args, workspaceDir));
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

export function createBrowserHoverTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_hover",
    description: "Hover the mouse over an element by ref. Needed for menus that only open on hover and for tooltips that reveal information.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "number", description: "Element ref number from snapshot" },
      },
      required: ["ref"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const pageId = getPageId(state);
        await client.hover(pageId, num(args, "ref", 0));
        const snapshot = await client.snapshot(pageId);
        return { success: true, output: formatSnapshot(snapshot) };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserDragTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_drag",
    description: "Drag one element onto another by ref (sliders, reorderable lists, drag-and-drop upload zones).",
    parameters: {
      type: "object",
      properties: {
        from_ref: { type: "number", description: "Ref of the element to drag" },
        to_ref: { type: "number", description: "Ref of the drop target" },
      },
      required: ["from_ref", "to_ref"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const pageId = getPageId(state);
        await client.drag(pageId, num(args, "from_ref", 0), num(args, "to_ref", 0));
        const snapshot = await client.snapshot(pageId);
        return { success: true, output: formatSnapshot(snapshot) };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserClickAtTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_click_at",
    description: "Click at a position given as FRACTIONS of the viewport: x=0.5, y=0.5 is the centre, x=0 is the left edge, y=1 the bottom. Take a screenshot first and estimate the fractions from it. This is the fallback for anything the DOM does not expose as a ref (canvas, WebGL, map widgets, exotic overlays) — fractions are used because screenshots may be resized before you see them, which would break pixel coordinates.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "Horizontal position, 0 to 1" },
        y: { type: "number", description: "Vertical position, 0 to 1" },
      },
      required: ["x", "y"],
    },
    async execute(args): Promise<ToolResult> {
      const x = num(args, "x", -1);
      const y = num(args, "y", -1);
      // Caught here rather than after a round trip: the most likely mistake is passing pixels.
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
        return {
          success: false,
          output: "",
          error: `x and y must be fractions of the viewport between 0 and 1 (got x=${x}, y=${y}). Divide pixel coordinates by the viewport size reported with the screenshot.`,
        };
      }
      try {
        const pageId = getPageId(state);
        const at = await client.clickAt(pageId, x, y);
        const snapshot = await client.snapshot(pageId);
        return {
          success: true,
          output: `Clicked at ${at.x},${at.y} of ${at.viewport.width}x${at.viewport.height}.\n${formatSnapshot(snapshot)}`,
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserWaitForTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_wait_for",
    description: "Wait for a condition instead of retrying blindly: for some text to appear, for a ref to become visible, or for a fixed delay when nothing better is available. Cheaper and more reliable than re-snapshotting in a loop.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Wait until this text is visible on the page" },
        ref: { type: "number", description: "Wait until this ref is visible" },
        timeout_ms: { type: "number", description: "Give up after this long (default 10000, max 30000)" },
      },
    },
    async execute(args): Promise<ToolResult> {
      try {
        const pageId = getPageId(state);
        const result = await client.waitFor(pageId, {
          text: strOpt(args, "text"),
          ref: numOpt(args, "ref"),
          timeoutMs: numOpt(args, "timeout_ms"),
        });
        const snapshot = await client.snapshot(pageId);
        return { success: true, output: `Wait satisfied (${result.waited}).\n${formatSnapshot(snapshot)}` };
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
