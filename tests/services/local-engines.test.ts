/**
 * Local engines are downloaded once switched on, never at install, and can be freed
 * (docs/services.md, "Local engines").
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MyClawConfig } from "../../src/core/config.ts";
import { WHISPER_PACKAGES, WhisperRuntime, diskBytes, type Run } from "../../src/services/local-engines.ts";
import { reconcileUnits, type OnDemandUnit, type Systemctl } from "../../src/services/on-demand.ts";

/** A shell where `python3 -c import faster_whisper` answers `systemHas`, and every install succeeds unless told. */
function shell(systemHas: boolean, failOn?: string) {
  const calls: string[][] = [];
  const run: Run = async (cmd) => {
    calls.push(cmd);
    if (cmd[1] === "-c") return { code: cmd[0] === "python3" && systemHas ? 0 : 1, output: "" };
    if (failOn && cmd.includes(failOn)) return { code: 1, output: "line one\nE: No matching distribution" };
    return { code: 0, output: "" };
  };
  return { run, calls };
}

async function settled(runtime: WhisperRuntime): Promise<void> {
  while (runtime.status().state === "installing") await new Promise((r) => setTimeout(r, 1));
}

describe("faster-whisper for the bare-metal unit", () => {
  test("a system that already has it (set up by hand) is ready, and nothing is installed", async () => {
    const sh = shell(true);
    const runtime = new WhisperRuntime(sh.run, join(await mkdtemp(join(tmpdir(), "w-")), "venv"));
    expect(await runtime.prepare()).toBe(true);
    expect(sh.calls.some((c) => c.includes("venv") || c.includes("install"))).toBe(false);
  });

  test("otherwise the first ask installs it into its venv, pinned, and says ready when done", async () => {
    const sh = shell(false);
    const venv = join(await mkdtemp(join(tmpdir(), "w-")), "venv");
    const runtime = new WhisperRuntime(sh.run, venv);
    const changes: string[] = [];
    runtime.onChange(() => changes.push(runtime.status().state));
    expect(await runtime.prepare()).toBe(false);
    // A second ask during the install starts nothing more.
    expect(await runtime.prepare()).toBe(false);
    await settled(runtime);
    expect(changes).toEqual(["installing", "ready"]);
    expect(sh.calls).toContainEqual(["python3", "-m", "venv", venv]);
    expect(sh.calls).toContainEqual([join(venv, "bin", "python"), "-m", "pip", "install", "--quiet", ...WHISPER_PACKAGES]);
    expect(sh.calls.filter((c) => c.includes("install"))).toHaveLength(1);
    expect(await runtime.prepare()).toBe(true);
  });

  test("a failed install says what failed, and the unit stays off", async () => {
    const sh = shell(false, "--quiet");
    const runtime = new WhisperRuntime(sh.run, join(await mkdtemp(join(tmpdir(), "w-")), "venv"));
    await runtime.prepare();
    await settled(runtime);
    expect(runtime.status()).toEqual({ state: "failed", error: "pip install failed: line one E: No matching distribution" });
  });

  test("free removes the venv and goes back to idle", async () => {
    const venv = join(await mkdtemp(join(tmpdir(), "w-")), "venv");
    await mkdir(join(venv, "bin"), { recursive: true });
    await writeFile(join(venv, "bin", "python"), "x".repeat(4096));
    const runtime = new WhisperRuntime(shell(true).run, venv);
    expect(await diskBytes([venv])).toBeGreaterThan(4000);
    await runtime.free();
    expect(existsSync(venv)).toBe(false);
    expect(runtime.status()).toEqual({ state: "idle" });
  });
});

test("a needed unit whose engine is not there yet is left off: no restart loop", async () => {
  const actions: string[][] = [];
  const systemctl: Systemctl = async (args) => {
    if (args[0] === "is-enabled") return { code: 1, stdout: "disabled" };
    if (args[0] === "is-active") return { code: 3, stdout: "inactive" };
    actions.push(args);
    return { code: 0, stdout: "" };
  };
  let ready = false;
  const unit: OnDemandUnit = { unit: "x.service", serves: "x", needed: () => true, ready: async () => ready };
  await reconcileUnits({} as MyClawConfig, systemctl, [unit]);
  expect(actions).toEqual([]);
  ready = true;
  await reconcileUnits({} as MyClawConfig, systemctl, [unit]);
  expect(actions).toEqual([["enable", "--now", "x.service"]]);
});
