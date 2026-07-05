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
      telegram: {
        token: "tok-123",
        mode: "polling",
        historyLimit: 10,
        errorPolicy: "always",
        reactions: { enabled: true, received: "👀" },
      },
      matrix: {
        homeserver: "https://m.example.com",
        accessToken: "secret",
        deviceId: "DEV1",
        encryption: true,
        historyLimit: 10,
        errorPolicy: "always",
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

test("telegram behavioral change is applied in place", () => {
  const current = baseConfig();
  const ref = current.channels.telegram;
  const next = clone(current);
  next.channels.telegram!.historyLimit = 50;
  next.channels.telegram!.errorPolicy = "once";

  const result = applyHotReload(current, next);

  assert.ok(result.changed.includes("channels.telegram"));
  assert.equal(current.channels.telegram, ref, "telegram sub-config identity must be preserved");
  assert.equal(current.channels.telegram?.historyLimit, 50);
  assert.equal(current.channels.telegram?.errorPolicy, "once");
  assert.deepEqual(result.rebootRequired, []);
});

test("telegram token change is reboot-required and NOT applied", () => {
  const current = baseConfig();
  const next = clone(current);
  next.channels.telegram!.token = "new-token";

  const result = applyHotReload(current, next);

  assert.ok(result.rebootRequired.includes("channels.telegram.token"));
  assert.ok(!result.changed.includes("channels.telegram"));
  assert.equal(current.channels.telegram?.token, "tok-123", "token must remain unchanged until reboot");
});

test("matrix crypto/identity changes are reboot-required and NOT applied", () => {
  const current = baseConfig();
  const next = clone(current);
  next.channels.matrix!.accessToken = "rotated";
  next.channels.matrix!.deviceId = "DEV2";

  const result = applyHotReload(current, next);

  assert.ok(result.rebootRequired.includes("channels.matrix.accessToken"));
  assert.ok(result.rebootRequired.includes("channels.matrix.deviceId"));
  assert.equal(current.channels.matrix?.accessToken, "secret");
  assert.equal(current.channels.matrix?.deviceId, "DEV1");
});

test("matrix behavioral change applies even when an identity field also changed", () => {
  const current = baseConfig();
  const next = clone(current);
  next.channels.matrix!.historyLimit = 99; // behavioral -> apply
  next.channels.matrix!.accessToken = "rotated"; // reboot -> skip

  const result = applyHotReload(current, next);

  assert.ok(result.changed.includes("channels.matrix"));
  assert.ok(result.rebootRequired.includes("channels.matrix.accessToken"));
  assert.equal(current.channels.matrix?.historyLimit, 99);
  assert.equal(current.channels.matrix?.accessToken, "secret");
});

test("removing a channel entirely is reboot-required", () => {
  const current = baseConfig();
  const next = clone(current);
  delete next.channels.telegram;

  const result = applyHotReload(current, next);

  assert.ok(result.rebootRequired.includes("channels.telegram"));
  assert.ok(current.channels.telegram, "channel must not be removed live");
});

// ── applyHotReload: reboot-only top-level sections ───────────────────────────

test("memory change is reboot-required and NOT applied", () => {
  const current = baseConfig();
  const next = clone(current);
  next.memory!.recallMaxEntries = 99;

  const result = applyHotReload(current, next);

  assert.ok(result.rebootRequired.includes("memory"));
  assert.ok(!result.changed.includes("memory"));
  assert.equal(current.memory?.recallMaxEntries, 5);
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

test("whitelist applier rebuilds adapter whitelists with matrix normalization", () => {
  const config = baseConfig();
  config.whitelist = ["@User:HS", "u2"];

  let tgSet: Set<string> | undefined;
  let mxSet: Set<string> | undefined;
  const tg = { setWhitelist: (s: Set<string>) => { tgSet = s; }, applyConfigReload: () => {} };
  const mx = { setWhitelist: (s: Set<string>) => { mxSet = s; }, applyConfigReload: () => {} };

  const ctx: ConfigReloadContext = {
    getTelegram: () => tg,
    getMatrix: () => mx,
    normalizeMatrixUserId: (id) => id.toLowerCase(),
  };

  runReloadAppliers(["whitelist"], config, ctx);

  assert.deepEqual([...tgSet!].sort(), ["@User:HS", "u2"].sort());
  assert.ok(mxSet!.has("@user:hs"), "matrix whitelist should be normalized to lowercase");
});

test("channel appliers call applyConfigReload only for changed channels", () => {
  const config = baseConfig();
  let tgCalls = 0;
  let mxCalls = 0;
  const tg = { setWhitelist: () => {}, applyConfigReload: () => { tgCalls += 1; } };
  const mx = { setWhitelist: () => {}, applyConfigReload: () => { mxCalls += 1; } };
  const ctx: ConfigReloadContext = { getTelegram: () => tg, getMatrix: () => mx };

  runReloadAppliers(["channels.telegram"], config, ctx);
  assert.equal(tgCalls, 1);
  assert.equal(mxCalls, 0);

  runReloadAppliers(["channels.matrix"], config, ctx);
  assert.equal(mxCalls, 1);
});

test("webSearch applier invokes registerWebSearch", () => {
  const config = baseConfig();
  let registered = 0;
  runReloadAppliers(["webSearch"], config, { registerWebSearch: () => { registered += 1; } });
  assert.equal(registered, 1);
});

test("appliers are no-ops when nothing relevant changed", () => {
  const config = baseConfig();
  let touched = 0;
  const ctx: ConfigReloadContext = {
    modelPicker: { setModels: () => { touched += 1; } },
    registerWebSearch: () => { touched += 1; },
  };
  runReloadAppliers(["agents", "browser", "blacklist", "injection"], config, ctx);
  assert.equal(touched, 0);
});
