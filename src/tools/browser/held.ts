import { type ToolResult } from "../types.ts";
import { formatDuration, parseDurationMs } from "../../utils/duration.ts";
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
 * with what each waits for and until when, and the release or extension of its own. Reached
 * through `delegate_browser_task` with `kept` rather than a tool of its own (2026-10-04): it is
 * the delegating side's business, and one definition fewer on every request of the orchestrator.
 */
export async function keptWindows(windows: BrowserWindows, args: Record<string, unknown>, caller: string): Promise<ToolResult> {
  try {
    if (args["kept"] === "extend") {
      const alias = typeof args["window"] === "number" ? args["window"] : undefined;
      if (alias === undefined) return { success: false, output: "", error: "Name the window to keep longer." };
      let ms: number;
      try {
        ms = parseDurationMs(typeof args["hold"] === "string" ? args["hold"] : "24h");
      } catch (err) {
        return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
      }
      const hold = await windows.extend({ alias, holder: caller }, ms);
      return hold
        ? { success: true, output: describeHold({ ...hold, alias, open: true }, Date.now(), caller) }
        : { success: false, output: "", error: "No window of that number is kept for this conversation." };
    }
    if (args["kept"] === "release") {
      const alias = typeof args["window"] === "number" ? args["window"] : undefined;
      const all = args["all"] === true;
      if (alias === undefined && !all) return { success: false, output: "", error: "Name the window to release, or set all=true." };
      const released = await windows.release({ ...(alias !== undefined ? { alias } : {}), all, holder: caller });
      return released > 0
        ? { success: true, output: `Released ${released} window${released > 1 ? "s" : ""}: the next task may use ${released > 1 ? "them" : "it"}.` }
        : { success: false, output: "", error: "No window of that number is kept for this conversation. The owner can release any window with /windows." };
    }
    if (args["kept"] !== "list") return { success: false, output: "", error: `Unknown kept action "${String(args["kept"])}": use list, release or extend.` };
    const kept = await windows.kept();
    if (kept.length === 0) return { success: true, output: "No browser window is kept." };
    const now = Date.now();
    return { success: true, output: kept.map((hold) => describeHold(hold, now, caller)).join("\n") };
  } catch (err) {
    return { success: false, output: "", error: `Could not read the browser's windows: ${err instanceof Error ? err.message : String(err)}` };
  }
}
