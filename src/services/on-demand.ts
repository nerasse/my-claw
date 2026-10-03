import type { MyClawConfig } from "../core/config.ts";
import { VoiceManager } from "../voice/manager.ts";
import { log } from "../utils/logger.ts";

/**
 * The systemd units the server starts and stops itself, from what the config asks for
 * (docs/on-demand-services.md). Installing a release renders them and never enables them: a
 * service nobody uses costs its RAM all the same (local Whisper held 549 MB on a box whose voice
 * had been in the cloud for weeks), and one whose dependencies are missing restarts forever.
 *
 * Whether a unit is needed is derived from the config every time, never stored: the config that
 * decides which engine answers is the one that decides whether its engine runs.
 */
export interface OnDemandUnit {
  unit: string;
  /** What runs on it, for the log. */
  serves: string;
  needed: (config: MyClawConfig) => boolean;
}

export const ON_DEMAND_UNITS: readonly OnDemandUnit[] = [
  {
    unit: "my-claw-whisper.service",
    serves: "local speech-to-text",
    needed: (config) => new VoiceManager(config).resolveMode("stt") === "local",
  },
];

export type Systemctl = (args: string[]) => Promise<{ code: number; stdout: string }>;

export const systemctlUser: Systemctl = async (args) => {
  const proc = Bun.spawn(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout: stdout.trim() };
};

/**
 * Set by the installed server's unit. A dev server on the same machine reads the same config and
 * must never start or stop the units the installed one runs on.
 */
export function managesUnits(env: Record<string, string | undefined> = process.env): boolean {
  return env["MY_CLAW_MANAGES_UNITS"] === "1";
}

/** Running, or restarting after a crash: either way, starting it again would change nothing. */
const UP = new Set(["active", "activating", "reloading"]);

export interface UnitChange {
  unit: string;
  action: "started" | "stopped";
}

export async function reconcileUnits(
  config: MyClawConfig,
  systemctl: Systemctl = systemctlUser,
  units: readonly OnDemandUnit[] = ON_DEMAND_UNITS,
): Promise<UnitChange[]> {
  const changes: UnitChange[] = [];
  for (const entry of units) {
    const [enabled, active] = await Promise.all([
      systemctl(["is-enabled", entry.unit]),
      systemctl(["is-active", entry.unit]),
    ]);
    // Not installed (an older layout, or a box that never had it): nothing to start or stop.
    if (enabled.stdout === "" || enabled.stdout === "not-found") continue;
    const isEnabled = enabled.stdout === "enabled";
    const isUp = UP.has(active.stdout);
    if (entry.needed(config)) {
      if (isEnabled && isUp) continue;
      const done = await systemctl(["enable", "--now", entry.unit]);
      if (done.code === 0) changes.push({ unit: entry.unit, action: "started" });
      void log(done.code === 0 ? "info" : "warn", done.code === 0 ? "on-demand unit started" : "on-demand unit failed to start", { unit: entry.unit, serves: entry.serves });
    } else {
      if (!isEnabled && !isUp) continue;
      const done = await systemctl(["disable", "--now", entry.unit]);
      if (done.code === 0) changes.push({ unit: entry.unit, action: "stopped" });
      void log(done.code === 0 ? "info" : "warn", done.code === 0 ? "on-demand unit stopped" : "on-demand unit failed to stop", { unit: entry.unit, serves: entry.serves });
    }
  }
  return changes;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * One pass at a time, in the order asked: a config reload and an app toggle landing together must
 * not race an `enable --now` against a `disable --now` on the same unit.
 */
export function scheduleReconcile(config: MyClawConfig, systemctl: Systemctl = systemctlUser): Promise<UnitChange[]> {
  const pass = queue.then(() => reconcileUnits(config, systemctl)).catch((err: unknown) => {
    void log("warn", "on-demand units: reconcile failed", { error: String(err) });
    return [] as UnitChange[];
  });
  queue = pass;
  return pass;
}
