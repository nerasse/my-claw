import type { Tool, ToolResult } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";

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
    try {
      const proc = Bun.spawn(
        ["find", resolveWorkspacePath(args["path"] as string), "-name", args["pattern"] as string],
        { stdout: "pipe", stderr: "pipe", cwd: process.env["MY_CLAW_WORKSPACE"] ?? process.cwd() },
      );
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return { success: true, output: stdout || "No files found" };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
