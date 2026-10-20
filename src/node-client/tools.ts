import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import type { NodeAttachment, NodeToolManifest } from "../nodes/types.ts";
import { mediaTypeForPath } from "../utils/media.ts";
import type { NodeUpload } from "./mcp.ts";
import {
  capOutput,
  DEFAULT_IGNORES,
  describeQuery,
  executeQuery,
  expandBraces,
  firstMissingRoot,
  joinBatch,
  normalizeQuery,
  renderLines,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  type SearchQuery,
} from "../tools/search-core.ts";
import { resolveRipgrep } from "../tools/ripgrep.ts";
import { exposedTools, nodeDir, pathAllowed, resolvePath, type NodeClientConfig } from "./config.ts";

/**
 * The tools a node offers, implemented here rather than imported from the server: this runs on
 * someone else's machine, where there is no workspace, no config store and no hooks. The schemas
 * and the result shapes follow the server's tools, so the model reads the same contracts wherever
 * a call runs (docs/remote-nodes.md).
 */

export interface NodeToolResult {
  ok: boolean;
  output: string;
  error?: string;
  /** Files this tool produced, already uploaded to the server that asked for the call. */
  attachments?: NodeAttachment[];
}

export interface NodeToolContext {
  config: NodeClientConfig;
  signal: AbortSignal;
  /** Uploads bytes to the server, so a picture this machine made reaches the model. */
  upload?: NodeUpload;
}

