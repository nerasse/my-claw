/**
 * The timer's own gate, run as shipped against a throwaway install. An update in progress stops the
 * server, and a stopped server is a free pass for the gate: without asking the updater's lock first,
 * the next tick started a second update that died on that lock and left the unit failed
 * (2026-09-22, two updates to 0.7.49 a few seconds apart).
 */

import { afterAll, describe, expect, test } from "bun:test";
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

async function install(): Promise<{ app: string; marker: string; script: string; home: string }> {
  if (AS_NOBODY) await chmod(MY_CLAW_DIR, 0o711);
  const dir = await mkdtemp(join(tmpdir(), "auto-update-"));
  // Under CI's root the script runs as nobody, and the stand-in updater writes its marker here.
  if (AS_NOBODY) await chmod(dir, 0o777);
  // Run the shipped script from inside the throwaway tree: a checkout under a home directory is
  // not readable by the unprivileged user CI makes these run as.
  const script = join(dir, "auto-update.sh");
  await writeFile(script, await readFile(join(root, "packaging", "auto-update.sh")), { mode: 0o755 });
  await writeFile(join(dir, "release-source.sh"), await readFile(join(root, "packaging", "release-source.sh")), { mode: 0o644 });
  const app = join(dir, "opt");
  const home = join(dir, "home");
  const marker = join(dir, "updater-ran");
  await mkdir(join(app, "current", "packaging"), { recursive: true });
  await mkdir(join(home, ".my-claw"), { recursive: true });
  await writeFile(join(app, ".install-meta"), `USER=claw\nHOME=${home}\n`);
  await writeFile(join(app, "current", "package.json"), JSON.stringify({ version: "0.7.1" }));
  // No release source configured: past the lock, the script stops at "cannot check for updates".
  await writeFile(join(home, ".my-claw", ".env"), "");
  await writeFile(join(app, "current", "packaging", "update.sh"), `#!/bin/bash\ntouch ${marker}\n`, { mode: 0o755 });
  return { app, marker, script, home };
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
    expect(free.out).toContain("cannot check for updates");
  });

  test("a lock file nobody holds is no reason to skip", async () => {
    const { app, script } = await install();
    await writeFile(join(app, ".update.lock"), "");
    expect(tick(app, script).out).toContain("cannot check for updates");
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

describe("a tick with a release key", () => {
  const KEY = "dlh_timer-key";
  const seen: Array<string | null> = [];
  let latest = "0.7.2";
  const hub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      seen.push(req.headers.get("authorization"));
      if (req.headers.get("authorization") !== `Bearer ${KEY}`) return new Response("", { status: 401 });
      if (new URL(req.url).pathname === "/my-claw/server/latest.json") return Response.json({ version: latest, files: [] });
      return new Response("", { status: 404 });
    },
  });
  afterAll(() => hub.stop(true));

  /** Async: the fake hub answers from this process, which spawnSync would block. */
  async function tickAsync(app: string, script: string): Promise<string> {
    const run = Bun.spawn(
      AS_NOBODY
        ? ["setpriv", `--reuid=${UNPRIVILEGED.uid}`, `--regid=${UNPRIVILEGED.gid}`, "--clear-groups", "bash", script]
        : ["bash", script],
      { env: { ...process.env, MY_CLAW_APP_DIR: app, XDG_RUNTIME_DIR: "/nonexistent" }, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    return out + err;
  }

  test("asks the hub with the key and starts the updater on a newer release", async () => {
    const { app, script, home, marker } = await install();
    await writeFile(join(home, ".my-claw", ".env"), `MY_CLAW_RELEASE_URL=http://127.0.0.1:${hub.port}/my-claw/\nMY_CLAW_RELEASE_KEY=${KEY}\n`);
    seen.length = 0;
    latest = "0.7.2";
    const out = await tickAsync(app, script);
    expect(out).toContain(`checking http://127.0.0.1:${hub.port}/my-claw`);
    expect(out).toContain("0.7.2 available (installed 0.7.1)");
    expect(seen).toEqual([`Bearer ${KEY}`]);
    expect(out).toContain("installing 0.7.2...");
    expect(existsSync(marker)).toBe(true);
  });

  test("an install already on the latest release stays put", async () => {
    const { app, script, home, marker } = await install();
    await writeFile(join(home, ".my-claw", ".env"), `MY_CLAW_RELEASE_URL=http://127.0.0.1:${hub.port}/my-claw\nMY_CLAW_RELEASE_KEY=${KEY}\n`);
    latest = "0.7.1";
    expect(await tickAsync(app, script)).toContain("up to date (0.7.1)");
    expect(existsSync(marker)).toBe(false);
  });

  test("a forge token alone is no source any more: the tick says what to do and updates nothing", async () => {
    const { app, script, home, marker } = await install();
    await writeFile(join(home, ".my-claw", ".env"), `FORGEJO_URL=http://127.0.0.1:${hub.port}\nFORGEJO_TOKEN=forge-tok\n`);
    seen.length = 0;
    expect(await tickAsync(app, script)).toContain("run: myclaw release-key <key>");
    expect(seen).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  test("a refused key is a quiet retry, never an update", async () => {
    const { app, script, home, marker } = await install();
    await writeFile(join(home, ".my-claw", ".env"), `MY_CLAW_RELEASE_URL=http://127.0.0.1:${hub.port}/my-claw\nMY_CLAW_RELEASE_KEY=dlh_revoked\n`);
    expect(await tickAsync(app, script)).toContain("could not resolve the latest version");
    expect(existsSync(marker)).toBe(false);
  });
});
