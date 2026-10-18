import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import { type Tool, type ToolResult, type ToolProgress, str, strOpt, num } from "./types.ts";
import { formatError } from "../utils/errors.ts";
import { rethrowIfAborted } from "../core/aborted.ts";
import { hooks } from "../hooks/index.ts";
import type { BashConfig } from "../core/config.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;

/** A tiny timeout is a 'kill fast' probe; one below a second races the spawn itself. */
function clampTimeout(value: number): number {
  return Math.min(Math.max(Math.floor(value), 1_000), MAX_TIMEOUT_MS);
}
const MAX_OUTPUT_BYTES = 1_048_576;
const KILL_GRACE_MS = 2_000;

/** What any shell needs to behave like a shell. Nothing here is a credential. */
const BASE_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "LANG",
  "TZ",
  "PWD",
  "MY_CLAW_DIR",
];

/** Prefixes that carry locale and desktop wiring, never secrets. */
const BASE_ENV_PREFIXES = ["LC_", "XDG_"];

/**
 * The service tokens the skills drive, and only those. Overridable through
 * `tools.bashEnvPassthrough` for an owner who wires a skill to something else.
 */
export const DEFAULT_PASSTHROUGH = [
  "FORGEJO_URL",
  "FORGEJO_TOKEN",
  "NEXTCLOUD_URL",
  "NEXTCLOUD_USER",
  "NEXTCLOUD_TOKEN",
];

let passthrough = DEFAULT_PASSTHROUGH;

/**
 * Set at boot and on every config reload. A module-level seam rather than a parameter because
 * `bashTool` is a value, not a factory, and the list has to follow a hot-reloaded config.
 */
export function setBashEnvPassthrough(names: string[] | undefined): void {
  passthrough = names ?? DEFAULT_PASSTHROUGH;
}

/** "8 GiB", in the words the config uses. */
export function memoryLabel(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  return `${gib % 1 === 0 ? gib : gib.toFixed(1)} GiB`;
}

/** The box one call runs in. Defaults chosen for this host: 8 GiB of 11 GiB for one command,
 * 2 GiB of swap (the rest is the server's reserve), 512 tasks. See docs/bash-limits.md. */
export interface BashLimits {
  memoryMaxBytes: number;
  swapMaxBytes: number;
  tasksMax: number;
  cgroup: boolean;
  /** The wall when a call passes no `timeout` of its own: builds and test runs outgrow two minutes. */
  timeoutMs: number;
}

const DEFAULT_MEMORY_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_SWAP_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TASKS_MAX = 512;

