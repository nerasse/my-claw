import { type Tool, type ToolResult, str, strOpt, num } from "./types.ts";
import { formatError } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576;

export const bashTool: Tool = {
  name: "bash",
  description: "Execute a shell command",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
    },
    required: ["command"],
  },
  async execute(args): Promise<ToolResult> {
    const command = str(args, "command");
    if (!command.trim()) {
      return { success: false, output: "command is required and cannot be empty." };
    }
    const timeoutMs = num(args, "timeout", DEFAULT_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const proc = Bun.spawn(["bash", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: strOpt(args, "__workspaceDir") ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd(),
      });

      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
      }, timeoutMs);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      clearTimeout(timer);

      let output = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
      if (output.length > MAX_OUTPUT_BYTES) {
        output = output.slice(0, MAX_OUTPUT_BYTES) + `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
      }
      hooks.emit("tool:bash:execute", { command, exitCode, durationMs: Date.now() - startedAt });
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
