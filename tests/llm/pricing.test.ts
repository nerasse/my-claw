import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { ModelPricing, modelKeyCandidates, CACHE_VERSION, isSelfHosted } from "../../src/llm/pricing.ts";
import { openRouterEndpoints, clearOpenRouterCache } from "../../src/llm/openrouter-endpoints.ts";

/**
 * The price table is written to disk rather than fetched, so these tests exercise the resolution
 * ladder and never touch the network.
 */
function withTable(): ModelPricing {
  mkdirSync(MY_CLAW_DIR, { recursive: true });
  const table = {
    version: CACHE_VERSION,
    fetchedAt: new Date().toISOString(),
    hosts: {
      "fireworks-ai": "https://api.fireworks.ai/inference/v1/",
      xiaomi: "https://api.xiaomimimo.com/v1",
      "xiaomi-token-plan-ams": "https://token-plan-ams.xiaomimimo.com/v1",
      openrouter: "https://openrouter.ai/api/v1",
    },
    models: {
      anthropic: {
        // `output` is the reply limit, as models.dev publishes it: it is what makes the entry
        // describe the model rather than only price it.
        "claude-opus-5": { cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, id: "claude-opus-5", output: 128_000 },
        "claude-opus-48": { cost: { input: 5, output: 25, cacheRead: 0.5 }, id: "claude-opus-4-8" },
        "claude-opus-4-8": { cost: { input: 5, output: 25, cacheRead: 0.5 }, id: "claude-opus-4-8" },
        "claude-opus-41": { cost: { input: 15, output: 75 }, id: "claude-opus-4-1" },
        "claude-opus-4-1": { cost: { input: 15, output: 75 }, id: "claude-opus-4-1" },
      },
      openai: { "gpt-5.6-luna": { cost: { input: 0.2, output: 1.2, cacheRead: 0.02 }, id: "gpt-5.6-luna" } },
      "fireworks-ai": { "kimi-k26-turbo": { cost: { input: 2, output: 8, cacheRead: 0.3 }, id: "kimi-k2.6-turbo" } },
      // A flat token plan: real tariff of zero, which must never be reported as a cost.
      "xiaomi-token-plan-ams": { "mimo-v25-pro": { cost: { input: 0, output: 0, cacheRead: 0 }, id: "mimo-v2.5-pro" } },
      xiaomi: { "mimo-v25-pro": { cost: { input: 0.435, output: 0.87, cacheRead: 0.0036 }, id: "mimo-v2.5-pro" } },
      openrouter: { "mimo-v25-pro": { cost: { input: 0.5, output: 1 }, id: "mimo-v2.5-pro" } },
      somereseller: { "mimo-v25-pro": { cost: { input: 0.4, output: 0.8 }, id: "mimo-v2.5-pro" } },
      // Sold once for money and twice as a prepaid plan. Counting the plans would drag the median
      // to zero, which is the failure the median rule exists to avoid.
      paidonce: { "planned-model": { cost: { input: 3, output: 6 }, id: "planned-model" } },
      "plan-a": { "planned-model": { cost: { input: 0, output: 0 }, id: "planned-model" } },
      "plan-b": { "planned-model": { cost: { input: 0, output: 0 }, id: "planned-model" } },
    },
  };
  writeFileSync(join(MY_CLAW_DIR, "model-pricing.json"), JSON.stringify(table));
  return new ModelPricing(
    () => ({ litellm: { baseUrl: "https://proxy.example.com/v1", pricingProvider: "xiaomi" } }),
    () => [
      { id: "opus", group: "Claude/Opus" },
      { id: "claude-opus-5", group: "Claude/Opus", limit: { context: 1_000_000 } },
      { id: "claude-opus-4-8", group: "Claude/Opus", limit: { context: 1_000_000 } },
      { id: "claude-opus-4-1", group: "Claude/Opus", limit: { context: 200_000 } },
    ],
  );
}

const base = { promptTokens: 1_000_000, completionTokens: 0 };

