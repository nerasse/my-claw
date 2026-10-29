/**
 * `quota`: what each provider says is left, as a tool -- docs/quota.md.
 *
 * The numbers themselves are the module's own (its cache, its TTL, its adapters); what is pinned
 * here is the part the tool decides: which providers it walks, that it never probes unasked, that a
 * provider with no usage endpoint says so instead of being drawn as an empty plan, and that the
 * "spent until" line is the same function the retry arms on.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { createQuotaTool } from "../../src/tools/quota.ts";
import { resetQuotaCache } from "../../src/llm/quota/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

// The module reads a keyed provider's credential from the env name it declares, never from a
// literal in the config: that is the install's rule, and the test honours it rather than working
// around it.
process.env["SYNTH_KEY"] = "test-key";

/** Synthetic's own shape: one weekly bar, its complement as `percentRemaining`, a next tick. */
function syntheticBody(percentRemaining: number, nextRegenAt: string) {
  return JSON.stringify({
    planWeeklyLimit: { percentRemaining, nextRegenAt },
    rollingFiveHourLimit: { max: 500, remaining: 500, nextTickAt: nextRegenAt },
  });
}

function config(): MyClawConfig {
  return {
    whitelist: [], blacklist: [], channels: {},
    llm: {
      providers: {
        synth: { baseUrl: "https://api.synthetic.new/openai/v1", apiKeyEnv: "SYNTH_KEY" },
        local: { baseUrl: "https://litellm.example/v1" },
      },
      models: [],
      defaultProvider: "local",
      defaultModel: "m",
    },
    agents: {},
    memory: { enabled: false },
  } as unknown as MyClawConfig;
}

/** Every read the tool makes, so "did it probe?" is answerable. */
function wire(body: string) {
  const urls: string[] = [];
  const mock = mockFetch(async (input) => {
    urls.push(String(input));
    return new Response(body, { status: 200 }) as never;
  });
  return { urls, restore: () => mock.restore() };
}

test("a provider that publishes usage is described: windows, used percent, reset", async () => {
  resetQuotaCache();
  const w = wire(syntheticBody(20, "2026-10-30T00:00:00.000Z"));
  try {
    const tool = createQuotaTool(config());
    const result = await tool.execute({ provider: "synth" });
    assert.equal(result.success, true);
    assert.match(result.output, /synth: synthetic/);
    assert.match(result.output, /Week: 80% used/);
    assert.match(result.output, /resets 2026-10-30T00:00:00.000Z/);
    assert.equal(w.urls.length, 1, "one read, not one per line");
  } finally {
    w.restore();
  }
});

/**
 * A provided plan at 100% names the second it reopens. The tool says it with `quotaWaitFrom`, the
 * same function the retry arms on: two answers to "when does this come back" is how a pill and a
 * tool end up disagreeing in front of the owner.
 */
test("a spent window names the re-opening time the retry would wait for", async () => {
  resetQuotaCache();
  const tick = new Date(Date.now() + 3 * 3600_000).toISOString();
  const w = wire(syntheticBody(0, tick));
  try {
    const tool = createQuotaTool(config());
    const result = await tool.execute({ provider: "synth" });
    assert.match(result.output, /Week: 100% used/);
    assert.match(result.output, /spent: the earliest reset it published is /);
    // The wait carries a minute of slack over the provider's own second.
    const buffer = new Date(Date.parse(tick) + 60_000).toISOString();
    assert.ok(result.output.includes(buffer), `expected the buffered reset ${buffer}`);
  } finally {
    w.restore();
  }
});

test("a window with room left is not called spent", async () => {
  resetQuotaCache();
  const w = wire(syntheticBody(50, new Date(Date.now() + 3600_000).toISOString()));
  try {
    const tool = createQuotaTool(config());
    const result = await tool.execute({ provider: "synth" });
    assert.match(result.output, /nothing spent on a window that names a reset/);
  } finally {
    w.restore();
  }
});

/**
 * Without a provider the tool walks only the ones that can answer. Listing a LiteLLM endpoint as
 * "no-source" is a line the caller cannot act on, on every single call.
 */
test("with no provider it walks the ones that publish usage, and says so when none do", async () => {
  resetQuotaCache();
  const w = wire(syntheticBody(10, "2026-10-30T00:00:00.000Z"));
  try {
    const all = await createQuotaTool(config()).execute({});
    assert.equal(all.success, true);
    assert.match(all.output, /synth: synthetic/);
    assert.doesNotMatch(all.output, /local/, "a provider with no usage endpoint is not a line");
  } finally {
    w.restore();
  }

  resetQuotaCache();
  const bare: MyClawConfig = {
    whitelist: [], blacklist: [], channels: {},
    llm: { providers: { local: { baseUrl: "https://litellm.example/v1" } }, models: [], defaultModel: "m" },
    agents: {}, memory: { enabled: false },
  } as unknown as MyClawConfig;
  const none = await createQuotaTool(bare).execute({});
  assert.equal(none.success, true);
  assert.match(none.output, /No configured provider publishes a usage endpoint/);

  // A provider that has an endpoint but publishes none is still answerable by name.
  resetQuotaCache();
  const w2 = wire(syntheticBody(10, "2026-10-30T00:00:00.000Z"));
  try {
    const named = await createQuotaTool(config()).execute({ provider: "local" });
    assert.equal(named.success, true);
    assert.match(named.output, /local: unavailable \(no-source\)/);
  } finally {
    w2.restore();
  }
});

test("an unknown provider is refused, with the keys this install has", async () => {
  const tool = createQuotaTool(config());
  const result = await tool.execute({ provider: "nope" });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Unknown provider "nope"/);
  assert.match(result.error ?? "", /synth/);
});

/**
 * The one behaviour a caller pays for: a repeated read answers from the module's cache unless it
 * asks. A model that probed on every turn would burn a request to learn nothing new, and on a
 * provider whose usage endpoint is rate-limited that request has a cost of its own.
 */
test("a second read is free, and force is the only thing that probes again", async () => {
  resetQuotaCache();
  const w = wire(syntheticBody(20, "2026-10-30T00:00:00.000Z"));
  try {
    const tool = createQuotaTool(config());
    await tool.execute({ provider: "synth" });
    await tool.execute({ provider: "synth" });
    assert.equal(w.urls.length, 1, "the cached answer was reused");

    await tool.execute({ provider: "synth", force: true });
    assert.equal(w.urls.length, 2, "force reads again");
  } finally {
    w.restore();
  }
});

/** A read that fails is reported as a failure of that provider, not as an empty plan. */
test("an unreadable provider says which failure it was", async () => {
  resetQuotaCache();
  const mock = mockFetch(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 }) as never);
  try {
    const result = await createQuotaTool(config()).execute({ provider: "synth" });
    assert.equal(result.success, true);
    assert.match(result.output, /synth: unavailable \(not-signed-in\)/);
  } finally {
    mock.restore();
  }
});
