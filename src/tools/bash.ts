import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { formatError } from "../utils/errors.ts";

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
    const command = str(args, "command");
    if (!command.trim()) {
      return { success: false, output: "command is required and cannot be empty." };
    }
    try {
      const proc = Bun.spawn(["bash", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: strOpt(args, "__workspaceDir") ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd(),
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
      if (exitCode === 0) {
        return { success: true, output };
      }
      return {
        success: false,
        output,
        error: `Command failed with exit code ${exitCode}. Check STDERR above for details.`,
      };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to execute "${command}"`, e) };
    }
  },
};