test("the engine names the vendor, and a subscription is never reported as a charge", () => {
  const p = withTable();
  const opus = p.costOf({ ...base, model: "claude-opus-5", baseUrl: "claude-sdk" });
  expect(opus?.usd).toBeCloseTo(5, 6);
  expect(opus?.billed).toBe(false);
  expect(opus?.source).toContain("anthropic");

  const codex = p.costOf({ ...base, model: "gpt-5.6-luna", baseUrl: "https://chatgpt.com/backend-api" });
  expect(codex?.usd).toBeCloseTo(0.2, 6);
  expect(codex?.billed).toBe(false);
});

test("the native Anthropic endpoint prices from Anthropic, not from a median", () => {
  const p = withTable();
  // models.dev lists no api base for the `anthropic` provider, so without the engine entry this
  // resolves to nothing and falls to the median rung.
  const r = p.costOf({ ...base, model: "claude-opus-5", baseUrl: "https://api.anthropic.com" });
  expect(r?.usd).toBeCloseTo(5, 6);
  expect(r?.billed).toBe(false);
  expect(r?.source).toBe("engine anthropic");
});

test("the native Anthropic endpoint fills a capability gap from the table", () => {
  const p = withTable();
  const meta = p.metadataOf("claude-opus-5", "https://api.anthropic.com");
  expect(meta?.source).toBe("engine anthropic");
  expect(meta?.outputLimit).toBe(128_000);
});

test("a direct vendor resolves by host and is billed", () => {
  const p = withTable();
  const r = p.costOf({ ...base, model: "accounts/fireworks/routers/kimi-k2p6-turbo", baseUrl: "https://api.fireworks.ai/inference/v1" });
  expect(r?.usd).toBeCloseTo(2, 6);
  expect(r?.billed).toBe(true);
  expect(r?.source).toContain("fireworks-ai");
});

test("a flat plan climbs to its vendor instead of reporting zero", () => {
  const p = withTable();
  const r = p.costOf({
    ...base,
    model: "mimo-v2.5-pro",
    baseUrl: "https://litellm.internal/v1",
    upstreamApiBase: "https://token-plan-ams.xiaomimimo.com/v1",
  });
  // 0.435 is the vendor price, not the plan's 0.
  expect(r?.usd).toBeCloseTo(0.435, 6);
  // Not a charge: the plan is prepaid.
  expect(r?.billed).toBe(false);
  expect(r?.source).toContain("xiaomi-token-plan-ams");
  expect(r?.source).toContain("xiaomi");
});

test("the proxy's own figure wins, and a zero from it is not trusted", () => {
  const p = withTable();
  const withCost = p.costOf({ ...base, model: "mimo-v2.5-pro", baseUrl: "https://litellm.internal/v1", proxyCostUsd: 0.42 });
  expect(withCost?.usd).toBe(0.42);
  expect(withCost?.billed).toBe(true);
  expect(withCost?.source).toBe("proxy");

  // 0.0 means both "free" and "no price configured", so it must fall through rather than answer.
  const withZero = p.costOf({ ...base, model: "mimo-v2.5-pro", baseUrl: "https://litellm.internal/v1", proxyCostUsd: 0 });
  expect(withZero?.source).not.toBe("proxy");
  expect(withZero?.usd).toBeGreaterThan(0);
});

test("a declared pricingProvider resolves an endpoint the table cannot", () => {
  const p = withTable();
  const r = p.costOf({ ...base, model: "mimo-v2.5-pro", baseUrl: "https://proxy.example.com/v1" });
  expect(r?.usd).toBeCloseTo(0.435, 6);
  expect(r?.billed).toBe(true);
  expect(r?.source).toContain("declared");
});

test("the median is the last rung, and it is never billed", () => {
  const p = withTable();
  const r = p.costOf({ ...base, model: "mimo-v2.5-pro", baseUrl: "https://unknown.example/v1" });
  expect(r?.source).toContain("median");
  // A market median is not what this deployment pays, so it is never billed and always flagged.
  expect(r?.billed).toBe(false);
  expect(r?.approximate).toBe(true);
});

test("the median ignores prepaid plans, which would otherwise drag it to zero", () => {
  const p = withTable();
  const r = p.costOf({ ...base, model: "planned-model", baseUrl: "https://unknown.example/v1" });
  // Two of the three offers are 0; including them puts the median at 0 and reports a free call.
  expect(r?.usd).toBeCloseTo(3, 6);
});

