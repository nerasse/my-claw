import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { writeFileAtomically } from "../utils/atomic-write.ts";
import type { NodeToolManifest } from "../nodes/types.ts";
import { exposedTools, pathAllowed, type NodeClientConfig } from "./config.ts";

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
}

export interface NodeToolContext {
  config: NodeClientConfig;
  signal: AbortSignal;
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
const MAX_SEARCH_DEPTH = 10;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_IGNORES = new Set([".git", "node_modules"]);
const SEARCH_DEFAULT_LIMIT = 250;
const SEARCH_MAX_LIMIT = 2000;

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

function resolvePath(config: NodeClientConfig, input: string): string {
  const base = config.workdir ? resolve(config.workdir) : homedir();
  return isAbsolute(input) ? resolve(input) : resolve(base, input);
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
  async execute(args, { config }) {
    const input = str(args, "path");
    if (!input.trim()) return { ok: false, output: "", error: "path is required and cannot be empty." };
    const resolved = resolvePath(config, input);
    if (!pathAllowed(config, resolved)) return { ok: false, output: "", error: `Path outside the allowed roots: ${resolved}` };
    try {
      const raw = await readFile(resolved);
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

/** `*` and `?` against a file name, the way `find -name` reads them. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

async function walkFiles(root: string, recursive: boolean, out: string[], depth = 0): Promise<void> {
  if (depth > MAX_SEARCH_DEPTH) return;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (SEARCH_IGNORES.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (recursive) await walkFiles(path, recursive, out, depth + 1);
      continue;
    }
    if (entry.isFile()) out.push(path);
  }
}

const searchTool: NodeTool = {
  name: "search",
  description:
    "Search this machine's files: a JavaScript regex against file contents, or a glob against file " +
    "names. .git and node_modules are skipped.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory or file to search in" },
      pattern: { type: "string", description: "Regular expression matched against file contents. Omit to list files by name." },
      glob: { type: "string", description: "File name pattern (e.g. *.log): filters a content search, or lists files when alone" },
      mode: { type: "string", enum: ["files", "count", "content"], description: "files (default): matching paths only. count: matches per file. content: the matching lines." },
      limit: { type: "number", description: `Entries returned before the result is cut (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT})` },
      context: { type: "number", description: "Lines of context around each match, content mode only (max 40)" },
      ignoreCase: { type: "boolean", description: "Case-insensitive match" },
      recursive: { type: "boolean", description: "Search subdirectories (default true)" },
    },
    required: ["path"],
  },
  async execute(args, { config }) {
    const input = str(args, "path");
    const pattern = str(args, "pattern").trim();
    const glob = str(args, "glob").trim();
    if (!input.trim()) return { ok: false, output: "path is required and cannot be empty." };
    if (!pattern && !glob) return { ok: false, output: "pattern (file contents) or glob (file names) is required." };
    const resolved = resolvePath(config, input);
    if (!pathAllowed(config, resolved)) return { ok: false, output: "", error: `Path outside the allowed roots: ${resolved}` };
    try {
      await stat(resolved);
    } catch {
      return { ok: false, output: `Path not found: ${resolved}. Check the path exists.` };
    }

    let regex: RegExp | undefined;
    if (pattern) {
      try {
        regex = new RegExp(pattern, bool(args, "ignoreCase", false) ? "i" : "");
      } catch (error) {
        return { ok: false, output: "", error: `Invalid pattern: ${describeError(error)}` };
      }
    }
    const nameFilter = glob ? globToRegExp(glob) : undefined;
    const mode = (str(args, "mode") || "files") as "files" | "count" | "content";
    const limit = Math.min(Math.max(1, Math.floor(num(args, "limit", SEARCH_DEFAULT_LIMIT))), SEARCH_MAX_LIMIT);
    const context = Math.min(Math.max(0, Math.floor(num(args, "context", 0))), 40);
    const recursive = bool(args, "recursive", true);

    let files: string[];
    const info = await stat(resolved);
    if (info.isFile()) {
      files = [resolved];
    } else {
      files = [];
      await walkFiles(resolved, recursive, files);
    }
    if (nameFilter) files = files.filter((file) => nameFilter.test(basename(file)));

    if (!regex) {
      const shown = files.slice(0, limit);
      return { ok: true, output: shown.join("\n") || `No files matching ${JSON.stringify(glob)} under ${resolved}` };
    }

    const lines: string[] = [];
    let entries = 0;
    for (const file of files) {
      if (entries >= limit) break;
      const size = (await stat(file).catch(() => null))?.size ?? 0;
      if (size > MAX_SEARCH_FILE_BYTES) continue;
      const text = await readFile(file, "utf-8").catch(() => null);
      if (text === null || text.includes("\u0000")) continue;
      const fileLines = text.split("\n");
      const hits: number[] = [];
      for (const [index, line] of fileLines.entries()) {
        regex.lastIndex = 0;
        if (regex.test(line)) hits.push(index);
      }
      if (hits.length === 0) continue;
      if (mode === "files") {
        lines.push(file);
        entries += 1;
        continue;
      }
      if (mode === "count") {
        lines.push(`${file}:${hits.length}`);
        entries += 1;
        continue;
      }
      const shownLines = new Set<number>();
      for (const hit of hits) {
        for (let offset = -context; offset <= context; offset++) {
          const index = hit + offset;
          if (index >= 0 && index < fileLines.length) shownLines.add(index);
        }
      }
      for (const index of [...shownLines].sort((a, b) => a - b)) {
        if (entries >= limit) break;
        lines.push(`${file}:${index + 1}:${fileLines[index]}`);
        entries += 1;
      }
    }
    if (lines.length === 0) return { ok: true, output: `No matches for ${JSON.stringify(pattern)} under ${resolved}` };
    const capped = lines.length >= limit ? `${lines.join("\n")}\n[cut at ${limit} entries]` : lines.join("\n");
    return { ok: true, output: capped };
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
): Promise<NodeToolResult> {
  const tool = toolByName(config, name);
  if (!tool) return { ok: false, output: "", error: `tool "${name}" is not exposed by this node` };
  try {
    return await tool.execute(args, { config, signal });
  } catch (error) {
    return { ok: false, output: "", error: describeError(error) };
  }
}
