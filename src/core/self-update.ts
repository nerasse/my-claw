import { runRegistry } from "./run-registry.ts";
import { installKind, type InstallKind } from "../services/catalog.ts";

/**
 * Firing the maintenance gate on demand.
 *
 * The gate itself is `packaging/auto-update.sh`, the oneshot unit the timer runs every 15
 * minutes (docs/auto-update.md). It already owns the registry check, the lock, the atomic flip,
 * the rollback, the health check and the web bundle. Nothing of that is reimplemented here: this
 * asks systemd to run the unit now instead of at the next tick.
 *
 * Three properties matter.
 *
 * The unit belongs to the service user's own manager (docs/install-layout.md), so the server
 * starts it with `systemctl --user` and no privilege at all. An install that has not moved to
 * user units yet still has it as a root unit: there the user manager does not know it, and the
 * one `sudo -n` the legacy installer granted is tried second. Once the install has moved, sudo is
 * never spawned.
 *
 * `--no-block` because the unit is a oneshot that stops `my-claw.service` in its swap window: a
 * blocking `systemctl start` would wait for a job whose first act is to kill the caller, so the
 * answer would never be sent. With it, systemd enqueues the job and returns in milliseconds,
 * which is early enough to report a missing privilege honestly.
 *
 * The run registry is the gate on this side. The timer asks the server over `GET /health` before
 * swapping; a request coming *from* the server can read the registry directly, and refusing here
 * is what keeps a button press from yanking a live conversation out from under the agent.
 */

const UNIT = "my-claw-auto-update.service";

/** Why an update was not started. `busy` is the only one that is not a misconfiguration. */
export type UpdateRefusal = "busy" | "denied" | "failed";

export interface UpdateOutcome {
  started: boolean;
  reason?: UpdateRefusal;
  detail?: string;
}

/** Injected in tests: spawning systemd is the one thing that cannot run in a unit test. */
export type UnitStarter = (unit: string) => Promise<{ code: number; stderr: string }>;

async function run(cmd: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr: stderr.trim() };
}

const startUnit: UnitStarter = async (unit) => {
  const own = await run(["systemctl", "--user", "start", "--no-block", unit]);
  if (own.code === 0) return own;
  // sudo -n: never prompt. A legacy install granted exactly this command to the service user, so
  // a failure here means the drop-in is missing, and hanging on a password prompt would be worse.
  const legacy = await run(["sudo", "-n", "systemctl", "start", "--no-block", unit]);
  if (legacy.code === 0) return legacy;
  return { code: legacy.code, stderr: [own.stderr, legacy.stderr].filter(Boolean).join(" | ") };
};

/** A compose install is updated from the host: the server has no Docker socket (docs/compose.md). */
export const COMPOSE_UPDATE =
  "compose install: update from the host with `docker compose -f packaging/compose/compose.yml up -d --build` after pulling the repo";

export async function requestSelfUpdate(starter: UnitStarter = startUnit, kind: InstallKind = installKind()): Promise<UpdateOutcome> {
  if (kind === "compose") return { started: false, reason: "failed", detail: COMPOSE_UPDATE };
  if (runRegistry.hasAny()) return { started: false, reason: "busy" };
  try {
    const { code, stderr } = await starter(UNIT);
    if (code === 0) return { started: true };
    // A refused sudo and a failed unit are different problems: one is a drop-in to install, the
    // other is a machine to look at.
    const denied = /sudo|password|not allowed|no tty/i.test(stderr);
    return {
      started: false,
      reason: denied ? "denied" : "failed",
      ...(stderr ? { detail: stderr.slice(0, 500) } : {}),
    };
  } catch (err) {
    return { started: false, reason: "failed", detail: String(err).slice(0, 500) };
  }
}