test("an alias prices as the newest concrete model in its group", () => {
  const p = withTable();
  const alias = p.costOf({ ...base, model: "opus", baseUrl: "claude-sdk" });
  const concrete = p.costOf({ ...base, model: "claude-opus-5", baseUrl: "claude-sdk" });
  expect(alias?.usd).toBeCloseTo(concrete!.usd, 6);
  // Picking the oldest sibling instead would give 15 rather than 5.
  expect(alias?.usd).toBeCloseTo(5, 6);
  expect(alias?.approximate).toBe(true);
});

test("version separators converge: 4-8, 4.8, 4p8 and 48 reach the same price", () => {
  const p = withTable();
  const prices = ["claude-opus-4-8", "claude-opus-4.8", "claude-opus-4p8", "claude-opus-48"].map(
    (m) => p.costOf({ ...base, model: m, baseUrl: "claude-sdk" })?.usd,
  );
  for (const price of prices) expect(price).toBeCloseTo(5, 6);
});

test("cache reads are billed at the cache rate, which dominates the total", () => {
  const p = withTable();
  const fresh = p.costOf({ model: "claude-opus-5", baseUrl: "claude-sdk", promptTokens: 1_000_000, completionTokens: 0 });
  const cached = p.costOf({
    model: "claude-opus-5",
    baseUrl: "claude-sdk",
    promptTokens: 1_000_000,
    completionTokens: 0,
    cacheReadTokens: 1_000_000,
  });
  expect(fresh?.usd).toBeCloseTo(5, 6);
  expect(cached?.usd).toBeCloseTo(0.5, 6);
  // Ignoring the split would overstate this call tenfold.
  expect(fresh!.usd / cached!.usd).toBeCloseTo(10, 3);
});

test("inconsistent cache buckets cannot produce a negative cost", () => {
  const p = withTable();
  const r = p.costOf({
    model: "claude-opus-5",
    baseUrl: "claude-sdk",
    promptTokens: 100,
    completionTokens: 0,
    cacheReadTokens: 1_000_000,
  });
  expect(r!.usd).toBeGreaterThanOrEqual(0);
});

test("an unknown model is unpriced rather than free", () => {
  const p = withTable();
  expect(p.costOf({ ...base, model: "totally-unknown-local-build", baseUrl: "https://unknown.example/v1" })).toBeUndefined();
});

test("candidate keys go from strict to loose without duplicates", () => {
  const keys = modelKeyCandidates("accounts/fireworks/routers/Kimi-K2p6-Turbo");
  expect(keys[0]).toBe("accounts/fireworks/routers/kimi-k2p6-turbo");
  expect(keys).toContain("kimi-k2p6-turbo");
  expect(keys).toContain("kimi-k26-turbo");
  expect(new Set(keys).size).toBe(keys.length);

  // Quantisation and variant markers are stripped so a self-hosted build finds its base model.
  expect(modelKeyCandidates("Qwen3.6-35B-A3B-uncensored-heretic-Q5_K_M")).toContain("qwen3.6-35b-a3b");
});

test("digit-only collapsing leaves non-version separators alone", () => {
  expect(modelKeyCandidates("gpt-4o")).toContain("gpt-4o");
  expect(modelKeyCandidates("kimi-k2-code")).toContain("kimi-k2-code");
});

/**
 * Since the table started carrying models that declare a window but no price, a key holding one
 * must not shadow a looser key holding the other. Both questions have to resolve independently.
 */
function withMixedTable(): ModelPricing {
  mkdirSync(MY_CLAW_DIR, { recursive: true });
  writeFileSync(
    join(MY_CLAW_DIR, "model-pricing.json"),
    JSON.stringify({
      version: CACHE_VERSION,
      hosts: { acme: "https://acme.example.com/v1" },
      models: {
        acme: {
          // Exact key: a window and nothing else. Collapsed key: the price.
          "widget-1.0": { context: 999_000, id: "widget-1.0" },
          "widget-10": { cost: { input: 1, output: 2 }, id: "widget-1.0" },
        },
      },
    }),
  );
  return new ModelPricing(() => ({}), () => []);
}

