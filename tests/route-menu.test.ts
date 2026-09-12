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
import {
  cachedOpenRouterProviderName,
  clearOpenRouterCache,
  openRouterProviderNames,
} from "../src/llm/openrouter-endpoints.ts";
import { ModelPicker } from "../src/channels/model-picker.ts";
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

const PROVIDERS = {
  data: [
    { name: "StreamLake", slug: "streamlake" },
    { name: "OpenAI", slug: "openai" },
  ],
};

function endpointsResponse(): Response {
  return new Response(JSON.stringify(ENDPOINTS), { status: 200, headers: { "Content-Type": "application/json" } });
}

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

/**
 * A usage row spells its provider with the name OpenRouter publishes for it, read through an
 * accessor that is forbidden from fetching (docs/status-command.md). Opening this menu is what
 * fills that cache: it is already the one gesture that reaches OpenRouter about a model, and
 * nothing else ever asked for the provider list.
 */
test("opening the route menu fills the provider names nothing else would ask for", async () => {
  clearOpenRouterCache();
  let providers = 0;
  const mock = mockFetch(async (input) => {
    if (!String(input).endsWith("/providers")) return endpointsResponse();
    providers++;
    return new Response(JSON.stringify(PROVIDERS), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    assert.equal(cachedOpenRouterProviderName("streamlake"), undefined);

    const routes = await routesFor(config(), "openrouter/openai/gpt-5.6-luna");
    assert.deepEqual(routes.map((r) => r.tag), ["openai/flex", "azure/eu"]);
    assert.equal(providers, 1);

    // Joined instead of raced: a warm cache answers with no request at all, so the count standing
    // still is what proves the menu's own lookup had already landed.
    await openRouterProviderNames();
    assert.equal(providers, 1);
    assert.equal(cachedOpenRouterProviderName("streamlake"), "StreamLake");
  } finally {
    mock.restore();
  }
});

/**
 * The names are a decoration on a page nobody is looking at yet, and this menu is a gesture the
 * owner is waiting on. The lookup is therefore started and never waited on, and it keeps its own
 * failure: a cold cache leaves the usage rows on their verbatim tags, which is what they carried
 * before the names existed.
 */
test("a provider list that hangs does not hold the menu, and a failed one names nothing", async () => {
  clearOpenRouterCache();
  let failProviders: ((err: Error) => void) | undefined;
  const providers = new Promise<Response>((_resolve, reject) => {
    failProviders = reject;
  });
  // Nothing awaits this one until the end of the test, so the rejection is claimed here rather
  // than surfacing as the test's own unhandled error.
  providers.catch(() => {});
  const mock = mockFetch(async (input) => (String(input).endsWith("/providers") ? providers : endpointsResponse()));
  try {
    // Hangs on this line if the menu ever waits for the names.
    const routes = await routesFor(config(), "openrouter/openai/gpt-5.6-luna");
    assert.deepEqual(routes.map((r) => r.tag), ["openai/flex", "azure/eu"]);
    assert.equal(cachedOpenRouterProviderName("streamlake"), undefined);

    failProviders!(new Error("openrouter unreachable"));
    // The lookup swallows it, so this resolves; what it leaves behind names nothing.
    await openRouterProviderNames();
    assert.equal(cachedOpenRouterProviderName("streamlake"), undefined);
  } finally {
    mock.restore();
  }
});

test("a model with a single route is never asked about", async () => {
  clearOpenRouterCache();
  let asked = 0;
  const mock = mockFetch(async () => {
    asked++;
    throw new Error("the network must not be touched for a model that cannot be pinned");
  });
  try {
    assert.deepEqual(await routesFor(config(), "litellm/qwen"), []);
    // Counted, not only thrown: every OpenRouter lookup here swallows its own failure, so a
    // request made for a model that cannot be pinned would leave no trace in the result.
    assert.equal(asked, 0);
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

/**
 * The sort has to be reachable from the menu itself, not only from the helper: a picker offering
 * one order and an API offering four is the same list presented two ways.
 */
test("the route menu offers every ordering, marks the active one, and round-trips", () => {
  const picker = new ModelPicker([]);
  const routes = [
    { tag: "streamlake/fp8", label: "StreamLake $0.067 1M/384k" },
    { tag: "cloudflare", label: "Cloudflare $0.440 1.3M/1.3M" },
  ];
  const buttons = picker.buildRouteButtons(routes, "streamlake/fp8", undefined, "output");
  const sortButtons = buttons.filter((b) => b.action.startsWith("rts:"));
  assert.deepEqual(sortButtons.map((b) => b.action), ["rts:price", "rts:context", "rts:output", "rts:uptime"]);

  // The active ordering is the one marked, so the menu says how it is currently sorted.
  const active = sortButtons.filter((b) => b.label.includes("Sortie"));
  assert.equal(active.length, 1);
  assert.notEqual(active[0]!.label, `Tri: ${"Sortie"}`);

  // And the button parses back into the action that reopens the list that way.
  assert.deepEqual(picker.parseCallbackAction("rts:output"), { kind: "openRoute", sort: "output" });
  assert.equal(picker.parseCallbackAction("rts:nonsense"), null);
});

test("a single-route model is offered no ordering: there is nothing to reorder", () => {
  const picker = new ModelPicker([]);
  const buttons = picker.buildRouteButtons([{ tag: "only/one", label: "Only" }], "only/one");
  assert.equal(buttons.filter((b) => b.action.startsWith("rts:")).length, 0);
});
