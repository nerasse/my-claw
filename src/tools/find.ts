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
    const resolved = resolveWorkspacePath(path, wsDir);
    try {
      await access(resolved);
    } catch {
      return { success: false, output: `Directory not found: ${resolved}. Check the path exists.` };
    }
    try {
      const proc = Bun.spawn(
        ["find", resolved, "-name", pattern],
        { stdout: "pipe", stderr: "pipe", cwd: wsDir ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd() },
      );
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return { success: true, output: stdout || "No files found" };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to find in "${resolved}"`, e) };
    }
  },
};
