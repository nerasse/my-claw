import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  applyHotReload,
  runReloadAppliers,
  type ConfigReloadContext,
} from "../src/core/config-watcher.ts";
import { ModelPicker } from "../src/channels/model-picker.ts";
import type { MyClawConfig } from "../src/core/config.ts";

function baseConfig(): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: ["spawn"],
    channels: {
      "my-claw-app": {
        port: 8080,
        streaming: { enabled: true, minChars: 20 },
      },
    },
    llm: {
      defaultProvider: "p",
      defaultModel: "model-a",
      providers: { p: { baseUrl: "https://api.example.com" } },
      models: [{ id: "model-a", label: "Model A", provider: "p" }],
      limit: { context: 1000, output: 100 },
    },
    agents: { orchestrator: { maxIterations: 90 } },
    webSearch: { baseUrl: "https://search.example.com", language: "en" },
    browser: { enabled: true, sidecarUrl: "http://127.0.0.1:9223", maxSteps: 20 },
    injection: { enabled: true, budgetBonus: 8 },
    memory: { enabled: true, recallMaxEntries: 5 },
  };
}

function clone(c: MyClawConfig): MyClawConfig {
  return JSON.parse(JSON.stringify(c)) as MyClawConfig;
}

// ── applyHotReload: hot object sections ──────────────────────────────────────

test("llm change is applied in place, preserving object identity", () => {
  const current = baseConfig();
  const llmRef = current.llm;
  const next = clone(current);
  next.llm.defaultModel = "model-b";
  next.llm.limit = { context: 2000, output: 200 };

  const result = applyHotReload(current, next);

  assert.ok(result.changed.includes("llm"));
  assert.equal(current.llm, llmRef, "llm reference must be preserved");
  assert.equal(current.llm.defaultModel, "model-b");
  assert.equal(current.llm.limit?.context, 2000);
  assert.deepEqual(result.rebootRequired, []);
});

test("a boot-resolved workspace is not reported as needing a reboot", () => {
  // Boot rewrites config.workspace to an absolute path while the file on disk usually omits
  // the key entirely, which used to flag a reboot on every reload.
  const current = baseConfig();
  current.workspace = `${process.env["MY_CLAW_DIR"]}/workspace`;
  const next = clone(current);
  delete next.workspace;

  const result = applyHotReload(current, next);

  assert.deepEqual(result.rebootRequired, [], "the effective path is unchanged");
});

test("a real workspace change still requires a reboot", () => {
  const current = baseConfig();
  current.workspace = `${process.env["MY_CLAW_DIR"]}/workspace`;
  const next = clone(current);
  next.workspace = "/somewhere/else";

  const result = applyHotReload(current, next);

  assert.ok(result.rebootRequired.includes("workspace"));
});

test("agents change is applied in place", () => {
  const current = baseConfig();
  const ref = current.agents;
  const next = clone(current);
  next.agents.orchestrator = { maxIterations: 120 };

  const result = applyHotReload(current, next);

  assert.ok(result.changed.includes("agents"));
  assert.equal(current.agents, ref);
  assert.equal(current.agents.orchestrator?.maxIterations, 120);
});

test("browser and injection changes are applied in place", () => {
  const current = baseConfig();
  const browserRef = current.browser;
  const next = clone(current);
  next.browser!.enabled = false;
  next.browser!.sidecarUrl = "http://10.0.0.1:9223";
  next.injection!.budgetBonus = 16;

  const result = applyHotReload(current, next);

  assert.ok(result.changed.includes("browser"));
  assert.ok(result.changed.includes("injection"));
  assert.equal(current.browser, browserRef);
  assert.equal(current.browser?.enabled, false);
  assert.equal(current.browser?.sidecarUrl, "http://10.0.0.1:9223");
  assert.equal(current.injection?.budgetBonus, 16);
});

