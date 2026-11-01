/**
 * The wall predicate is attached for every caller, not only the agent loop.
 *
 * The summarizer and memory consolidation call `llmCompleteStream` directly. They are exactly the
 * calls that run while a plan is already spent, and without the predicate each transport gave a
 * wall its three attempts.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { wallConfig } from "../../src/llm/quota/wall.ts";
import { resetQuotaCache } from "../../src/llm/quota/index.ts";
import type { MyClawConfig, ResolvedLlmConfig } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

function config(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: { providers: { synthetic: { baseUrl: "https://api.synthetic.new/openai/v1", apiKeyEnv: "SYNTHETIC_KEY_FOR_TEST" } } },
    agents: {}, memory: { enabled: false },
  };
}

function resolved(): ResolvedLlmConfig {
  return { provider: "synthetic", model: "synthetic/m", baseUrl: "https://api.synthetic.new/openai/v1" } as ResolvedLlmConfig;
}

test("a caller that never attached a predicate gets one", async () => {
  process.env["SYNTHETIC_KEY_FOR_TEST"] = "sk-test";
  resetQuotaCache();
  const mock = mockFetch(async (input) => {
    if (String(input).includes("/v2/quotas")) {
      return new Response(JSON.stringify({ planWeeklyLimit: { percentRemaining: 0, nextRegenAt: "2026-11-04T09:43:54.000Z", nextRegenPercent: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected ${input}`);
  });
  try {
    const walled = wallConfig(config(), resolved());
    assert.ok(walled.isWall, "a provider with a usage source always gets the predicate");
    const err = Object.assign(new Error("HTTP 429"), { status: 429 });
    assert.equal(await walled.isWall!(err), true, "a full bar is a wall, read now");
  } finally {
    delete process.env["SYNTHETIC_KEY_FOR_TEST"];
    resetQuotaCache();
    mock.restore();
  }
});

test("a provider that publishes nothing keeps no predicate, and the 429 is not a wall", () => {
  const cfg: MyClawConfig = {
    whitelist: [], blacklist: [], channels: {},
    llm: { providers: { local: { baseUrl: "https://local.test/v1" } } },
    agents: {}, memory: { enabled: false },
  };
  const walled = wallConfig(cfg, { provider: "local", model: "local/m", baseUrl: "https://local.test/v1" } as ResolvedLlmConfig);
  assert.equal(walled.isWall, undefined, "no source, no probe, and the transport keeps its own backoff");
});

test("a predicate already on the config is never replaced", async () => {
  const own = async (): Promise<boolean> => "mine" === "mine";
  const cfg = config();
  const walled = wallConfig(cfg, { ...resolved(), isWall: own });
  assert.equal(walled.isWall, own);
});
