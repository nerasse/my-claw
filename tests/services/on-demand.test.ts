/**
 * Local Whisper runs while speech-to-text is local, and only then (docs/on-demand-services.md).
 * It used to be enabled and started by every update whatever the config said: 549 MB on a box
 * whose voice had been in the cloud for weeks, and a restart loop on one without faster-whisper.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR, loadEnv, resetEnvFileHotReload, type MyClawConfig } from "../../src/core/config.ts";
import { managesUnits, reconcileUnits, type Systemctl } from "../../src/services/on-demand.ts";

const WHISPER = "my-claw-whisper.service";

/** A user manager holding one unit, recording what it was told. */
function manager(state: { enabled: string; active: string }) {
  const calls: string[][] = [];
  const systemctl: Systemctl = async (args) => {
    calls.push(args);
    if (args[0] === "is-enabled") return { code: state.enabled === "enabled" ? 0 : 1, stdout: state.enabled };
    if (args[0] === "is-active") return { code: state.active === "active" ? 0 : 3, stdout: state.active };
    return { code: 0, stdout: "" };
  };
  const actions = () => calls.filter((c) => c[0] !== "is-enabled" && c[0] !== "is-active");
  return { systemctl, actions };
}

function voice(v: MyClawConfig["voice"]): MyClawConfig {
  return { voice: v } as MyClawConfig;
}

const savedGroq = process.env.GROQ_API_KEY;
beforeEach(() => {
  delete process.env.GROQ_API_KEY;
});
afterEach(() => {
  if (savedGroq === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = savedGroq;
});

describe("local Whisper follows the speech-to-text engine", () => {
  test("cloud speech stops a Whisper an update left running, and disables it", async () => {
    const m = manager({ enabled: "enabled", active: "active" });
    const changes = await reconcileUnits(voice({ stt: { mode: "cloud" } }), m.systemctl);
    expect(m.actions()).toEqual([["disable", "--now", WHISPER]]);
    expect(changes).toEqual([{ unit: WHISPER, action: "stopped" }]);
  });

  test("local speech starts it, enabled so a reboot brings it back", async () => {
    const m = manager({ enabled: "disabled", active: "inactive" });
    await reconcileUnits(voice({ stt: { mode: "local" } }), m.systemctl);
    expect(m.actions()).toEqual([["enable", "--now", WHISPER]]);
  });

  test("an older install on auto without a Groq key keeps the local engine it was using", async () => {
    const m = manager({ enabled: "enabled", active: "inactive" });
    await reconcileUnits(voice({ mode: "auto" }), m.systemctl);
    expect(m.actions()).toEqual([["enable", "--now", WHISPER]]);
  });

  test("auto with a Groq key is cloud: Whisper goes", async () => {
    process.env.GROQ_API_KEY = "gsk_real";
    const m = manager({ enabled: "enabled", active: "active" });
    await reconcileUnits(voice({ mode: "auto" }), m.systemctl);
    expect(m.actions()).toEqual([["disable", "--now", WHISPER]]);
  });

  test("a state that already matches is left alone, a restart loop included", async () => {
    const off = manager({ enabled: "disabled", active: "inactive" });
    await reconcileUnits(voice({ stt: { mode: "cloud" } }), off.systemctl);
    expect(off.actions()).toEqual([]);
    // Restarting a unit that crash-loops would only reset its back-off.
    const looping = manager({ enabled: "enabled", active: "activating" });
    await reconcileUnits(voice({ stt: { mode: "local" } }), looping.systemctl);
    expect(looping.actions()).toEqual([]);
  });

  test("a box without the unit is not asked to start it", async () => {
    const m = manager({ enabled: "", active: "inactive" });
    await reconcileUnits(voice({ stt: { mode: "local" } }), m.systemctl);
    expect(m.actions()).toEqual([]);
  });

  test("only the installed server manages the units, never a dev one on the same box", () => {
    expect(managesUnits({ MY_CLAW_MANAGES_UNITS: "1" })).toBe(true);
    expect(managesUnits({})).toBe(false);
  });
});

describe("the shipped files", () => {
  const root = join(import.meta.dir, "..", "..");
  const read = (path: string) => readFile(join(root, path), "utf8");
  const listVar = (script: string, name: string) =>
    (new RegExp(`^\\s*${name}="([^"]*)"`, "m").exec(script)?.[1] ?? "").split(/\s+/).filter(Boolean);

  test("no script enables or starts Whisper; the installed server is told it owns it", async () => {
    const update = await read("packaging/update.sh");
    expect(listVar(update, "START_ORDER")).not.toContain("my-claw-whisper");
    expect(listVar(update, "ON_DEMAND_UNITS")).toEqual([WHISPER]);
    const render = update.slice(update.indexOf("render_units() {"), update.indexOf("start_services() {"));
    expect(render).toContain('case " ${ON_DEMAND_UNITS} " in *" ${name} "*) continue ;; esac');
    const cli = await read("scripts/myclaw.sh");
    expect(listVar(cli, "START_ORDER")).not.toContain("my-claw-whisper");
    expect(listVar(cli, "DEPS")).not.toContain("my-claw-whisper");
    expect(listVar(await read("scripts/dev.sh"), "DEPS")).not.toContain("my-claw-whisper");
    expect(await read("packaging/units/my-claw.service")).toContain('Environment="MY_CLAW_MANAGES_UNITS=1"');
  });

  test("the .env template sets no fake key, and the config template no 30 min cron wall", async () => {
    const env = await read("packaging/.env.example");
    expect(env).not.toMatch(/^[A-Z_]+=your_/m);
    const config = JSON.parse(await read("packaging/config.json")) as { cron: Record<string, unknown>; voice: { stt: { mode: string } } };
    expect(config.cron["timeoutMs"]).toBeUndefined();
    // A fresh install is cloud: nothing local runs until it is asked for.
    expect(config.voice.stt.mode).toBe("cloud");
  });
});

describe("a placeholder left in .env by the old template is not a key", () => {
  const path = join(MY_CLAW_DIR, ".env");
  let saved: string | null = null;
  beforeEach(async () => {
    saved = await readFile(path, "utf8").catch(() => null);
    resetEnvFileHotReload();
  });
  afterEach(async () => {
    delete process.env.MY_CLAW_TEST_PLACEHOLDER;
    delete process.env.MY_CLAW_TEST_REAL;
    if (saved === null) await rm(path, { force: true });
    else await writeFile(path, saved);
    resetEnvFileHotReload();
  });

  test("your_..._here is skipped, a real value is read", async () => {
    await writeFile(path, "MY_CLAW_TEST_PLACEHOLDER=your_groq_key_here\nMY_CLAW_TEST_REAL=gsk_abc\n");
    await loadEnv(true);
    expect(process.env.MY_CLAW_TEST_PLACEHOLDER).toBeUndefined();
    expect(process.env.MY_CLAW_TEST_REAL).toBe("gsk_abc");
  });
});
