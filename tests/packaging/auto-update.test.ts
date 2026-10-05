/**
 * The timer's own gate, run as shipped against a throwaway install. An update in progress stops the
 * server, and a stopped server is a free pass for the gate: without asking the updater's lock first,
 * the next tick started a second update that died on that lock and left the unit failed
 * (2026-09-22, two updates to 0.7.49 a few seconds apart).
 */

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

/**
 * The timer's user branch, which is the one that reads the updater's lock: root takes the legacy
 * path for a different layout entirely. CI runs as root, so the tests run the script as nobody
 * there, which needs to walk down to the tree (the run's root is 0700: traverse only, no listing).
 */
const AS_NOBODY = process.getuid?.() === 0;
const UNPRIVILEGED = { uid: 65534, gid: 65534 };

async function install(): Promise<{ app: string; marker: string; script: string }> {
  if (AS_NOBODY) await chmod(MY_CLAW_DIR, 0o711);
  const dir = await mkdtemp(join(tmpdir(), "auto-update-"));
  if (AS_NOBODY) await chmod(dir, 0o755);
  // Run the shipped script from inside the throwaway tree: a checkout under a home directory is
  // not readable by the unprivileged user CI makes these run as.
  const script = join(dir, "auto-update.sh");
  await writeFile(script, await readFile(join(root, "packaging", "auto-update.sh")), { mode: 0o755 });
  const app = join(dir, "opt");
  const home = join(dir, "home");
  const marker = join(dir, "updater-ran");
  await mkdir(join(app, "current", "packaging"), { recursive: true });
  await mkdir(join(home, ".my-claw"), { recursive: true });
  await writeFile(join(app, ".install-meta"), `USER=claw\nHOME=${home}\n`);
  await writeFile(join(app, "current", "package.json"), JSON.stringify({ version: "0.7.1" }));
  // No registry configured: past the lock, the script stops at "cannot check the registry".
  await writeFile(join(home, ".my-claw", ".env"), "");
  await writeFile(join(app, "current", "packaging", "update.sh"), `#!/bin/bash\ntouch ${marker}\n`, { mode: 0o755 });
  return { app, marker, script };
}

function tick(app: string, script: string): { code: number; out: string } {
  const command = [script];
  const run = Bun.spawnSync(
    AS_NOBODY
      ? ["setpriv", `--reuid=${UNPRIVILEGED.uid}`, `--regid=${UNPRIVILEGED.gid}`, "--clear-groups", "bash", ...command]
      : ["bash", ...command],
    {
      env: { ...process.env, MY_CLAW_APP_DIR: app, XDG_RUNTIME_DIR: "/nonexistent" },
    },
  );
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

describe("a tick that lands during an update", () => {
  test("skips cleanly while the updater holds its lock, and goes on once it is released", async () => {
    const { app, marker, script } = await install();
    const lock = join(app, ".update.lock");
    await writeFile(lock, "");
    // The updater's own way of holding it (`exec 9>lock; flock -n 9`), in one process so that
    // killing it is releasing it.
    const holder = Bun.spawn(["bash", "-c", 'exec 9>"$1"; flock 9; exec sleep 30', "_", lock]);
    try {
      for (let i = 0; i < 100 && Bun.spawnSync(["flock", "-n", lock, "true"]).exitCode === 0; i++) await Bun.sleep(20);
      const held = tick(app, script);
      expect(held.code).toBe(0);
      expect(held.out).toContain("an update is already running");
      expect(existsSync(marker)).toBe(false);
    } finally {
      holder.kill();
      await holder.exited;
    }
    const free = tick(app, script);
    expect(free.out).not.toContain("an update is already running");
    expect(free.out).toContain("cannot check the registry");
  });

  test("a lock file nobody holds is no reason to skip", async () => {
    const { app, script } = await install();
    await writeFile(join(app, ".update.lock"), "");
    expect(tick(app, script).out).toContain("cannot check the registry");
  });

  test("the lock the timer asks is the one the updater takes", async () => {
    const updater = await readFile(join(root, "packaging", "update.sh"), "utf8");
    const timer = await readFile(join(root, "packaging", "auto-update.sh"), "utf8");
    expect(updater).toContain('exec 9>"${APP_DIR}/.update.lock"');
    expect(timer).toContain('UPDATE_LOCK="${APP_DIR}/.update.lock"');
    expect(updater).toContain('exec 9>"/var/lock/my-claw-update.lock"');
    expect(timer).toContain('UPDATE_LOCK="/var/lock/my-claw-update.lock"');
  });
});