test("a priceless entry does not shadow a looser key that carries the price", () => {
  const p = withMixedTable();
  const cost = p.costOf({
    model: "widget-1.0",
    baseUrl: "https://acme.example.com/v1",
    promptTokens: 1_000_000,
    completionTokens: 0,
  });
  expect(cost?.usd).toBeCloseTo(1, 6);
  // The amount alone does not discriminate: without the fallthrough the median rung finds the same
  // figure by another route. The rung that answered is what proves the shadowing did not happen.
  expect(cost?.source).toBe("host acme");
  expect(cost?.billed).toBe(true);
});

test("the window resolves from the entry that declares it, through the provider ladder", () => {
  const p = withMixedTable();
  expect(p.contextWindowOf("widget-1.0", "https://acme.example.com/v1")?.tokens).toBe(999_000);
});

test("an unknown model has no window rather than a fabricated one", () => {
  expect(withMixedTable().contextWindowOf("nothing-like-this", "https://acme.example.com/v1")).toBeUndefined();
});

test("a cache written by an older shape is refused, not served with fields missing", () => {
  mkdirSync(MY_CLAW_DIR, { recursive: true });
  writeFileSync(
    join(MY_CLAW_DIR, "model-pricing.json"),
    JSON.stringify({ version: CACHE_VERSION - 1, hosts: {}, models: { acme: { x: { cost: { input: 1, output: 1 }, id: "x" } } } }),
  );
  // Serving it would mean every model silently keeps the fallback window for a whole refresh period.
  expect(new ModelPricing(() => ({}), () => []).ready()).toBe(false);
});

test("gguf K-quant tags mark a self-hosted build; commercial precision formats do not", () => {
  for (const id of ["Qwen3.6-35B-Q5_K_M", "Qwen3.6-35B-A3B-uncensored-MTP-Q3_K_M-instant", "gemma-4-E4B-it-IQ4_XS", "Meta-Llama-3_1-8B-Instruct-GGUF"]) {
    expect(isSelfHosted(id)).toBe(true);
  }
  // Measured: all 6 models in models.dev carrying these suffixes are billed, 0.05 to 0.50 USD/M.
  for (const id of ["L3.1-70B-Celeste-V0.1-BF16", "NVIDIA-Nemotron-3-Nano-30B-A3B-BF16", "llama-3-8b-instruct-awq", "some-model-gptq", "claude-opus-5", "mimo-v2.5-pro"]) {
    expect(isSelfHosted(id)).toBe(false);
  }
});

test("a window declared without a price survives compaction of the downloaded table", () => {
  // Written through refresh() on purpose: the tests that seed the cache file by hand cannot see
  // whether compact() kept a model that models.dev describes without publishing a price.
  const mock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        acme: {
          api: "https://acme.example.com/v1",
          models: {
            "priceless-model": { limit: { context: 777_000 } },
            "normal-model": { cost: { input: 1, output: 2 }, limit: { context: 100 } },
            "empty-model": {},
          },
        },
      }),
      { status: 200 },
    ),
  );
  try {
    const p = new ModelPricing(() => ({}), () => []);
    return p.refresh().then(() => {
      expect(p.contextWindowOf("priceless-model", "https://acme.example.com/v1")?.tokens).toBe(777_000);
      // It has no price, and inventing one would be worse than reporting nothing.
      expect(p.costOf({ model: "priceless-model", baseUrl: "https://acme.example.com/v1", promptTokens: 1000, completionTokens: 0 })).toBeUndefined();
      // A model with neither price nor window carries nothing and is still dropped.
      expect(p.contextWindowOf("empty-model", "https://acme.example.com/v1")).toBeUndefined();
    });
  } finally {
    mock.restore();
  }
});

/**
 * A pinned OpenRouter endpoint publishes its own tariff, and one model's endpoints span a 6.8x
 * range (0.065 to 0.44 USD/M input measured on deepseek-v4-flash). The model-level table cannot
 * express that: it priced streamlake/fp8 at 2.08x its real rate.
 */
