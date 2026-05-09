import type { Tool, ToolResult } from "./types.ts";

export const bashTool: Tool = {
  name: "bash",
  description: "Execute a shell command",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds" },
    },
    required: ["command"],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const proc = Bun.spawn(["bash", "-c", args["command"] as string], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: (args["__workspaceDir"] as string | undefined) ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd(),
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      return {
        success: exitCode === 0,
        output: stdout + (stderr ? `\nSTDERR: ${stderr}` : ""),
        error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
      };
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