export interface NodeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: NodeToolContext): Promise<NodeToolResult>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_READ_CHARS = 100_000;
/** Past this, a media file is described rather than shipped: the server's own upload cap. */
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_DEPTH = 10;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const bashTool: NodeTool = {
  name: "bash",
  description:
    "Execute a shell command on this machine. PowerShell on Windows, bash elsewhere. The command " +
    "runs in the node's working directory; anything the machine's user can do, it can do.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeoutMs: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
    },
    required: ["command"],
  },
  async execute(args, { config, signal }) {
    const command = str(args, "command");
    if (!command.trim()) return { ok: false, output: "", error: "command is required and cannot be empty." };
    const timeoutMs = Math.min(Math.max(1_000, num(args, "timeoutMs", DEFAULT_TIMEOUT_MS)), MAX_TIMEOUT_MS);
    const cwd = config.workdir ? resolve(config.workdir) : homedir();
    const argv = process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-Command", command]
      : ["bash", "-lc", command];

    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      return { ok: false, output: "", error: describeError(error) };
    }

    let killed: "timeout" | "abort" | null = null;
    const kill = (): void => {
      try {
        // The whole process group when the shell leads one, the shell alone otherwise.
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };
    const timer = setTimeout(() => {
      killed = "timeout";
      kill();
    }, timeoutMs);
    const onAbort = (): void => {
      killed = "abort";
      kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);

    let output = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
    if (output.length > MAX_OUTPUT_BYTES) {
      output = output.slice(0, MAX_OUTPUT_BYTES) + `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
    }
    if (killed === "timeout") {
      const waited = timeoutMs < 60_000 ? `${Math.round(timeoutMs / 1000)} s` : `${Math.round(timeoutMs / 60_000)} min`;
      return { ok: false, output, error: `Command timed out after ${waited} and was killed.` };
    }
    if (killed === "abort") return { ok: false, output, error: "Command cancelled." };
    if (exitCode === 0) return { ok: true, output };
    return { ok: false, output, error: `Command exited with code ${exitCode}` };
  },
};

const readTool: NodeTool = {
  name: "read",
  description: "Read a text file from this machine's filesystem.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "File path (absolute, or relative to the working directory)" } },
    required: ["path"],
  },
  async execute(args, { config, upload }) {
    const input = str(args, "path");
    if (!input.trim()) return { ok: false, output: "", error: "path is required and cannot be empty." };
    const resolved = resolvePath(config, input);
    if (!pathAllowed(config, resolved)) return { ok: false, output: "", error: `Path outside the allowed roots: ${resolved}` };
    try {
      const raw = await readFile(resolved);
      // A picture, a sound, a video: the model reads text, so what it can use is the file itself.
      const kind = mediaTypeForPath(resolved);
      if (kind !== "file" && upload) {
        if (raw.length > MAX_MEDIA_BYTES) {
          return { ok: false, output: "", error: `${kind} too large to send (${Math.round(raw.length / (1024 * 1024))} MB, at most ${MAX_MEDIA_BYTES / (1024 * 1024)} MB)` };
        }
        const attachment = await upload(new Uint8Array(raw), basename(resolved));
        if (attachment) {
          return { ok: true, output: `${kind} ${resolved} (${Math.round(raw.length / 1024)} KB), attached to this reply.`, attachments: [attachment] };
        }
      }
      if (raw.subarray(0, 4096).includes(0)) {
        return { ok: false, output: `Binary file, not readable as text: ${resolved} (${Math.round(raw.length / 1024)} KB).` };
      }
      const content = raw.toString("utf-8");
      if (content.length > MAX_READ_CHARS) {
        return { ok: true, output: `${content.slice(0, MAX_READ_CHARS)}\n[output truncated at ${MAX_READ_CHARS} chars; file is ${content.length} chars]` };
      }
      return { ok: true, output: content };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return { ok: false, output: "", error: missing ? `File not found: ${resolved}. Check the path and ensure the file exists.` : describeError(error) };
    }
  },
};

const writeTool: NodeTool = {
  name: "write",
  description: "Write a file on this machine. Creates parent directories as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to the working directory)" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["path", "content"],
  },
  async execute(args, { config }) {
    const input = str(args, "path");
    const content = str(args, "content");
    if (!input.trim()) return { ok: false, output: "", error: "path is required and cannot be empty." };
    const resolved = resolvePath(config, input);
    if (!pathAllowed(config, resolved)) return { ok: false, output: "", error: `Path outside the allowed roots: ${resolved}` };
    try {
      await mkdir(dirname(resolved), { recursive: true });
      await writeFileAtomically(resolved, content);
      return { ok: true, output: `Written to ${resolved}` };
    } catch (error) {
      return { ok: false, output: "", error: describeError(error) };
    }
  },
};

interface PatchEdit {
  old: string;
  new: string;
  all: boolean;
}

function parseEdits(value: unknown): { edits: PatchEdit[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: "edits must be a non-empty array of {old, new} replacements." };
  const edits: PatchEdit[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") return { error: `edits[${index}] is not an object.` };
    const edit = raw as { old?: unknown; new?: unknown; all?: unknown };
    if (typeof edit.old !== "string" || edit.old.length === 0) return { error: `edits[${index}]: old is required and cannot be empty.` };
    if (typeof edit.new !== "string") return { error: `edits[${index}]: new is required (empty string deletes the block).` };
    edits.push({ old: edit.old, new: edit.new, all: edit.all === true });
  }
  return { edits };
}

function occurrenceLines(text: string, needle: string): number[] {
  const lines: number[] = [];
  let at = text.indexOf(needle);
  while (at !== -1 && lines.length < 5) {
    lines.push(text.slice(0, at).split("\n").length);
    at = text.indexOf(needle, at + 1);
  }
  return lines;
}

const applyPatchTool: NodeTool = {
  name: "apply_patch",
  description:
    "Edit an existing file by replacing exact text. Anchored, not line-numbered: each edit gives the " +
    "text to replace (old) and its replacement (new). The anchor must appear exactly once in the file " +
    "unless all=true. All edits of one call apply together or none does. Use this instead of rewriting " +
    "a file with write.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to the working directory)" },
      edits: {
        type: "array",
        description: "Replacements applied in order, all or nothing",
        items: {
          type: "object",
          properties: {
            old: { type: "string", description: "Exact text to replace, unique in the file unless all=true" },
            new: { type: "string", description: "Replacement text; empty string deletes the block" },
            all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique one" },
          },
          required: ["old", "new"],
        },
      },
    },
    required: ["path", "edits"],
  },
  async execute(args, { config }) {
    const input = str(args, "path");
    if (!input.trim()) return { ok: false, output: "", error: "path is required and cannot be empty." };
    const parsed = parseEdits(args["edits"]);
    if ("error" in parsed) return { ok: false, output: "", error: parsed.error };
    const resolved = resolvePath(config, input);
    if (!pathAllowed(config, resolved)) return { ok: false, output: "", error: `Path outside the allowed roots: ${resolved}` };

    let original: string;
    try {
      original = await readFile(resolved, "utf-8");
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return { ok: false, output: "", error: missing ? `File not found: ${resolved}. Create it with write.` : describeError(error) };
    }

    let next = original;
    const applied: string[] = [];
    for (const [index, edit] of parsed.edits.entries()) {
      const found = next.split(edit.old).length - 1;
      if (found === 0) {
        return {
          ok: false,
          output: "",
          error: `edits[${index}]: anchor not found in ${resolved}. Nothing was written. Read the file again and copy the exact text, whitespace included.`,
        };
      }
      if (found > 1 && !edit.all) {
        const lines = occurrenceLines(next, edit.old);
        return {
          ok: false,
          output: "",
          error:
            `edits[${index}]: anchor appears ${found} times in ${resolved} (lines ${lines.join(", ")}` +
            `${found > lines.length ? ", ..." : ""}). Nothing was written. Extend the anchor with surrounding lines until it is unique, or pass all=true to replace every occurrence.`,
        };
      }
      next = edit.all ? next.split(edit.old).join(edit.new) : next.replace(edit.old, () => edit.new);
      applied.push(`edits[${index}]: ${found} occurrence${found > 1 ? "s" : ""} replaced`);
    }
    if (next === original) {
      return { ok: false, output: "", error: "The edits left the file unchanged; nothing was written." };
    }
    try {
      await writeFileAtomically(resolved, next);
    } catch (error) {
      return { ok: false, output: "", error: describeError(error) };
    }
    const before = original.split("\n").length;
    const after = next.split("\n").length;
    return {
      ok: true,
      output: `Patched ${resolved} (${parsed.edits.length} edit${parsed.edits.length > 1 ? "s" : ""}, ${before} -> ${after} lines).\n${applied.join("\n")}`,
    };
  },
};

/** `*` and `?` against a file name, braces expanded first, `find -name` style. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function nameFilters(globs: string[]): RegExp[] {
  return globs.flatMap((glob) => expandBraces(glob)).map(globToRegExp);
}

async function walkFiles(root: string, skipDirs: Set<string>, hidden: boolean, out: string[], depth = 0): Promise<void> {
  if (depth > MAX_SEARCH_DEPTH) return;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    if (hidden && entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(path, skipDirs, hidden, out, depth + 1);
    else if (entry.isFile()) out.push(path);
  }
}

/**
 * The node's own engine, for a machine where ripgrep could not be resolved or downloaded. It
 * answers in the same shapes as the shared engine (headers, skip list, messages) but reads files
 * itself: JavaScript regex, no .gitignore rules, and the result carries a banner saying so.
 */
async function collectWithWalker(
  root: string,
  query: SearchQuery,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string; lines: string[] }> {
  const skipDirs = new Set<string>([...(query.all ? [] : [".git", ...DEFAULT_IGNORES]), ...query.excludeDirs]);
  const excludes = nameFilters(query.exclude);
  const includes = query.glob ? nameFilters([query.glob]) : [];
  const needed = query.offset + query.limit + 1;
  const lines: string[] = [];
  let re: RegExp | null = null;
  if (query.pattern) re = new RegExp(query.pattern, query.ignoreCase ? "i" : "");

  const processFile = async (file: string, applyFilters: boolean): Promise<void> => {
    const name = basename(file);
    if (applyFilters) {
      if (excludes.some((filter) => filter.test(name))) return;
      if (includes.length > 0 && !includes.some((filter) => filter.test(name))) return;
    }
    if (!re) {
      lines.push(file);
      return;
    }
    const size = (await stat(file).catch(() => null))?.size ?? 0;
    if (size > MAX_SEARCH_FILE_BYTES) return;
    const text = await readFile(file, "utf-8").catch(() => null);
    if (text === null || text.includes("\u0000")) return;
    const fileLines = text.split("\n");
    const selected: number[] = [];
    for (const [index, line] of fileLines.entries()) {
      const matches = re.test(line);
      if (matches !== query.invert) selected.push(index);
    }
    if (selected.length === 0) return;
    if (query.mode === "files") {
      lines.push(file);
      return;
    }
    if (query.mode === "count") {
      lines.push(`${file}:${selected.length}`);
      return;
    }
    if (query.extract && !query.invert) {
      const global = new RegExp(query.pattern, query.ignoreCase ? "gi" : "g");
      for (const index of selected) {
        for (const match of fileLines[index]!.matchAll(global)) {
          lines.push(`${file}:${index + 1}:${match[0]}`);
          if (lines.length >= needed) return;
        }
      }
      return;
    }
    const before = query.before || query.context;
    const after = query.after || query.context;
    const shown = new Set<number>();
    for (const index of selected) {
      for (let i = Math.max(0, index - before); i <= Math.min(fileLines.length - 1, index + after); i++) shown.add(i);
    }
    for (const index of [...shown].sort((a, b) => a - b)) {
      lines.push(`${file}:${index + 1}:${fileLines[index] ?? ""}`);
      if (lines.length >= needed) return;
    }
  };

  try {
    const info = await stat(root);
    if (info.isFile()) {
      await processFile(root, false);
    } else {
      const files: string[] = [];
      await walkFiles(root, skipDirs, !query.all, files);
      files.sort();
      for (const file of files) {
        if (signal.aborted) break;
        if (lines.length >= needed) break;
        await processFile(file, true);
      }
    }
  } catch (error) {
    return { ok: false, error: describeError(error), lines: [] };
  }
  return { ok: true, lines };
}

async function ripgrepForNode(): Promise<string | null> {
  if (process.env["MY_CLAW_SEARCH_ENGINE"] === "grep") return null;
  const resolution = await resolveRipgrep({
    cacheDir: join(nodeDir(), "tools", "ripgrep"),
    allowDownload: process.env["MY_CLAW_RG_NO_DOWNLOAD"] !== "1",
  });
  return resolution?.path ?? null;
}

const WALKER_BANNER = "[engine: local fallback (ripgrep unavailable): JavaScript regex, no .gitignore rules]\n";

async function runNodeQuery(query: SearchQuery, signal: AbortSignal): Promise<{ ok: boolean; text: string }> {
  const rgPath = await ripgrepForNode();
  if (rgPath) return executeQuery(query, { rgPath });
  if (query.pattern) {
    try {
      new RegExp(query.pattern);
    } catch (error) {
      // ripgrep names its own dialect; the walker's regex is JavaScript and says so the same way.
      return { ok: false, text: `Invalid pattern: ${describeError(error)}` };
    }
  }
  const collected: string[] = [];
  for (const root of query.roots) {
    const result = await collectWithWalker(root, query, signal);
    if (!result.ok) return { ok: false, text: result.error ?? "search failed" };
    collected.push(...result.lines);
  }
  return { ok: true, text: WALKER_BANNER + renderLines(query, collected) };
}

const SINGLE_QUERY_KEYS = [
  "path", "paths", "pattern", "glob", "mode", "context", "after", "before",
  "limit", "offset", "ignoreCase", "extract", "invert", "all", "exclude", "excludeDirs",
] as const;

const searchTool: NodeTool = {
  name: "search",
  description:
    "Search this machine's files, ripgrep-backed when available. `pattern` matches file contents " +
    "(Rust regex with ripgrep; JavaScript regex in the local fallback); `glob` filters file paths " +
    "(braces like *.{ts,tsx} work) or lists files when `pattern` is omitted.\n" +
    "Skipped by default: hidden files, .gitignore rules of the machine, and node_modules, " +
    "__pycache__, vendor, target, dist, build, coverage; `all: true` searches everything.\n" +
    "Modes: `files` (default) paths only, `count` per-file counts, `content` the matching lines " +
    "with `context` or `after`/`before`. `paths` searches several roots, `searches` batches " +
    "queries, `offset` pages through results.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory or file to search in. Defaults to the working directory." },
      paths: { type: "array", items: { type: "string" }, description: "Extra roots to search in the same call." },
      pattern: { type: "string", description: "Regular expression matched against file contents. Omit to list files by name." },
      glob: { type: "string", description: "File path glob (e.g. *.ts, *.{ts,tsx}): filters a content search, or lists files when pattern is omitted." },
      mode: { type: "string", enum: ["files", "count", "content"], description: "files (default): matching paths only. count: matches per file. content: the matching lines." },
      context: { type: "number", description: "Symmetric lines of context, content mode only (max 40). Cannot be combined with after/before." },
      after: { type: "number", description: "Lines shown after each match, content mode only (max 40)." },
      before: { type: "number", description: "Lines shown before each match, content mode only (max 40)." },
      limit: { type: "number", description: `Entries (files or lines) returned per query (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` },
      offset: { type: "number", description: "Entries to skip before the page: pairs with the continuation hint of a cut result." },
      ignoreCase: { type: "boolean", description: "Case-insensitive match" },
      extract: { type: "boolean", description: "Content mode only: return just the matched text (-o)." },
      invert: { type: "boolean", description: "Return non-matching entries instead (-v)." },
      all: { type: "boolean", description: "Search everything: gitignore rules, hidden files and the default-skipped directories included." },
      exclude: { type: "array", items: { type: "string" }, description: "Glob patterns of files to skip (e.g. *.log)." },
      excludeDirs: { type: "array", items: { type: "string" }, description: "Directory names to skip (e.g. node_modules, __pycache__)." },
      searches: {
        type: "array",
        items: { type: "object" },
        description: "Batch of queries run in one call, each with the same fields as a single search. Results carry one header per query; the shared output budget cuts the batch with a named marker when reached.",
      },
    },
  },
  async execute(args, { config, signal }) {
    const resolveRoot = (input: string) => resolvePath(config, input);
    const defaultRoot = resolvePath(config, ".");

    const checkRoots = (query: SearchQuery): string | null => {
      for (const root of query.roots) {
        if (!pathAllowed(config, root)) return `Path outside the allowed roots: ${root}`;
      }
      return null;
    };

    const batchRaw = args["searches"];
    if (batchRaw !== undefined) {
      const misuse = SINGLE_QUERY_KEYS.find((key) => args[key] !== undefined);
      if (misuse) return { ok: false, output: `searches replaces the single-query fields: remove ${JSON.stringify(misuse)}.` };
      if (!Array.isArray(batchRaw) || batchRaw.length === 0) {
        return { ok: false, output: "searches must be a non-empty array of query objects." };
      }
      const queries: SearchQuery[] = [];
      for (const [index, entry] of batchRaw.entries()) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return { ok: false, output: `searches[${index}] must be an object.` };
        }
        const normalized = normalizeQuery(entry as Record<string, unknown>, { resolveRoot, defaultRoot });
        if ("error" in normalized) return { ok: false, output: `searches[${index}]: ${normalized.error}` };
        const outside = checkRoots(normalized.query);
        if (outside) return { ok: false, output: "", error: outside };
        const missing = await firstMissingRoot(normalized.query.roots);
        if (missing) return { ok: false, output: `searches[${index}]: Path not found: ${missing}. Check the path exists.` };
        queries.push(normalized.query);
      }
      const parts: { header: string; text: string }[] = [];
      for (const [index, query] of queries.entries()) {
        const outcome = await runNodeQuery(query, signal);
        parts.push({ header: `── [${index + 1}/${queries.length}] ${describeQuery(query)}`, text: outcome.text });
      }
      return { ok: true, output: joinBatch(parts) };
    }

    const normalized = normalizeQuery(args, { resolveRoot, defaultRoot });
    if ("error" in normalized) return { ok: false, output: normalized.error };
    const query = normalized.query;
    const outside = checkRoots(query);
    if (outside) return { ok: false, output: "", error: outside };
    const missing = await firstMissingRoot(query.roots);
    if (missing) return { ok: false, output: `Path not found: ${missing}. Check the path exists.` };
    const outcome = await runNodeQuery(query, signal);
    if (!outcome.ok) return { ok: false, output: "", error: outcome.text };
    return { ok: true, output: capOutput(outcome.text) };
  },
};

const lsTool: NodeTool = {
  name: "ls",
  description: "List a directory on this machine.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path (absolute, or relative to the working directory)" } },
    required: ["path"],
  },
  async execute(args, { config }) {
    const input = str(args, "path");
    const resolved = resolvePath(config, input || ".");
    if (!pathAllowed(config, resolved)) return { ok: false, output: "", error: `Path outside the allowed roots: ${resolved}` };
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      if (entries.length === 0) return { ok: true, output: `(empty directory: ${resolved})` };
      const lines = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => `${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "-"} ${entry.name}`);
      return { ok: true, output: lines.join("\n") };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return { ok: false, output: "", error: missing ? `Directory not found: ${resolved}.` : describeError(error) };
    }
  },
};

const TOOLS: Record<string, NodeTool> = {
  bash: bashTool,
  read: readTool,
  write: writeTool,
  apply_patch: applyPatchTool,
  search: searchTool,
  ls: lsTool,
};

/** The manifest a node announces: only the tools its config exposes. */
export function manifestFor(config: NodeClientConfig): NodeToolManifest[] {
  return exposedTools(config).map((name) => {
    const tool = TOOLS[name]!;
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
  });
}

export function toolByName(config: NodeClientConfig, name: string): NodeTool | undefined {
  if (!exposedTools(config).includes(name as never)) return undefined;
  return TOOLS[name];
}

export async function runTool(
  config: NodeClientConfig,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  extras: { upload?: NodeUpload; mcp?: { call: (name: string, args: Record<string, unknown>) => Promise<NodeToolResult | null> } } = {},
): Promise<NodeToolResult> {
  const tool = toolByName(config, name);
  try {
    if (tool) return await tool.execute(args, { config, signal, ...(extras.upload ? { upload: extras.upload } : {}) });
    // An MCP tool is offered by this machine too: same manifest, same call path, one dispatch.
    const remote = extras.mcp ? await extras.mcp.call(name, args) : null;
    if (remote) return remote;
    return { ok: false, output: "", error: `tool "${name}" is not exposed by this node` };
  } catch (error) {
    return { ok: false, output: "", error: describeError(error) };
  }
}
