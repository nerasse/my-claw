import { access } from "node:fs/promises";
import type { Tool, ToolResult } from "./types.ts";
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
    const pattern = args["pattern"] as string;
    const path = args["path"] as string;
    if (!pattern || !pattern.trim()) {
      return { success: false, output: "pattern is required and cannot be empty." };
    }
    if (!path || !path.trim()) {
      return { success: false, output: "path is required and cannot be empty." };
    }
    const resolved = resolveWorkspacePath(path, args["__workspaceDir"] as string | undefined);
    try {
      await access(resolved);
    } catch {
      return { success: false, output: `Path not found: ${resolved}. Check the path exists.` };
    }
    try {
      const flags = args["recursive"] !== false ? "-rn" : "-n";
      const proc = Bun.spawn(
        ["grep", flags, pattern, resolved],
        { stdout: "pipe", stderr: "pipe", cwd: (args["__workspaceDir"] as string | undefined) ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd() },
      );
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return { success: true, output: stdout || "No matches found" };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to grep in "${resolved}"`, e) };
    }
  },
};