let limits: BashLimits = {
  memoryMaxBytes: DEFAULT_MEMORY_MAX_BYTES,
  swapMaxBytes: DEFAULT_SWAP_MAX_BYTES,
  tasksMax: DEFAULT_TASKS_MAX,
  cgroup: true,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

/** Follows a hot-reloaded `tools.bash`, like the env passthrough above. */
export function setBashLimits(config?: BashConfig): void {
  limits = {
    memoryMaxBytes: config?.memoryMaxBytes ?? DEFAULT_MEMORY_MAX_BYTES,
    swapMaxBytes: config?.swapMaxBytes ?? DEFAULT_SWAP_MAX_BYTES,
    tasksMax: config?.tasksMax ?? DEFAULT_TASKS_MAX,
    cgroup: config?.cgroup ?? true,
    timeoutMs: config?.timeoutMs && config.timeoutMs > 0 ? clampTimeout(config.timeoutMs) : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Whether this host can run `systemd-run --user --scope`, asked once per process.
 *
 * A container with no user bus says no and every call runs bare, exactly as before -- that is
 * what the CI runner is. The probe is also what keeps a missing `systemd-run` binary from
 * turning every tool call into an ENOENT.
 */
let scopeAvailable: boolean | null = null;

export function resetBashScopeProbe(): void {
  scopeAvailable = null;
}

function probeScope(): boolean {
  if (scopeAvailable !== null) return scopeAvailable;
  try {
    scopeAvailable = Bun.spawnSync(["systemd-run", "--user", "--scope", "--quiet", "/bin/true"]).exitCode === 0;
  } catch {
    scopeAvailable = false;
  }
  return scopeAvailable;
}

/**
 * What to exec for one call.
 *
 * In a scope the command sits behind `systemd-run`: the cgroup counts the command and every
 * process it spawns, and kills them at the ceiling instead of letting the kernel's OOM killer
 * pick the server (2026-09-22: it did -- `oom_score_adj 200` made the server the preferred
 * victim). The inner shell raises its own oom_score_adj to 1000 first: a positive adjustment is
 * all an unprivileged process may write, and it makes the children die before the server even if
 * a global OOM finds no scope to blame. The command itself rides along as `$0`, never
 * interpolated, so quoting survives the round trip.
 */
export function bashArgvFor(command: string, withScope: boolean, forLimits: BashLimits = limits): string[] {
  const bare = ["setsid", "bash", "-c", command];
  if (!forLimits.cgroup || !withScope) return bare;
  return [
    "setsid",
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "-p",
    `MemoryMax=${forLimits.memoryMaxBytes > 0 ? forLimits.memoryMaxBytes : "infinity"}`,
    "-p",
    `MemorySwapMax=${forLimits.swapMaxBytes > 0 ? forLimits.swapMaxBytes : 0}`,
    "-p",
    `TasksMax=${forLimits.tasksMax > 0 ? forLimits.tasksMax : "infinity"}`,
    "bash",
    "-c",
    'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec bash -c "$0"',
    command,
  ];
}

/**
 * The environment a command is given, built by name instead of inherited.
 *
 * `Bun.spawn` without `env` hands the child the whole process environment, and on a host that
 * loads its keys from an `.env` that means every provider credential is one `echo` away. The
 * model writes these commands: a page it was asked to summarise only has to suggest one. Nothing
 * in a shell needs to call an LLM API by hand -- the transports do that in-process -- so those
 * keys are simply not there any more.
 */
export function bashEnv(
  source: Record<string, string | undefined> = process.env,
  passthrough: string[] = DEFAULT_PASSTHROUGH,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const wanted =
      BASE_ENV.includes(key) ||
      BASE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
      passthrough.includes(key);
    if (wanted) env[key] = value;
  }
  return env;
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a shell command. The call is killed after a wall (default 5 minutes): pass " +
    "`timeout` in milliseconds (up to 3600000) for long builds and test runs, and detach with " +
    "setsid for a job that must outlive the call.",
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
    const timeoutMs = clampTimeout(num(args, "timeout", limits.timeoutMs));
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
      // Inside a systemd scope when the host has one: the memory ceiling is the whole point
      // (docs/bash-limits.md).
      const scoped = limits.cgroup && probeScope();
      const proc = Bun.spawn(bashArgvFor(command, scoped), {
        stdout: "pipe",
        stderr: "pipe",
        cwd,
        env: bashEnv(process.env, passthrough),
      });

      const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
        try { process.kill(-proc.pid, sig); } catch { try { proc.kill(); } catch {} }
      };

      // SIGTERM alone hangs forever on a command that traps it (trap '' TERM) or is stuck in D
      // state; escalate to SIGKILL after a grace period, same as the abort path.
      let wallHit = false;
      const killWithEscalation = () => {
        wallHit = true;
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
      // A wall, a memory ceiling and an external kill all end in SIGKILL; only the first two are
      // ours to explain, and saying "memory limit" for a 45-minute timeout would be a lie.
      if (wallHit) {
        const waited = timeoutMs < 60_000 ? `${Math.round(timeoutMs / 1000)} s` : `${Math.round(timeoutMs / 60_000)} min`;
        return {
          success: false,
          output,
          error:
            `Command timed out after ${waited} and was killed. Long commands: re-run with a larger ` +
            `timeout (up to ${MAX_TIMEOUT_MS} ms), or detach the job (setsid) and poll its log.`,
        };
      }
      if (proc.signalCode === "SIGKILL" || exitCode === 137) {
        const ceiling =
          scoped && limits.memoryMaxBytes > 0
            ? `: the command hit its memory limit (${memoryLabel(limits.memoryMaxBytes)})`
            : "";
        return {
          success: false,
          output,
          error: `Killed (SIGKILL)${ceiling}, or killed externally. Raise tools.bash.memoryMaxBytes in config.json to allow more.`,
        };
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