test("a pinned endpoint is billed at its own published price, not the model's", async () => {
  clearOpenRouterCache();
  const mock = mockFetch(async () => new Response(JSON.stringify({
    data: { endpoints: [
      { tag: "streamlake/fp8", provider_name: "StreamLake", pricing: { prompt: "0.000000067", completion: "0.000000134", input_cache_read: "0.0000000134" } },
      { tag: "cloudflare", provider_name: "Cloudflare", pricing: { prompt: "0.00000044", completion: "0.00000132" } },
    ] },
  }), { status: 200 }) as never);
  try {
    await openRouterEndpoints("deepseek/deepseek-v4-flash");
  } finally {
    mock.restore();
  }

  const pricing = new ModelPricing(() => ({}), () => []);
  const usage = { baseUrl: "https://openrouter.ai/api/v1", promptTokens: 1_000_000, completionTokens: 1_000_000 };

  const cheap = pricing.costOf({ ...usage, model: "deepseek/deepseek-v4-flash@streamlake/fp8" });
  assert.ok(cheap, "a pinned run must be priced");
  assert.equal(cheap.usd.toFixed(3), (0.067 + 0.134).toFixed(3));
  assert.equal(cheap.billed, true);
  assert.equal(cheap.approximate, false);
  assert.match(cheap.source, /endpoint streamlake\/fp8/);

  // Same model, same tokens, the expensive endpoint: a 6.8x input gap must show up in the bill.
  const dear = pricing.costOf({ ...usage, model: "deepseek/deepseek-v4-flash@cloudflare" });
  assert.ok(dear);
  assert.equal(dear.usd.toFixed(3), (0.44 + 1.32).toFixed(3));
});

test("the endpoint's cache-read rate is used, which dominates a cached conversation", async () => {
  clearOpenRouterCache();
  const mock = mockFetch(async () => new Response(JSON.stringify({
    data: { endpoints: [{ tag: "streamlake/fp8", pricing: { prompt: "0.000000067", completion: "0.000000134", input_cache_read: "0.0000000134" } }] },
  }), { status: 200 }) as never);
  try {
    await openRouterEndpoints("deepseek/deepseek-v4-flash");
  } finally {
    mock.restore();
  }
  const cost = new ModelPricing(() => ({}), () => []).costOf({
    model: "deepseek/deepseek-v4-flash@streamlake/fp8",
    baseUrl: "https://openrouter.ai/api/v1",
    promptTokens: 1_000_000,
    completionTokens: 0,
    cacheReadTokens: 1_000_000,
  });
  // Every input token was a cache hit, so the whole prompt is billed at 0.0134, not 0.067.
  assert.ok(cost);
  assert.equal(cost.usd.toFixed(4), "0.0134");
});

// A cold cache must not silently bill an endpoint at zero, and an unpinned run has no endpoint
// to be billed at in the first place.
test("no cached listing and no pin both fall through to the usual ladder", () => {
  clearOpenRouterCache();
  const pricing = new ModelPricing(() => ({}), () => []);
  const cold = pricing.costOf({
    model: "deepseek/deepseek-v4-flash@streamlake/fp8",
    baseUrl: "https://openrouter.ai/api/v1",
    promptTokens: 1000,
    completionTokens: 1000,
  });
  // Whatever the ladder answers, it must never be the endpoint rung.
  if (cold) assert.doesNotMatch(cold.source, /^endpoint /);
});

test("a proxy's own figure still outranks the endpoint price", async () => {
  clearOpenRouterCache();
  const mock = mockFetch(async () => new Response(JSON.stringify({
    data: { endpoints: [{ tag: "streamlake/fp8", pricing: { prompt: "0.000000067", completion: "0.000000134" } }] },
  }), { status: 200 }) as never);
  try {
    await openRouterEndpoints("deepseek/deepseek-v4-flash");
  } finally {
    mock.restore();
  }
  const cost = new ModelPricing(() => ({}), () => []).costOf({
    model: "deepseek/deepseek-v4-flash@streamlake/fp8",
    baseUrl: "https://openrouter.ai/api/v1",
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    proxyCostUsd: 0.42,
  });
  assert.equal(cost?.usd, 0.42);
  assert.equal(cost?.source, "proxy");
});
