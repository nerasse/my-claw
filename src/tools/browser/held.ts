import { type Tool, type ToolResult } from "../types.ts";
import { formatDuration } from "../../utils/duration.ts";
import { holderOf, type BrowserWindows, type WindowHold } from "./windows.ts";

/** One kept window as a line: its number, what it waits for, until when, and whose it is. */
export function describeHold(hold: WindowHold & { alias?: number; open: boolean }, now: number, viewer?: string): string {
  const where = hold.open ? `Window ${hold.alias}` : "A window not open right now (it comes back if the browser restores it)";
  const whose = viewer === undefined ? hold.holder : hold.holder === holderOf(viewer) ? "yours" : "another conversation's";
  const why = hold.reason === "human" ? "waiting for a human" : "kept to continue";
  const until = new Date(hold.until).toLocaleString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const page = hold.urls[0] ? ` -- ${hold.urls[0]}` : "";
  return `${where}: ${why}${hold.label ? ` (${hold.label})` : ""}, ${whose}, until ${until} (in ${formatDuration(Math.max(0, hold.until - now))})${page}`;
}

/**
 * The windows a browser run kept for its conversation, as that conversation sees them: the list,
 * with what each waits for and until when, and the release of its own. Not a `browser_*` tool on
 * purpose: those belong to the browser agent alone, and this one belongs to whoever delegates.
 */
export function createHeldBrowserWindowsTool(windows: BrowserWindows): Tool {
  return {
    name: "held_browser_windows",
    description: "The browser windows kept after a browsing task (for a human, or for this conversation to continue in): list them with what each waits for and until when, or release the ones kept for this conversation once they are no longer needed. To continue in a kept window, delegate a new browsing task: it is offered that window first.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "release"] },
        window: { type: "number", description: "The window number to release (release)" },
        all: { type: "boolean", description: "Release every window kept for this conversation (release)" },
      },
      required: ["action"],
    },
    async execute(args): Promise<ToolResult> {
      const caller = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
      try {
        if (args["action"] === "release") {
          const alias = typeof args["window"] === "number" ? args["window"] : undefined;
          const all = args["all"] === true;
          if (alias === undefined && !all) return { success: false, output: "", error: "Name the window to release, or set all=true." };
          const released = await windows.release({ ...(alias !== undefined ? { alias } : {}), all, holder: caller });
          return released > 0
            ? { success: true, output: `Released ${released} window${released > 1 ? "s" : ""}: the next task may use ${released > 1 ? "them" : "it"}.` }
            : { success: false, output: "", error: "No window of that number is kept for this conversation. The owner can release any window with /windows." };
        }
        const kept = await windows.kept();
        if (kept.length === 0) return { success: true, output: "No browser window is kept." };
        const now = Date.now();
        return { success: true, output: kept.map((hold) => describeHold(hold, now, caller)).join("\n") };
      } catch (err) {
        return { success: false, output: "", error: `Could not read the browser's windows: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
