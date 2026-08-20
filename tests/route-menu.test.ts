import { test } from "bun:test";
import assert from "node:assert/strict";
import type { MyClawConfig } from "../src/core/config.ts";
import {
  referenceWithRoute,
  routeChoiceFor,
  routeLabel,
  routesFor,
  sortRoutes,
  type RouteOption,
} from "../src/channels/route-menu.ts";
import { clearOpenRouterCache } from "../src/llm/openrouter-endpoints.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";

/**
 * The route step, shared by both channel menus and by the app: which model can be pinned, to
 * what, and what the pin spells. See docs/model-identity.md.
 */

const ENDPOINTS = {
  data: {
    id: "openai/gpt-5.6-luna",
    endpoints: [
      { tag: "openai/flex", provider_name: "OpenAI", status: 0, pricing: { prompt: "0.00000005", completion: "0.0000003" } },
      { tag: "azure/eu", provider_name: "Azure", status: -2, pricing: { prompt: "0.00000022", completion: "0.00000132" } },
    ],
  },
};

function config(): MyClawConfig {
  return {
    llm: {
      defaultProvider: "openrouter",
      defaultModel: "openrouter/openai/gpt-5.6-luna",
      providers: {
        openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", discover: true },
        litellm: { baseUrl: "https://litellm.example/v1", apiKeyEnv: "LITELLM_API_KEY", discover: true },
      },
      models: [
        { id: "openrouter/openai/gpt-5.6-luna", apiId: "openai/gpt-5.6-luna", label: "Luna", provider: "openrouter" },
        { id: "litellm/qwen", apiId: "qwen", label: "Qwen", provider: "litellm" },
      ],
    },
  } as unknown as MyClawConfig;
}

test("only a model OpenRouter serves can be pinned", () => {
  assert.equal(routeChoiceFor(config(), "openrouter/openai/gpt-5.6-luna").available, true);
  // Same name, another provider: the pin would be an unknown key in someone else's request body.
  assert.equal(routeChoiceFor(config(), "litellm/qwen").available, false);
  assert.equal(routeChoiceFor(config(), "nothing-like-this").available, false);
});

test("the route in force is read from the reference, not remembered", () => {
  const choice = routeChoiceFor(config(), "openrouter/openai/gpt-5.6-luna@azure/eu");
  assert.equal(choice.available, true);
  assert.equal(choice.current, "azure/eu");
  assert.equal(routeChoiceFor(config(), "openrouter/openai/gpt-5.6-luna").current, undefined);
});

test("pinning and unpinning both spell one reference", () => {
  assert.equal(
    referenceWithRoute("openrouter/openai/gpt-5.6-luna", "azure/eu"),
    "openrouter/openai/gpt-5.6-luna@azure/eu",
  );
  // Switching route replaces the pin rather than stacking a second one.
  assert.equal(
    referenceWithRoute("openrouter/openai/gpt-5.6-luna@azure/eu", "openai/flex"),
    "openrouter/openai/gpt-5.6-luna@openai/flex",
  );
  assert.equal(referenceWithRoute("openrouter/openai/gpt-5.6-luna@azure/eu"), "openrouter/openai/gpt-5.6-luna");
});

test("the routes of a model are asked for under the id its provider knows", async () => {
  clearOpenRouterCache();
  let asked = "";
  const mock = mockFetch(async (input) => {
    asked = String(input);
    return new Response(JSON.stringify(ENDPOINTS), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    const routes = await routesFor(config(), "openrouter/openai/gpt-5.6-luna");
    // The qualified reference addresses the model here; OpenRouter only knows `openai/gpt-5.6-luna`.
    assert.ok(asked.includes("/models/openai/gpt-5.6-luna/endpoints"), asked);
    assert.deepEqual(routes.map((r) => r.tag), ["openai/flex", "azure/eu"]);
    assert.equal(routes[1]!.degraded, true);
    assert.equal(routeLabel(routes[0]!), "OpenAI $0.050");
    assert.equal(routeLabel(routes[1]!), "Azure $0.220 (degraded)");
  } finally {
    mock.restore();
  }
});

test("a model with a single route is never asked about", async () => {
  clearOpenRouterCache();
  const mock = mockFetch(async () => {
    throw new Error("the network must not be touched for a model that cannot be pinned");
  });
  try {
    assert.deepEqual(await routesFor(config(), "litellm/qwen"), []);
  } finally {
    mock.restore();
  }
});

/**
 * The label used to show the context window alone. A 1M-context route whose output ceiling is
 * 384k then read as if it accepted a 1M-token answer, which is exactly the confusion that hid the
 * pinned-endpoint 404 for a whole debugging session.
 */
test("a label shows both sides of the window, input and output", () => {
  const route: RouteOption = { tag: "streamlake/fp8", providerName: "StreamLake", promptUsd: 0.0672, context: 1024000, maxOutput: 384000 };
  assert.equal(routeLabel(route), "StreamLake $0.067 1M/384k");
});

test("a route publishing no output ceiling shows the context alone, not a fabricated one", () => {
  const route: RouteOption = { tag: "digitalocean", providerName: "DigitalOcean", context: 1048576 };
  assert.equal(routeLabel(route), "DigitalOcean 1M");
});

test("sorting: price ascends, every other figure descends", () => {
  const routes: RouteOption[] = [
    { tag: "mid", providerName: "Mid", promptUsd: 0.5, context: 262144, maxOutput: 262144, uptime30m: 95 },
    { tag: "cheap", providerName: "Cheap", promptUsd: 0.1, context: 131072, maxOutput: 131072, uptime30m: 80 },
    { tag: "big", providerName: "Big", promptUsd: 0.9, context: 1048576, maxOutput: 384000, uptime30m: 99 },
  ];
  assert.deepEqual(sortRoutes(routes, "price").map((r) => r.tag), ["cheap", "mid", "big"]);
  assert.deepEqual(sortRoutes(routes, "context").map((r) => r.tag), ["big", "mid", "cheap"]);
  assert.deepEqual(sortRoutes(routes, "output").map((r) => r.tag), ["big", "mid", "cheap"]);
  assert.deepEqual(sortRoutes(routes, "uptime").map((r) => r.tag), ["big", "mid", "cheap"]);
});

// A missing figure must not sort as zero: on price that would present "unknown" as "free", and
// pinning the cheapest route is the whole reason the menu is ordered by price by default.
test("sorting: a route missing the figure sinks instead of winning", () => {
  const routes: RouteOption[] = [
    { tag: "unknown", providerName: "Unknown" },
    { tag: "priced", providerName: "Priced", promptUsd: 0.4, context: 262144 },
  ];
  assert.deepEqual(sortRoutes(routes, "price").map((r) => r.tag), ["priced", "unknown"]);
  assert.deepEqual(sortRoutes(routes, "context").map((r) => r.tag), ["priced", "unknown"]);
});

test("sorting never mutates the list it was given", () => {
  const routes: RouteOption[] = [
    { tag: "b", providerName: "B", promptUsd: 2 },
    { tag: "a", providerName: "A", promptUsd: 1 },
  ];
  sortRoutes(routes, "price");
  assert.deepEqual(routes.map((r) => r.tag), ["b", "a"]);
});
