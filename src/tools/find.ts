import { access } from "node:fs/promises";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";

export const findTool: Tool = {
  name: "find",
  description: "Find files by name pattern",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to search in" },
      pattern: { type: "string", description: "File name pattern (glob)" },
    },
    required: ["path", "pattern"],
  },
  async execute(args): Promise<ToolResult> {
    const path = str(args, "path");
    const pattern = str(args, "pattern");
    if (!path.trim()) {
      return { success: false, output: "path is required and cannot be empty." };
    }
    if (!pattern.trim()) {
      return { success: false, output: "pattern is required and cannot be empty." };
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
      return { success: false, output: `Directory not found: ${resolved}. Check the path exists.` };
    }
    try {
      const proc = Bun.spawn(
        ["find", resolved, "-maxdepth", "10", "-name", pattern],
        { stdout: "pipe", stderr: "pipe", cwd: wsDir ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd() },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0 && !stdout.trim()) {
        return { success: false, output: "", error: `find failed (exit ${exitCode}): ${stderr.trim() || "unreadable path or bad pattern"}` };
      }
      const truncated = stdout.length > 100_000 ? stdout.slice(0, 100_000) + "\n[output truncated at 100KB]" : stdout;
      return { success: true, output: truncated || "No files found" };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to find in "${resolved}"`, e) };
    }
  },
};
