import { test } from "bun:test";
import assert from "node:assert/strict";
import { openRouterEndpoints, openRouterProviderNames, clearOpenRouterCache } from "../../src/llm/openrouter-endpoints.ts";
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
