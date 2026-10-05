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
import { TRANSFORMERS_VERSION, TransformersRuntime, WHISPER_PACKAGES, WhisperRuntime, diskBytes, type Run } from "../../src/services/local-engines.ts";
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

describe("transformers.js for local embeddings, out of the release", () => {
  /** An app root with a package.json, and nothing that resolves the package. */
  async function bareApp(overrides: Record<string, string> = { protobufjs: "^7.6.6" }): Promise<{ app: string; dir: string }> {
    const root = await mkdtemp(join(tmpdir(), "t-"));
    const app = join(root, "app");
    await mkdir(app);
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "my-claw", overrides }));
    return { app, dir: join(root, "runtime", "transformers") };
  }

  /** `bun add` as a fake: writes a package that resolves, unless told to leave nothing behind. */
  function bunAdd(leaves: boolean) {
    const calls: string[][] = [];
    const run: Run = async (cmd) => {
      calls.push(cmd);
      const dir = cmd[cmd.indexOf("--cwd") + 1]!;
      if (leaves) {
        const pkg = join(dir, "node_modules", "@huggingface", "transformers");
        await mkdir(pkg, { recursive: true });
        await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@huggingface/transformers", main: "index.js" }));
        await writeFile(join(pkg, "index.js"), "export const env = {};\n");
      }
      return { code: 0, output: "" };
    };
    return { run, calls };
  }

  async function settledT(runtime: TransformersRuntime): Promise<void> {
    while (runtime.status().state === "installing") await new Promise((r) => setTimeout(r, 1));
  }

  test("a checkout resolves its devDependency: ready, nothing installed", async () => {
    const sh = bunAdd(true);
    const runtime = new TransformersRuntime(sh.run, join(await mkdtemp(join(tmpdir(), "t-")), "transformers"));
    expect(await runtime.prepare()).toBe(true);
    expect(sh.calls).toEqual([]);
    expect(runtime.entry()).toContain(join("node_modules", "@huggingface", "transformers"));
  });

  test("a release without it installs it once, pinned, with the release's overrides, then resolves it there", async () => {
    const { app, dir } = await bareApp();
    const sh = bunAdd(true);
    const runtime = new TransformersRuntime(sh.run, dir, app);
    const changes: string[] = [];
    runtime.onChange(() => changes.push(runtime.status().state));
    expect(runtime.entry()).toBeUndefined();
    expect(await runtime.prepare()).toBe(false);
    expect(await runtime.prepare()).toBe(false);
    await settledT(runtime);
    expect(changes).toEqual(["installing", "ready"]);
    expect(sh.calls).toEqual([[process.execPath, "add", "--cwd", dir, `@huggingface/transformers@${TRANSFORMERS_VERSION}`]]);
    expect(await Bun.file(join(dir, "package.json")).json()).toMatchObject({ overrides: { protobufjs: "^7.6.6" } });
    expect(runtime.entry()).toBe(join(dir, "node_modules", "@huggingface", "transformers", "index.js"));
  });

  test("what the package requires next to it resolves after an install the process looked for first", async () => {
    // Bun's resolver remembers a node_modules it found missing: asked about the directory before
    // the install, the package then loaded and failed on its first require (onnxruntime-common,
    // install test on Debian 12, 2026-10-05).
    const { app, dir } = await bareApp();
    const run: Run = async () => {
      const modules = join(dir, "node_modules");
      await mkdir(join(modules, "@huggingface", "transformers"), { recursive: true });
      await mkdir(join(modules, "sibling-dep"), { recursive: true });
      await writeFile(join(modules, "sibling-dep", "package.json"), JSON.stringify({ name: "sibling-dep", main: "index.js" }));
      await writeFile(join(modules, "sibling-dep", "index.js"), "module.exports = { answer: 42 };\n");
      await writeFile(join(modules, "@huggingface", "transformers", "package.json"), JSON.stringify({ name: "@huggingface/transformers", main: "index.js" }));
      await writeFile(join(modules, "@huggingface", "transformers", "index.js"), "module.exports = { answer: require('sibling-dep').answer };\n");
      return { code: 0, output: "" };
    };
    const runtime = new TransformersRuntime(run, dir, app);
    await runtime.prepare();
    await settledT(runtime);
    const loaded = (await import(runtime.entry()!)) as { answer: number };
    expect(loaded.answer).toBe(42);
  });

  test("an install that leaves nothing importable is a failure that says so", async () => {
    const { app, dir } = await bareApp();
    const runtime = new TransformersRuntime(bunAdd(false).run, dir, app);
    await runtime.prepare();
    await settledT(runtime);
    expect(runtime.status()).toEqual({ state: "failed", error: "installed, but the package does not resolve" });
  });

  test("freeing removes the package as well as the models", async () => {
    const { app, dir } = await bareApp();
    const runtime = new TransformersRuntime(bunAdd(true).run, dir, app);
    await runtime.prepare();
    await settledT(runtime);
    await runtime.free();
    expect(existsSync(dir)).toBe(false);
    expect(runtime.status()).toEqual({ state: "idle" });
    expect(runtime.paths()).toContain(dir);
  });

  test("the version installed is the one the repository typechecks against", async () => {
    const dev = (await Bun.file(join(import.meta.dir, "..", "..", "node_modules", "@huggingface", "transformers", "package.json")).json()) as { version: string };
    expect(dev.version).toBe(TRANSFORMERS_VERSION);
  });
});
