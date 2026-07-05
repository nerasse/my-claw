import { type Tool, type ToolResult, str, strOpt, num } from "./types.ts";
import { formatError } from "../utils/errors.ts";
import { rethrowIfAborted } from "../core/aborted.ts";
import type { WebSearchConfig } from "../core/config.ts";

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_LANGUAGE = "fr";

function buildSearchUrl(params: {
  baseUrl: string;
  query: string;
  count: number;
  language: string;
}): string {
  const url = new URL(params.baseUrl);
  const pathname = url.pathname.endsWith("/")
    ? `${url.pathname}search`
    : `${url.pathname}/search`;
  url.pathname = pathname;
  url.search = "";
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", params.language);
  return url.toString();
}

function normalizeResult(value: unknown): { url: string; title: string; content?: string } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.url !== "string" || typeof candidate.title !== "string") {
    return null;
  }
  return {
    url: candidate.url,
    title: candidate.title,
    content: typeof candidate.content === "string" ? candidate.content : undefined,
  };
}

/**
 * SearXNG returns HTTP 200 with an empty `results` array both when nothing is found AND when its
 * engines are rate-limited/down (it lists them in `unresponsive_engines`). Without this, a throttled
 * backend looks identical to "no results" and the agent keeps firing useless searches. Returns a
 * human-readable degradation reason, or null if the backend is healthy (genuine empty).
 */
function describeUnresponsiveEngines(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const raw = (parsed as Record<string, unknown>).unresponsive_engines;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parts = raw
    .map((entry) => {
      if (Array.isArray(entry)) return entry.filter((x) => typeof x === "string" && x).join(": ");
      if (typeof entry === "string") return entry;
      return JSON.stringify(entry);
    })
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts.join("; ") : "all engines unavailable";
}

function formatResults(results: Array<{ url: string; title: string; content?: string }>): string {
  if (results.length === 0) {
    return "Aucun resultat trouve.";
  }
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title}`, `   URL: ${r.url}`];
      if (r.content) {
        lines.push(`   ${r.content}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export const DEGRADED_COOLDOWN_MS = 60_000;

export function createWebSearchTool(config?: WebSearchConfig): Tool {
  // When SearXNG reports its engines rate-limited, hammering it again only makes the
  // suspensions longer. Short-circuit further searches for a cooldown window.
  let degradedUntil = 0;
  let degradedReason = "";
  return {
    name: "web_search",
    description:
      "Search the web using a SearXNG instance. Returns titles, URLs, and snippets for current information lookup.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string.",
        },
        count: {
          type: "number",
          description: "Number of results to return (1-10).",
          minimum: 1,
          maximum: 10,
        },
        language: {
          type: "string",
          description: "Optional language code for results (e.g. fr, en, de).",
        },
      },
      required: ["query"],
    },
    async execute(args): Promise<ToolResult> {
      const baseUrl = config?.baseUrl;
      if (!baseUrl) {
        return {
          success: false,
          output: "",
          error:
            "Web search is not configured. Set webSearch.baseUrl in config.json.",
        };
      }

      const query = str(args, "query").trim();
      if (!query) {
        return { success: false, output: "", error: "query is required and cannot be empty." };
      }

      if (Date.now() < degradedUntil) {
        const waitS = Math.ceil((degradedUntil - Date.now()) / 1000);
        return {
          success: false,
          output: "",
          error: `Web search backend degraded (${degradedReason}); on cooldown for ${waitS}s more. Do NOT retry web_search now — answer from your own knowledge, use fetch on a known URL, or tell the user search is temporarily unavailable.`,
        };
      }

      const count = Math.min(10, Math.max(1, Math.floor(num(args, "count", 5))));
      const language = strOpt(args, "language")?.trim() || config?.language || DEFAULT_LANGUAGE;

      const url = buildSearchUrl({ baseUrl, query, count, language });

      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (config?.token) {
        headers["Authorization"] = `Bearer ${config.token}`;
      }

      const signal = args["__signal"] as AbortSignal | undefined;
      rethrowIfAborted(undefined, signal);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      const reqSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: reqSignal,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          return {
            success: false,
            output: "",
            error: `SearXNG search error (${response.status}): ${detail || response.statusText}`,
          };
        }

        const body = await response.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return { success: false, output: "", error: "SearXNG returned invalid JSON." };
        }

        const rawResults: unknown[] =
          parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).results)
            ? ((parsed as Record<string, unknown>).results as unknown[])
            : [];

        const results: Array<{ url: string; title: string; content?: string }> = [];
        for (const raw of rawResults) {
          const result = normalizeResult(raw);
          if (result) {
            results.push(result);
          }
          if (results.length >= count) {
            break;
          }
        }

        if (results.length === 0) {
          const degraded = describeUnresponsiveEngines(parsed);
          if (degraded) {
            degradedUntil = Date.now() + DEGRADED_COOLDOWN_MS;
            degradedReason = degraded;
            return {
              success: false,
              output: "",
              error: `Web search backend degraded: ${degraded}. The search service is likely rate-limited or down -- do not retry the same search repeatedly; answer from your own knowledge or tell the user search is unavailable.`,
            };
          }
          return { success: true, output: "No results found for this query." };
        }

        return { success: true, output: formatResults(results) };
      } catch (err) {
        rethrowIfAborted(err, signal);
        if (err instanceof Error && err.name === "AbortError") {
          return { success: false, output: "", error: "Web search timed out after 20 seconds." };
        }
        return { success: false, output: "", error: formatError("Web search failed", err) };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
