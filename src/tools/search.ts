import { access } from "node:fs/promises";
import { type Tool, type ToolResult, str, strOpt, bool, numOpt } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";

const OUTPUT_LIMIT = 100_000;
/** Enough to read a function around a hit without turning a search into a file dump. */
const MAX_CONTEXT_LINES = 40;
/** The depth `find` used before it was folded in here; deep enough for a repo, bounded for a home dir. */
const MAX_DEPTH = 10;

async function run(argv: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", cwd });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function capped(output: string): string {
  return output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n[output truncated at 100KB]` : output;
}

export const searchTool: Tool = {
  name: "search",
  description:
    "Search the filesystem: `pattern` matches file contents (regex, results as path:line:text), " +
    "`glob` filters or, alone, lists files by name. Add `context` for surrounding lines and " +
    "`filesOnly` for just the paths.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory or file to search in" },
      pattern: { type: "string", description: "Regex matched against file contents. Omit to list files by name." },
      glob: { type: "string", description: "File name pattern (e.g. *.ts): filters a content search, or lists files when alone" },
      context: { type: "number", description: "Lines of context around each match (max 40)" },
      filesOnly: { type: "boolean", description: "Report only the files that match, not the matching lines" },
      ignoreCase: { type: "boolean", description: "Case-insensitive match" },
      recursive: { type: "boolean", description: "Search subdirectories (default true)" },
    },
    required: ["path"],
  },
  async execute(args): Promise<ToolResult> {
    const path = str(args, "path");
    const pattern = str(args, "pattern").trim();
    const glob = str(args, "glob").trim();
    if (!path.trim()) return { success: false, output: "path is required and cannot be empty." };
    if (!pattern && !glob) {
      return { success: false, output: "pattern (file contents) or glob (file names) is required." };
    }

    const wsDir = strOpt(args, "__workspaceDir");
    let resolved: string;
    try {
      resolved = resolveWorkspacePath(path, wsDir);
    } catch (e) {
      return { success: false, output: "", error: String((e as Error).message) };
    }
    try {
      await access(resolved);
    } catch {
      return { success: false, output: `Path not found: ${resolved}. Check the path exists.` };
    }
    const cwd = wsDir ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd();

    // Name search: no content pattern, so the glob is the whole query.
    if (!pattern) {
      try {
        const { stdout, stderr, exitCode } = await run(["find", resolved, "-maxdepth", String(MAX_DEPTH), "-name", glob], cwd);
        if (exitCode !== 0 && !stdout.trim()) {
          return { success: false, output: "", error: `find failed (exit ${exitCode}): ${stderr.trim() || "unreadable path or bad pattern"}` };
        }
        return { success: true, output: capped(stdout) || "No files found" };
      } catch (e) {
        return { success: false, output: "", error: formatError(`Failed to list files in "${resolved}"`, e) };
      }
    }

    const flags: string[] = ["-n"];
    if (bool(args, "recursive", true)) flags.push("-r");
    if (bool(args, "ignoreCase", false)) flags.push("-i");
    if (bool(args, "filesOnly", false)) flags.push("-l");
    const context = numOpt(args, "context");
    if (context !== undefined && context > 0) {
      flags.push(`-C${Math.min(Math.floor(context), MAX_CONTEXT_LINES)}`);
    }
    const filters = glob ? [`--include=${glob}`] : [];

    try {
      // "--" stops option parsing so a pattern starting with "-" is not read as a flag.
      const argv = ["grep", ...flags, "--max-count=1000", "--binary-files=without-match", ...filters, "--", pattern, resolved];
      const { stdout, stderr, exitCode } = await run(argv, cwd);
      // grep exit codes: 0 = matches, 1 = no matches (not an error), >=2 = real error.
      if (exitCode >= 2) {
        return { success: false, output: "", error: `grep failed (exit ${exitCode}): ${stderr.trim() || "invalid pattern or unreadable path"}` };
      }
      return { success: true, output: capped(stdout) || "No matches found" };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to search in "${resolved}"`, e) };
    }
  },
};