test("webSearch change is applied in place", () => {
  const current = baseConfig();
  const ref = current.webSearch;
  const next = clone(current);
  next.webSearch!.baseUrl = "https://new.example.com";

  const result = applyHotReload(current, next);

  assert.ok(result.changed.includes("webSearch"));
  assert.equal(current.webSearch, ref);
  assert.equal(current.webSearch?.baseUrl, "https://new.example.com");
});

// ── applyHotReload: arrays ───────────────────────────────────────────────────

test("whitelist and blacklist are mutated in place, preserving array identity", () => {
  const current = baseConfig();
  const wlRef = current.whitelist;
  const blRef = current.blacklist;
  const next = clone(current);
  next.whitelist = ["u1", "u2"];
  next.blacklist = ["spawn", "memory"];

  const result = applyHotReload(current, next);

  assert.ok(result.changed.includes("whitelist"));
  assert.ok(result.changed.includes("blacklist"));
  assert.equal(current.whitelist, wlRef, "whitelist array reference must be preserved");
  assert.equal(current.blacklist, blRef, "blacklist array reference must be preserved");
  assert.deepEqual(current.whitelist, ["u1", "u2"]);
  assert.deepEqual(current.blacklist, ["spawn", "memory"]);
});

// ── applyHotReload: channels behavioral vs reboot ────────────────────────────

test("an app behavioral change is applied in place", () => {
  const current = baseConfig();
  const ref = current.channels["my-claw-app"];
  const next = clone(current);
  next.channels["my-claw-app"]!.streaming = { enabled: false, minChars: 5 };

  const result = applyHotReload(current, next);

  assert.ok(result.changed.includes("channels.my-claw-app"));
  assert.equal(current.channels["my-claw-app"], ref, "sub-config identity must be preserved");
  assert.equal(current.channels["my-claw-app"]?.streaming?.enabled, false);
  assert.deepEqual(result.rebootRequired, []);
});

test("the listen port is reboot-required and NOT applied", () => {
  const current = baseConfig();
  const next = clone(current);
  next.channels["my-claw-app"]!.port = 9090;

  const result = applyHotReload(current, next);

  assert.ok(result.rebootRequired.includes("channels.my-claw-app.port"));
  assert.equal(current.channels["my-claw-app"]?.port, 8080, "socket is bound at start");
});

test("a behavioral change applies even when a reboot field also changed", () => {
  const current = baseConfig();
  const next = clone(current);
  next.channels["my-claw-app"]!.streaming = { enabled: false }; // behavioral -> apply
  next.channels["my-claw-app"]!.port = 9090; // reboot -> skip

  const result = applyHotReload(current, next);

  assert.ok(result.changed.includes("channels.my-claw-app"));
  assert.ok(result.rebootRequired.includes("channels.my-claw-app.port"));
  assert.equal(current.channels["my-claw-app"]?.streaming?.enabled, false);
  assert.equal(current.channels["my-claw-app"]?.port, 8080);
});

test("removing a channel entirely is reboot-required", () => {
  const current = baseConfig();
  const next = clone(current);
  delete next.channels["my-claw-app"];

  const result = applyHotReload(current, next);

  assert.ok(result.rebootRequired.includes("channels.my-claw-app"));
  assert.ok(current.channels["my-claw-app"], "channel must not be removed live");
});

// ── applyHotReload: reboot-only top-level sections ───────────────────────────

test("memory change is now hot-applied in place (recall knobs read live)", () => {
  const current = baseConfig();
  const ref = current.memory;
  const next = clone(current);
  next.memory!.recallMaxEntries = 99;

  const result = applyHotReload(current, next);

  assert.ok(result.changed.includes("memory"));
  assert.ok(!result.rebootRequired.includes("memory"));
  assert.equal(current.memory, ref, "memory identity preserved for live reads");
  assert.equal(current.memory?.recallMaxEntries, 99);
});

