import { type Tool, type ToolResult, str, strOpt, num, numOpt } from "../types.ts";
import type { BrowserClient } from "../../browser/client.ts";
import { windowed } from "./state.ts";
import type { BrowserWindows } from "./windows.ts";

function headersOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Reading tools: search the snapshot, and read what the page fetched for itself.
 *
 *  Both exist because the alternative an agent reaches for is `browser_eval` with a hand-rolled
 *  querySelector or scroll loop. That is how a profile extraction turned into thirty low-level
 *  calls that each guessed at class names and still came back empty. A modern page renders from
 *  JSON its own scripts requested: that JSON is stable across redesigns, already parsed, and
 *  holds the fields the DOM only ever shows a virtualised window of. */

export function createBrowserFindTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_find",
    description:
      "Search the current page snapshot for a string and get only the matching lines, with their refs. Use this instead of re-snapshotting a long page when you are looking for one control or one value.",
    parameters: windowed({
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for, case-insensitive" },
      },
      required: ["query"],
    }),
    async execute(args): Promise<ToolResult> {
      const query = str(args, "query");
      try {
        const result = await client.find(await pages.page(args), query);
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

export function createBrowserNetworkTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_network",
    description:
      "List the JSON responses this page has fetched, newest first, with an id for each. The data behind a dynamic page is almost always here, already structured. Read one with browser_response.",
    parameters: windowed({
      type: "object",
      properties: {
        filter: { type: "string", description: "Only URLs containing this string" },
      },
      required: [],
    }),
    async execute(args): Promise<ToolResult> {
      const filter = strOpt(args, "filter");
      try {
        const result = await client.responses(await pages.page(args), filter);
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

export function createBrowserResponseTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_response",
    description:
      "Read the body of one response listed by browser_network, by its id. Prefer this over scraping the rendered DOM when the page has the data as JSON.",
    parameters: windowed({
      type: "object",
      properties: {
        id: { type: "number", description: "Response id from browser_network" },
      },
      required: ["id"],
    }),
    async execute(args): Promise<ToolResult> {
      const id = num(args, "id", 0);
      try {
        const result = await client.responseBody(await pages.page(args), id);
        return { success: true, output: `${result.status} ${result.url}\n${result.body}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserFetchTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_fetch",
    description:
      "Issue an HTTP request FROM THE PAGE (same origin, session cookies included) and get the response body. Use it to hit the site's own API directly instead of scraping the rendered DOM: browser_network/browser_response only re-read what the page already fetched, this one asks. A non-2xx status comes back as a result, not an error.",
    parameters: windowed({
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL, or a path resolved against the current page" },
        method: { type: "string", description: "GET (default), POST, PUT..." },
        headers: { type: "object", description: "Optional request headers, as a plain object of strings" },
        body: { type: "string", description: "Optional request body for POST/PUT" },
      },
      required: ["url"],
    }),
    async execute(args): Promise<ToolResult> {
      const url = strOpt(args, "url");
      if (!url) return { success: false, output: "", error: "browser_fetch needs a url." };
      const method = strOpt(args, "method");
      const body = strOpt(args, "body");
      const headers = headersOf(args["headers"]);
      try {
        const result = await client.fetchInPage(await pages.page(args), {
          url,
          ...(method ? { method } : {}),
          ...(body ? { body } : {}),
          ...(headers ? { headers } : {}),
        });
        const type = result.contentType ? ` ${result.contentType}` : "";
        const payload = result.body.length === 0 ? "\n(empty body)" : `\n${result.body}`;
        return { success: true, output: `HTTP ${result.status}${type} ${result.url}${payload}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserTextTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_text",
    description:
      "The visible text of the page (and its iframes), which the accessibility tree does not carry. Use it to read prose, values or canvas-backed labels that have no ref, instead of writing JavaScript to reach document.body.innerText.",
    parameters: windowed({ type: "object", properties: {} }),
    async execute(args): Promise<ToolResult> {
      try {
        const result = await client.text(await pages.page(args));
        if (!result.text.trim()) return { success: true, output: "The page has no visible text." };
        return { success: true, output: result.text };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
