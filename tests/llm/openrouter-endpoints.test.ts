import { test, setSystemTime } from "bun:test";
import assert from "node:assert/strict";
import {
  openRouterEndpoints,
  openRouterProviderNames,
  openRouterModels,
  openRouterModel,
  cachedOpenRouterModel,
  cachedOpenRouterModels,
  clearOpenRouterCache,
  isOpenRouterBaseUrl,
} from "../../src/llm/openrouter-endpoints.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const ENDPOINTS = {
  data: {
    id: "openai/gpt-5.6-luna",
    endpoints: [
      {
        tag: "azure/eu",
        provider_name: "Azure",
        context_length: 1050000,
        status: 0,
        uptime_last_30m: 99.8,
        pricing: { prompt: "0.00000022", completion: "0.00000132" },
      },
      {
        tag: "openai/flex",
        provider_name: "OpenAI",
        context_length: 1050000,
        status: 0,
        uptime_last_30m: 99.7,
        pricing: { prompt: "0.00000005", completion: "0.0000003" },
      },
      { tag: "azure", provider_name: "Azure", status: -2, uptime_last_30m: 82.5, pricing: { prompt: "0.0000002" } },
      // No tag: unaddressable, so it cannot be offered as a choice.
      { provider_name: "Ghost", pricing: { prompt: "0.0000001" } },
    ],
  },
};

test("endpoints come back cheapest first, priced per million", async () => {
  clearOpenRouterCache();
  const mock = mockFetch(async () => new Response(JSON.stringify(ENDPOINTS), { status: 200, headers: { "Content-Type": "application/json" } }));
  try {
    const routes = await openRouterEndpoints("openai/gpt-5.6-luna");
    assert.deepEqual(routes.map((r) => r.tag), ["openai/flex", "azure", "azure/eu"]);
    // Per-token strings scaled to the million, so the comparison is on a rounded value.
    assert.equal(routes[0]!.promptUsd?.toFixed(3), "0.050");
    assert.equal(routes[0]!.completionUsd?.toFixed(3), "0.300");
    assert.equal(routes[0]!.providerName, "OpenAI");
    assert.equal(routes[2]!.contextLength, 1050000);
    // Health travels with the offer: a cheap endpoint at 82 percent uptime is a different deal.
    assert.equal(routes[1]!.status, -2);
    assert.equal(routes[1]!.uptime30m, 82.5);
  } finally {
    mock.restore();
  }
});

