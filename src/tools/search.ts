import { join } from "node:path";
import { type Tool, type ToolResult, strOpt } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { MY_CLAW_DIR } from "../core/config.ts";
import { resolveRipgrep } from "./ripgrep.ts";
import {
  capOutput,
  describeQuery,
  executeQuery,
  firstMissingRoot,
  joinBatch,
  normalizeQuery,
  SEARCH_MAX_LIMIT,
  type SearchQuery,
} from "./search-core.ts";

const SINGLE_QUERY_KEYS = [
  "path", "paths", "pattern", "glob", "mode", "context", "after", "before",
  "limit", "offset", "ignoreCase", "extract", "invert", "all", "exclude", "excludeDirs",
] as const;

async function rgForThisCall(): Promise<string | null> {
  if (process.env["MY_CLAW_SEARCH_ENGINE"] === "grep") return null;
  const resolution = await resolveRipgrep({
    vendorDir: join(import.meta.dir, "..", "..", "vendor", "ripgrep"),
    cacheDir: join(MY_CLAW_DIR, "tools", "ripgrep"),
    allowDownload: process.env["MY_CLAW_RG_NO_DOWNLOAD"] !== "1",
  });
  return resolution?.path ?? null;
}

export const searchTool: Tool = {
  name: "search",
  description:
    "Search the filesystem, ripgrep-backed. `pattern` matches file contents (Rust regex: " +
    "\\d, \\s, \\w and \\b work; lookaround and backreferences do not); `glob` filters file " +
    "paths (braces like *.{ts,tsx} work) or lists files when `pattern` is omitted.\n" +
    "Skipped by default: hidden files, .gitignore/.ignore rules, and node_modules, __pycache__, " +
    "vendor, target, dist, build, coverage. `all: true` searches everything, and an explicit path " +
    "into a skipped directory is still searched.\n" +
    "Modes: `files` (default) returns paths only, `count` per-file counts, `content` the matching " +
    "lines with `context` or `after`/`before`. `paths` searches several roots; `searches` runs a " +
    "batch of queries in one call; `offset` pages through results. Prefer this over `bash grep` " +
    "to find content in files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory or file to search in. Defaults to the workspace.",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Extra roots to search in the same call (grep-style multiple paths).",
      },
      pattern: {
        type: "string",
        description:
          "Rust regex (ripgrep) matched against file contents: \\d, \\s, \\w, \\b work, alternation | and + work unescaped; lookaround and backreferences do not. Omit to list files by name.",
      },
      glob: {
        type: "string",
        description:
          "File path glob (e.g. *.ts, src/**/*.ts, *.{ts,tsx}): filters a content search, or lists files when pattern is omitted.",
      },
      mode: {
        type: "string",
        enum: ["files", "count", "content"],
        description:
          "files (default): matching paths only. count: matches per file. content: the matching lines.",
      },
      context: { type: "number", description: "Symmetric lines of context, content mode only (max 40). Cannot be combined with after/before." },
      after: { type: "number", description: "Lines shown after each match, content mode only (max 40)." },
      before: { type: "number", description: "Lines shown before each match, content mode only (max 40)." },
      limit: {
        type: "number",
        description: `Entries (files or lines) returned per query (default 250, max ${SEARCH_MAX_LIMIT}).`,
      },
      offset: { type: "number", description: "Entries to skip before the page: pairs with the continuation hint of a cut result." },
      ignoreCase: { type: "boolean", description: "Case-insensitive match" },
      extract: { type: "boolean", description: "Content mode only: return just the matched text (-o)." },
      invert: { type: "boolean", description: "Return non-matching entries instead (-v)." },
      all: {
        type: "boolean",
        description:
          "Search everything: no .gitignore rules, hidden files and the default-skipped directories included.",
      },
      exclude: {
        type: "array",
        items: { type: "string" },
        description: "Glob patterns of files to skip (e.g. *.log).",
      },
      excludeDirs: {
        type: "array",
        items: { type: "string" },
        description: "Directory names to skip (e.g. node_modules, __pycache__).",
      },
      searches: {
        type: "array",
        items: { type: "object" },
        description:
          "Batch of queries run in one call, each with the same fields as a single search (path, pattern, glob, mode, context, limit, ...). Results carry one header per query; the shared output budget cuts the batch with a named marker when reached.",
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const wsDir = strOpt(args, "__workspaceDir");
    const signal = args["__signal"] as AbortSignal | undefined;
    const defaultRoot = wsDir ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd();
    const resolveRoot = (input: string) => resolveWorkspacePath(input, wsDir);

    const batchRaw = args["searches"];
    if (batchRaw !== undefined) {
      const misuse = SINGLE_QUERY_KEYS.find((key) => args[key] !== undefined);
      if (misuse) {
        return { success: false, output: `searches replaces the single-query fields: remove ${JSON.stringify(misuse)}.` };
      }
      if (!Array.isArray(batchRaw) || batchRaw.length === 0) {
        return { success: false, output: "searches must be a non-empty array of query objects." };
      }
      const queries: SearchQuery[] = [];
      for (const [index, entry] of batchRaw.entries()) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return { success: false, output: `searches[${index}] must be an object.` };
        }
        const normalized = normalizeQuery(entry as Record<string, unknown>, { resolveRoot, defaultRoot });
        if ("error" in normalized) return { success: false, output: `searches[${index}]: ${normalized.error}` };
        queries.push(normalized.query);
      }
      for (const [index, query] of queries.entries()) {
        const missing = await firstMissingRoot(query.roots);
        if (missing) return { success: false, output: `searches[${index}]: Path not found: ${missing}. Check the path exists.` };
      }
      const rgPath = await rgForThisCall();
      const parts: { header: string; text: string }[] = [];
      for (const [index, query] of queries.entries()) {
        const outcome = await executeQuery(query, { rgPath, ...(signal ? { signal } : {}) });
        parts.push({ header: `── [${index + 1}/${queries.length}] ${describeQuery(query)}`, text: outcome.text });
      }
      return { success: true, output: joinBatch(parts) };
    }

    const normalized = normalizeQuery(args, { resolveRoot, defaultRoot });
    if ("error" in normalized) return { success: false, output: normalized.error };
    const query = normalized.query;

    const missing = await firstMissingRoot(query.roots);
    if (missing) return { success: false, output: `Path not found: ${missing}. Check the path exists.` };

    const rgPath = await rgForThisCall();
    const outcome = await executeQuery(query, { rgPath, ...(signal ? { signal } : {}) });
    if (!outcome.ok) return { success: false, output: outcome.text };
    return { success: true, output: capOutput(outcome.text) };
  },
};