test("no changes yields empty result", () => {
  const current = baseConfig();
  const next = clone(current);

  const result = applyHotReload(current, next);

  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.rebootRequired, []);
});

// ── runReloadAppliers ────────────────────────────────────────────────────────

test("llm applier refreshes the ModelPicker", () => {
  const config = baseConfig();
  config.llm.models = [
    { id: "model-a", label: "Model A" },
    { id: "model-b", label: "Model B" },
  ];
  const picker = new ModelPicker([]);
  assert.equal(picker.hasModels(), false);

  runReloadAppliers(["llm"], config, { modelPicker: picker });

  assert.equal(picker.hasModels(), true);
  assert.equal(picker.find("model-b")?.id, "model-b");
});

test("webSearch applier invokes registerWebSearch", () => {
  const config = baseConfig();
  let registered = 0;
  runReloadAppliers(["webSearch"], config, { registerWebSearch: () => { registered += 1; } });
  assert.equal(registered, 1);
});

test("mcp applier invokes syncMcp with the live config.mcp", () => {
  const config = baseConfig();
  config.mcp = { weather: { transport: "http", url: "https://example.com/mcp" } };
  let received: unknown;
  runReloadAppliers(["mcp"], config, { syncMcp: (mcp) => { received = mcp; } });
  assert.deepEqual(received, config.mcp);
});

// ── Block B: voice / cron / memory are now hot ───────────────────────────────

test("voice hot-reloads in place and is not reboot-only", () => {
  const current = baseConfig();
  current.voice = { mode: "auto" };
  const ref = current.voice;
  const next = baseConfig();
  next.voice = { mode: "cloud" };

  const result = applyHotReload(current, next);
  assert.ok(result.changed.includes("voice"));
  assert.ok(!result.rebootRequired.includes("voice"));
  assert.equal(current.voice, ref, "voice identity preserved for live reads");
  assert.equal(current.voice.mode, "cloud");
});

test("cron hot-reloads and drives the reloadCron applier", () => {
  const current = baseConfig();
  current.cron = { tickIntervalMs: 60_000 };
  const next = baseConfig();
  next.cron = { tickIntervalMs: 30_000 };

  const result = applyHotReload(current, next);
  assert.ok(result.changed.includes("cron"));
  assert.ok(!result.rebootRequired.includes("cron"));
  assert.equal(current.cron.tickIntervalMs, 30_000);

  let restarts = 0;
  runReloadAppliers(["cron"], current, { reloadCron: () => { restarts += 1; } });
  assert.equal(restarts, 1);
});

test("memory hot-reloads and drives the reloadMemory applier with live config.memory", () => {
  const current = baseConfig();
  current.memory = { enabled: true, recallMaxEntries: 5 };
  const next = baseConfig();
  next.memory = { enabled: true, recallMaxEntries: 9, embedding: { model: "new-model" } };

  const result = applyHotReload(current, next);
  assert.ok(result.changed.includes("memory"));
  assert.ok(!result.rebootRequired.includes("memory"));
  assert.equal(current.memory.recallMaxEntries, 9);

  let received: unknown;
  runReloadAppliers(["memory"], current, { reloadMemory: (m) => { received = m; } });
  assert.deepEqual(received, current.memory);
});

test("workspace remains the only reboot-only top-level section", () => {
  const current = baseConfig();
  const next = baseConfig();
  next.workspace = "/new/workspace/path";
  const result = applyHotReload(current, next);
  assert.ok(result.rebootRequired.includes("workspace"));
});

test("appliers are no-ops when nothing relevant changed", () => {
  const config = baseConfig();
  let touched = 0;
  const ctx: ConfigReloadContext = {
    modelPicker: {
      syncFromConfig: () => { touched += 1; },
    },
    registerWebSearch: () => { touched += 1; },
  };
  runReloadAppliers(["agents", "browser", "blacklist", "injection"], config, ctx);
  assert.equal(touched, 0);
});
