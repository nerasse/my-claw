/**
 * The browser holds the owner's work, so nothing but an explicit request restarts it
 * (docs/browser.md). Two restarts on the night of 2026-09-26 killed two applications stopped at
 * their e-mail code screen. These read the scripts as shipped: a regression here is one line of
 * shell, and nothing else would catch it before it cost a form.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (path: string) => readFile(join(root, path), "utf8");

function listVar(script: string, name: string): string[] {
  const match = new RegExp(`^${name}="([^"]*)"`, "m").exec(script);
  if (!match) throw new Error(`${name} not found`);
  return match[1]!.split(/\s+/).filter(Boolean);
}

describe("an update or a restart leaves the browser running", () => {
  test("update.sh stops Chromium only with --with-browser", async () => {
    const script = await read("packaging/update.sh");
    expect(listVar(script, "STOP_ORDER")).not.toContain("my-claw-chromium");
    expect(listVar(script, "STOP_ORDER")).toContain("my-claw");
    // Starting an active unit is a no-op, so Chromium stays in the start order: a browser that was
    // down comes back with the rest.
    expect(listVar(script, "START_ORDER")).toContain("my-claw-chromium");
    expect(script).toContain("--with-browser) WITH_BROWSER=1 ;;");
  });

  test("myclaw stop and restart keep Chromium and the display it draws on", async () => {
    const script = await read("scripts/myclaw.sh");
    const stop = listVar(script, "STOP_ORDER");
    // Chromium requires Xvfb: stopping the display takes the browser with it.
    expect(stop).not.toContain("my-claw-chromium");
    expect(stop).not.toContain("my-claw-xvfb");
    expect(listVar(script, "BROWSER_ORDER")).toEqual(["my-claw-chromium", "my-claw-xvfb"]);
  });

  test("myclaw start no longer kills a Chromium its unit is running", async () => {
    const script = await read("scripts/myclaw.sh");
    const kill = script.slice(script.indexOf("kill_stale() {"), script.indexOf("start_services() {"));
    expect(kill).toContain('is-active --quiet my-claw-chromium.service');
  });
});

describe("a browser that does go down comes back with its tabs", () => {
  test("the unit names the profile it always used and restores the last session", async () => {
    const unit = await read("packaging/units/my-claw-chromium.service");
    const exec = unit.split("\n").find((l) => l.startsWith("ExecStart="))!;
    expect(exec).toContain("--user-data-dir={{HOME}}/.config/chromium");
    expect(exec).toContain("--restore-last-session");
    // A start URL would open beside the restored tabs.
    expect(exec).not.toContain("about:blank");
    expect(unit).toContain("ExecStartPre=-/bin/sh {{APP_DIR}}/packaging/chromium-prestart.sh {{HOME}}/.config/chromium");
  });

  test("every file a unit runs from the tree is in the tarball", async () => {
    const tar = await read("packaging/build-tar.sh");
    const units = ["my-claw-chromium.service", "my-claw-auto-update.service", "my-claw-whisper.service"];
    for (const name of units) {
      const unit = await read(`packaging/units/${name}`);
      for (const match of unit.matchAll(/\{\{APP_DIR\}\}\/packaging\/([A-Za-z0-9_.-]+)/g)) {
        expect(tar).toContain(`"\${SCRIPT_DIR}/${match[1]}"`);
      }
    }
  });

  test("the pre-start marks a hard-stopped profile clean, so the restore happens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prestart-"));
    await mkdir(join(dir, "Default"), { recursive: true });
    const prefs = join(dir, "Default", "Preferences");
    await writeFile(prefs, JSON.stringify({ profile: { exit_type: "Crashed", name: "x" } }));
    // A unit that does not exist and a port nothing listens on: the test cannot reach the
    // machine's real browser, whatever runs on it.
    const run = Bun.spawnSync(["sh", join(root, "packaging/chromium-prestart.sh"), dir], {
      env: { ...process.env, MY_CLAW_CHROMIUM_UNIT: "my-claw-test-absent.service", MY_CLAW_CDP_PORT: "65531" },
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(await readFile(prefs, "utf8")).profile.exit_type).toBe("Normal");
  });

  test("a profile that does not exist yet is fine", () => {
    const run = Bun.spawnSync(["sh", join(root, "packaging/chromium-prestart.sh"), join(tmpdir(), "no-such-profile")], {
      env: { ...process.env, MY_CLAW_CHROMIUM_UNIT: "my-claw-test-absent.service", MY_CLAW_CDP_PORT: "65531" },
    });
    expect(run.exitCode).toBe(0);
  });
});
