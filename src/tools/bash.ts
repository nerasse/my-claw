import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import { type Tool, type ToolResult, type ToolProgress, str, strOpt, num } from "./types.ts";
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
      workdir: {
        type: "string",
        description:
          "Directory to run the command in. Set this when operating in a subtree or another repo, " +
          "instead of prefixing the command with 'cd'. Relative paths resolve against the workspace; " +
          "absolute paths are used as-is. Defaults to the workspace root.",
      },
      timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
    },
    required: ["command"],
  },
  async execute(args, onProgress?: (chunk: ToolProgress) => void): Promise<ToolResult> {
    const command = str(args, "command");
    if (!command.trim()) {
      return { success: false, output: "command is required and cannot be empty." };
    }
    const signal = args["__signal"] as AbortSignal | undefined;
    rethrowIfAborted(undefined, signal);
    const timeoutMs = num(args, "timeout", DEFAULT_TIMEOUT_MS);
    const workspaceDir = strOpt(args, "__workspaceDir") ?? process.env["MY_CLAW_WORKSPACE"] ?? process.cwd();
    const workdirArg = strOpt(args, "workdir");
    let cwd = workspaceDir;
    if (workdirArg && workdirArg.trim()) {
      const resolved = isAbsolute(workdirArg) ? resolve(workdirArg) : resolve(workspaceDir, workdirArg);
      try {
        if (!statSync(resolved).isDirectory()) {
          return { success: false, output: "", error: `workdir "${workdirArg}" is not a directory.` };
        }
      } catch {
        return { success: false, output: "", error: `workdir "${workdirArg}" does not exist.` };
      }
      cwd = resolved;
    }
    const startedAt = Date.now();
    try {
      // setsid runs the command as its own process-group leader (pgid == pid), so we can kill the
      // whole tree (children included) with a negative-pid signal -- no orphaned grandchildren.
      const proc = Bun.spawn(["setsid", "bash", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
        cwd,
      });

      const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
        try { process.kill(-proc.pid, sig); } catch { try { proc.kill(); } catch {} }
      };

      // SIGTERM alone hangs forever on a command that traps it (trap '' TERM) or is stuck in D
      // state; escalate to SIGKILL after a grace period, same as the abort path.
      const killWithEscalation = () => {
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref?.();
      };
      const timer = setTimeout(killWithEscalation, timeoutMs);
      const onAbort = killWithEscalation;
      signal?.addEventListener("abort", onAbort, { once: true });

      // Drain stdout and stderr concurrently: reading stdout to EOF first can deadlock a child
      // that floods stderr past the pipe buffer. With onProgress, each stream is read chunk by
      // chunk and forwarded to the caller (throttled) so a long command shows output as it lands;
      // the accumulator still holds the full text for the final result.
      const stdoutBuf: string[] = [];
      const stderrBuf: string[] = [];
      let stdoutFlush = "";
      let stderrFlush = "";
      let lastFlush = 0;
      const FLUSH_MS = 200;
      const maybeFlush = (force: boolean): void => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && now - lastFlush < FLUSH_MS) return;
        if (stdoutFlush || stderrFlush) {
          onProgress({ ...(stdoutFlush ? { stdout: stdoutFlush } : {}), ...(stderrFlush ? { stderr: stderrFlush } : {}) });
          stdoutFlush = "";
          stderrFlush = "";
          lastFlush = now;
        }
      };
      const drain = async (stream: ReadableStream<Uint8Array> | null, buf: string[], which: "stdout" | "stderr"): Promise<void> => {
        if (!stream) return;
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            buf.push(text);
            if (onProgress) {
              if (which === "stdout") stdoutFlush += text;
              else stderrFlush += text;
              maybeFlush(false);
            }
          }
        } finally {
          reader.releaseLock();
        }
      };
      const stdoutP = drain(proc.stdout, stdoutBuf, "stdout");
      const stderrP = drain(proc.stderr, stderrBuf, "stderr");
      const exitCode = await proc.exited;
      await Promise.all([stdoutP, stderrP]);
      maybeFlush(true);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rethrowIfAborted(undefined, signal);

      const stdout = stdoutBuf.join("");
      const stderr = stderrBuf.join("");
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
