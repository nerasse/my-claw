import { access } from "node:fs/promises";
import { type Tool, type ToolResult, str, strOpt, bool } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";

export const grepTool: Tool = {
  name: "grep",
  description: "Search for a pattern in files",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern (regex)" },
      path: { type: "string", description: "Directory or file to search in" },
      recursive: { type: "boolean", description: "Search recursively" },
    },
    required: ["pattern", "path"],
  },
  async execute(args): Promise<ToolResult> {
    const pattern = str(args, "pattern");
    const path = str(args, "path");
    if (!pattern.trim()) {
      return { success: false, output: "pattern is required and cannot be empty." };
    }
    if (!path.trim()) {
      return { success: false, output: "path is required and cannot be empty." };
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
    try {
      const flags = bool(args, "recursive", true) ? "-rn" : "-n";
      // "--" stops option parsing so a pattern starting with "-" is not treated as a flag.
      const proc = Bun.spawn(
        ["grep", flags, "--max-count=1000", "--binary-files=without-match", "--", pattern, resolved],
        { stdout: "pipe", stderr: "pipe", cwd: wsDir ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd() },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // grep exit codes: 0 = matches, 1 = no matches (not an error), >=2 = real error.
      if (exitCode >= 2) {
        return { success: false, output: "", error: `grep failed (exit ${exitCode}): ${stderr.trim() || "invalid pattern or unreadable path"}` };
      }
      const truncated = stdout.length > 100_000 ? stdout.slice(0, 100_000) + "\n[output truncated at 100KB]" : stdout;
      return { success: true, output: truncated || "No matches found" };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to grep in "${resolved}"`, e) };
    }
  },
};
