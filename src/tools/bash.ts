import { type Tool, type ToolResult, str, strOpt, num } from "./types.ts";
import { formatError } from "../utils/errors.ts";
import { rethrowIfAborted } from "../core/aborted.ts";
import { hooks } from "../hooks/index.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const KILL_GRACE_MS = 2_000;

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
    const signal = args["__signal"] as AbortSignal | undefined;
    rethrowIfAborted(undefined, signal);
    const timeoutMs = num(args, "timeout", DEFAULT_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      // setsid runs the command as its own process-group leader (pgid == pid), so we can kill the
      // whole tree (children included) with a negative-pid signal -- no orphaned grandchildren.
      const proc = Bun.spawn(["setsid", "bash", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: strOpt(args, "__workspaceDir") ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd(),
      });

      const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
        try { process.kill(-proc.pid, sig); } catch { try { proc.kill(); } catch {} }
      };

      const timer = setTimeout(() => killGroup("SIGTERM"), timeoutMs);
      const onAbort = () => {
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref?.();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rethrowIfAborted(undefined, signal);

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
      rethrowIfAborted(e, signal);
      return { success: false, output: "", error: formatError(`Failed to execute "${command}"`, e) };
    }
  },
};
