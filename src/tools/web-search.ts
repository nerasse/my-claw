import type { Tool, ToolResult } from "./types.ts";
import { formatError } from "../utils/errors.ts";

export interface WebSearchConfig {
  baseUrl?: string;
  token?: string;
  language?: string;
}

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

export function createWebSearchTool(config?: WebSearchConfig): Tool {
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

      const query = (args["query"] as string)?.trim();
      if (!query) {
        return { success: false, output: "", error: "query is required and cannot be empty." };
      }

      const count = Math.min(10, Math.max(1, Math.floor((args["count"] as number) ?? 5)));
      const language = (args["language"] as string)?.trim() || config?.language || DEFAULT_LANGUAGE;

      const url = buildSearchUrl({ baseUrl, query, count, language });

      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (config?.token) {
        headers["Authorization"] = `Bearer ${config.token}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
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

        const output = formatResults(results);
        return { success: true, output };
      } catch (err) {
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
