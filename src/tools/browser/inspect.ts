import { type Tool, type ToolResult, str, strOpt, num } from "../types.ts";
import type { BrowserClient } from "../../browser/client.ts";
import { type BrowserPageState, getPageId } from "./state.ts";

/** Reading tools: search the snapshot, and read what the page fetched for itself.
 *
 *  Both exist because the alternative an agent reaches for is `browser_eval` with a hand-rolled
 *  querySelector or scroll loop. That is how a profile extraction turned into thirty low-level
 *  calls that each guessed at class names and still came back empty. A modern page renders from
 *  JSON its own scripts requested: that JSON is stable across redesigns, already parsed, and
 *  holds the fields the DOM only ever shows a virtualised window of. */

export function createBrowserFindTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_find",
    description:
      "Search the current page snapshot for a string and get only the matching lines, with their refs. Use this instead of re-snapshotting a long page when you are looking for one control or one value.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for, case-insensitive" },
      },
      required: ["query"],
    },
    async execute(args): Promise<ToolResult> {
      const query = str(args, "query");
      try {
        const result = await client.find(getPageId(state), query);
        if (result.matches === 0) {
          return {
            success: true,
            output: `No line matches "${query}" on ${result.url}. The page may not have rendered it yet: browser_wait_for, or read the JSON with browser_network.`,
          };
        }
        const shown = result.lines.join("\n");
        const more = result.matches > result.lines.length ? `\n...${result.matches - result.lines.length} more matches` : "";
        return { success: true, output: `${result.matches} match(es) on ${result.url}:\n${shown}${more}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserNetworkTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_network",
    description:
      "List the JSON responses this page has fetched, newest first, with an id for each. The data behind a dynamic page is almost always here, already structured. Read one with browser_response.",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Only URLs containing this string" },
      },
      required: [],
    },
    async execute(args): Promise<ToolResult> {
      const filter = strOpt(args, "filter");
      try {
        const result = await client.responses(getPageId(state), filter);
        if (result.responses.length === 0) {
          const scope = filter ? ` matching "${filter}"` : "";
          return {
            success: true,
            output: `No JSON response recorded${scope} (${result.total} seen on this page). Responses are recorded from the moment the tab opens: act on the page, then look again.`,
          };
        }
        const rows = result.responses
          .map((r) => `[${r.id}] ${r.status} ${r.method} ${r.url}`)
          .join("\n");
        return { success: true, output: `${result.responses.length} of ${result.total} recorded:\n${rows}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserResponseTool(client: BrowserClient, state: BrowserPageState): Tool {
  return {
    name: "browser_response",
    description:
      "Read the body of one response listed by browser_network, by its id. Prefer this over scraping the rendered DOM when the page has the data as JSON.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "Response id from browser_network" },
      },
      required: ["id"],
    },
    async execute(args): Promise<ToolResult> {
      const id = num(args, "id", 0);
      try {
        const result = await client.responseBody(getPageId(state), id);
        const note = result.truncated ? "\n[body truncated]" : "";
        return { success: true, output: `${result.status} ${result.url}\n${result.body}${note}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