test("the list is cached, so opening a menu twice is one call", async () => {
  clearOpenRouterCache();
  let calls = 0;
  const mock = mockFetch(async () => {
    calls++;
    return new Response(JSON.stringify(ENDPOINTS), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    await openRouterEndpoints("openai/gpt-5.6-luna");
    await openRouterEndpoints("openai/gpt-5.6-luna");
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }
});

// A menu that cannot reach OpenRouter still opens: automatic routing is the answer it falls back
// to, and that is what the run would have done anyway.
test("an unreachable API is an empty list, not an error, and is not retried on the spot", async () => {
  clearOpenRouterCache();
  let calls = 0;
  const mock = mockFetch(async () => {
    calls++;
    throw new Error("network down");
  });
  try {
    assert.deepEqual(await openRouterEndpoints("openai/gpt-5.6-luna"), []);
    assert.deepEqual(await openRouterEndpoints("openai/gpt-5.6-luna"), []);
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }
});

const MODELS = {
  data: [
    {
      id: "deepseek/deepseek-v4-flash",
      canonical_slug: "deepseek/deepseek-v4-flash-20260731",
      name: "DeepSeek: DeepSeek V4 Flash",
      context_length: 1048576,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: {
        prompt: "0.00000022",
        completion: "0.00000066",
        input_cache_read: "0.000000007",
        input_cache_write: "0.0000003",
      },
      // Narrower than the model-level window: the serving endpoint is what a run actually gets.
      top_provider: { context_length: 786432, max_completion_tokens: 384000, is_moderated: false },
      supported_parameters: ["tools", "reasoning"],
      reasoning: { mandatory: false, supported_efforts: ["high", "low"] },
      expiration_date: null,
    },
    {
      // Same base model, different offer: free tier prices at zero and must stay a separate row.
      id: "deepseek/deepseek-v4-flash:free",
      name: "DeepSeek: DeepSeek V4 Flash (free)",
      context_length: 1048576,
      pricing: { prompt: "0", completion: "0" },
      top_provider: { context_length: 1048576, max_completion_tokens: null, is_moderated: true },
      expiration_date: "2098-12-31",
    },
    // No id: unaddressable, so it cannot be a catalogue row.
    { name: "Ghost", pricing: { prompt: "0.0000001" } },
  ],
};

function modelsMock(counter?: { calls: number }) {
  return mockFetch(async () => {
    if (counter) counter.calls++;
    return new Response(JSON.stringify(MODELS), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

test("OpenRouter host recognition is URL based and accepts official subdomains", () => {
  assert.equal(isOpenRouterBaseUrl("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterBaseUrl("https://gateway.openrouter.ai/v1"), true);
  assert.equal(isOpenRouterBaseUrl("https://proxy.example/openrouter.ai/api/v1"), false);
  assert.equal(isOpenRouterBaseUrl("https://not-openrouter.ai/v1"), false);
});

test("catalogue rows are typed, priced per million, and keyed by exact id", async () => {
  clearOpenRouterCache();
  const mock = modelsMock();
  try {
    const models = await openRouterModels();
    assert.deepEqual([...models.keys()], ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash:free"]);
    const flash = models.get("deepseek/deepseek-v4-flash")!;
    assert.equal(flash.name, "DeepSeek: DeepSeek V4 Flash");
    assert.equal(flash.canonicalSlug, "deepseek/deepseek-v4-flash-20260731");
    assert.equal(flash.promptUsd?.toFixed(3), "0.220");
    assert.equal(flash.completionUsd?.toFixed(3), "0.660");
    assert.equal(flash.cacheReadUsd?.toFixed(3), "0.007");
    assert.equal(flash.cacheWriteUsd?.toFixed(3), "0.300");
    // top_provider wins over the model-level window.
    assert.equal(flash.contextLength, 786432);
    assert.equal(flash.maxOutput, 384000);
    assert.equal(flash.moderated, false);
    assert.deepEqual(flash.inputModalities, ["text", "image"]);
    assert.deepEqual(flash.outputModalities, ["text"]);
    assert.deepEqual(flash.supportedParameters, ["tools", "reasoning"]);
    assert.equal(flash.reasoningMandatory, false);
    assert.deepEqual(flash.reasoningEfforts, ["high", "low"]);
    assert.equal(flash.expirationDate, undefined);
  } finally {
    mock.restore();
  }
});

// A `:free` or `:batch` suffix is a different price on the same weights. Collapsing the id onto the
// base model would bill a free run at the paid rate.
test("a suffix variant is its own row, not a synonym of the base id", async () => {
  clearOpenRouterCache();
  const mock = modelsMock();
  try {
    const free = await openRouterModel("deepseek/deepseek-v4-flash:free");
    assert.equal(free?.id, "deepseek/deepseek-v4-flash:free");
    assert.equal(free?.promptUsd, 0);
    assert.equal(free?.completionUsd, 0);
    assert.equal(free?.maxOutput, undefined);
    assert.equal(free?.moderated, true);
    assert.equal(free?.expirationDate, "2098-12-31");
    // The base id keeps its own price.
    assert.equal((await openRouterModel("deepseek/deepseek-v4-flash"))?.promptUsd?.toFixed(3), "0.220");
    // And a normalised lookup finds nothing rather than the wrong row.
    assert.equal(await openRouterModel("deepseek/deepseek-v4-flash:FREE"), undefined);
  } finally {
    mock.restore();
  }
});

// The manual refresh button promises "everything, fresh now". The TTL is for the automatic
// paths; a forced call is the one moment refetching inside it is the whole point.
test("a forced call refetches inside the TTL, which still guards the plain path", async () => {
  clearOpenRouterCache();
  const counter = { calls: 0 };
  const mock = modelsMock(counter);
  try {
    await openRouterModels();
    await openRouterModels();
    assert.equal(counter.calls, 1);
    await openRouterModels(true);
    assert.equal(counter.calls, 2);
    await openRouterModels();
    assert.equal(counter.calls, 2);
  } finally {
    mock.restore();
  }
});

test("the catalogue is fetched once, even for concurrent callers", async () => {
  clearOpenRouterCache();
  const counter = { calls: 0 };
  const mock = modelsMock(counter);
  try {
    const [a, b] = await Promise.all([openRouterModels(), openRouterModels()]);
    assert.equal(counter.calls, 1);
    assert.equal(a, b);
    await openRouterModels();
    assert.equal(counter.calls, 1);
  } finally {
    mock.restore();
  }
});

test("an unreachable catalogue is an empty map, not an error, and is not retried on the spot", async () => {
  clearOpenRouterCache();
  let calls = 0;
  const mock = mockFetch(async () => {
    calls++;
    throw new Error("network down");
  });
  try {
    assert.equal((await openRouterModels()).size, 0);
    assert.equal((await openRouterModels()).size, 0);
    assert.equal(calls, 1);
    assert.equal(await openRouterModel("deepseek/deepseek-v4-flash"), undefined);
  } finally {
    mock.restore();
  }
});

// Pricing and window resolution are synchronous hot paths: a cold cache must read as "no evidence"
// instead of reaching for the network.
test("the cached reader never fetches and is empty until the catalogue is loaded", async () => {
  clearOpenRouterCache();
  let calls = 0;
  const mock = mockFetch(async () => {
    calls++;
    return new Response(JSON.stringify(MODELS), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    assert.equal(cachedOpenRouterModels(), undefined);
    assert.equal(cachedOpenRouterModel("deepseek/deepseek-v4-flash"), undefined);
    assert.equal(calls, 0);

    await openRouterModels();
    assert.equal(cachedOpenRouterModel("deepseek/deepseek-v4-flash")?.contextLength, 786432);
    assert.equal(calls, 1);

    // The seam drops the catalogue with the rest of the module state.
    clearOpenRouterCache();
    assert.equal(cachedOpenRouterModels(), undefined);
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }
});

/**
 * The cache has a TTL and the reader must survive it -- measured live on 2026-09-11.
 *
 * `cachedOpenRouterModels()` used to answer `undefined` the moment the 15-minute TTL elapsed, so an
 * OpenRouter model stopped being described by the catalogue that knows it and fell through to
 * models.dev, which carries none of the batch variants. That is also the state in which the alias
 * rung went looking for a neighbour: a model with no metadata had one, borrowed, and wore a
 * stranger's name until the next refresh.
 *
 * The TTL belongs to `openRouterModels()` -- it is what decides to refetch. The synchronous reader
 * answers with the last catalogue it was given, which is what the models.dev table already does
 * with its 24-hour disk copy.
 */
test("the cached catalogue survives its TTL, so an aged cache never turns a model into an unknown", async () => {
  clearOpenRouterCache();
  const counter = { calls: 0 };
  const mock = modelsMock(counter);
  try {
    await openRouterModels();
    assert.equal(counter.calls, 1);
    assert.equal(cachedOpenRouterModel("deepseek/deepseek-v4-flash")?.contextLength, 786432);

    setSystemTime(new Date(Date.now() + 20 * 60 * 1000));
    assert.equal(cachedOpenRouterModels()?.size, 2);
    assert.equal(cachedOpenRouterModel("deepseek/deepseek-v4-flash")?.name, "DeepSeek: DeepSeek V4 Flash");

    // The plain path still refreshes once the TTL has elapsed: the cache is not frozen, it is read.
    await openRouterModels();
    assert.equal(counter.calls, 2);
  } finally {
    setSystemTime();
    mock.restore();
  }
});

test("provider names are read from the catalogue, never derived from the slug", async () => {
  clearOpenRouterCache();
  const mock = mockFetch(async () => new Response(JSON.stringify({
    data: [
      { name: "Amazon Bedrock", slug: "amazon-bedrock" },
      { name: "Z.AI", slug: "z-ai" },
      { name: "No slug" },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  try {
    const names = await openRouterProviderNames();
    assert.equal(names.get("amazon-bedrock"), "Amazon Bedrock");
    assert.equal(names.get("z-ai"), "Z.AI");
    assert.equal(names.size, 2);
  } finally {
    mock.restore();
  }
});
