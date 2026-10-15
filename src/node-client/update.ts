import { chmod, open, rename, rm } from "node:fs/promises";
import { basename } from "node:path";
import type { NodeLogger } from "./connection.ts";
import { httpBaseOf } from "./config.ts";

/**
 * Self-update: the server offers the build it runs, the node fetches it through the same relay
 * that installed it, proves it works, replaces itself and restarts (docs/remote-nodes.md).
 *
 * Best-effort by design: a failed fetch or a binary that does not prove its version leaves the
 * old one serving, and the next reconnect offers again (at most once every half hour).
 */

const UPDATE_RETRY_MS = 30 * 60 * 1000;
const attempts = new Map<string, number>();

/** One attempt per version per window: a relay that 404s must not be hammered with 100 MB. */
export function canAttemptUpdate(version: string, now = Date.now()): boolean {
  return now - (attempts.get(version) ?? 0) >= UPDATE_RETRY_MS;
}

export function markUpdateAttempt(version: string, now = Date.now()): void {
  attempts.set(version, now);
}

/** Module-level state, reset between test files. */
export function resetUpdateGuard(): void {
  attempts.clear();
}

export type UpdateOutcome = "updated" | "failed";

export interface ApplyUpdateOptions {
  server: string;
  token: string;
  version: string;
  target: string;
  /** Config dir, only to hand it to the restarted process on Windows. */
  dir?: string;
  execPath?: string;
  /** Narrower than `typeof fetch`: the static members (preconnect) are none of this code's business. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Called instead of the platform's restart, for tests. */
  restart?: () => void;
  log: NodeLogger;
}

export async function applyUpdate(options: ApplyUpdateOptions): Promise<UpdateOutcome> {
  const execPath = options.execPath ?? process.execPath;
  const fetchImpl = options.fetchImpl ?? fetch;

  // A dev run (`bun run src/node-client/main.ts`) has the Bun runtime as execPath: replacing it
  // with a node build would eat the runtime, so only a real node binary updates itself.
  if (!basename(execPath).startsWith("myclaw-node")) {
    options.log("warn", "update skipped: not running from a node binary", { execPath });
    return "failed";
  }

  const url = `${httpBaseOf(options.server)}/download?target=${encodeURIComponent(options.target)}&version=${encodeURIComponent(options.version)}`;
  const staged = `${execPath}.new`;
  try {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${options.token}` } });
    const body = response.body;
    if (!response.ok || !body) {
      await body?.cancel();
      options.log("warn", "update download refused", { version: options.version, status: response.status });
      return "failed";
    }
    // Streamed by hand, never `Bun.write(staged, response)`: measured on Bun 1.3.13, reading
    // `.body` first (the check above) then handing the Response to Bun.write hangs forever.
    const handle = await open(staged, "w", 0o755);
    try {
      for await (const chunk of body) {
        await handle.write(chunk as Uint8Array);
      }
    } finally {
      await handle.close();
    }
    await chmod(staged, 0o755);

    // The staged binary must prove it is the version it claims before it replaces the one
    // serving: a truncated download that renamed itself in would leave the machine with nothing.
    const proof = Bun.spawnSync([staged, "version"], { stdout: "pipe", stderr: "ignore" });
    const printed = proof.stdout ? new TextDecoder().decode(proof.stdout).trim() : "";
    if (proof.exitCode !== 0 || printed !== options.version) {
      options.log("warn", "update staged binary failed its check", { version: options.version, printed, exitCode: proof.exitCode });
      await rm(staged, { force: true });
      return "failed";
    }

    if (process.platform === "win32") {
      // Windows refuses to replace a running image, but it lets it be renamed away first.
      await rename(execPath, `${execPath}.old`).catch(() => undefined);
    }
    await rename(staged, execPath);
    options.log("info", "updated, restarting", { version: options.version, execPath });

    if (options.restart) {
      options.restart();
      return "updated";
    }
    if (process.platform === "win32") {
      // The Scheduled Task does not restart a finished process: hand the new binary its own life.
      Bun.spawn(["cmd", "/c", "start", "", execPath, "run", ...(options.dir ? ["--dir", options.dir] : [])], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    }
    // Under systemd or launchd the exit is what restarts it with the new binary; a manual run
    // just stops, which is the honest behaviour for something nobody supervises.
    process.exit(0);
  } catch (err) {
    await rm(staged, { force: true }).catch(() => undefined);
    options.log("warn", "update failed", { version: options.version, error: err instanceof Error ? err.message : String(err) });
    return "failed";
  }
}
