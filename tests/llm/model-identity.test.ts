import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveLlmConfig, isOpenRouterBaseUrl } from "../../src/llm/resolver.ts";
import { resolveModelContextWindow } from "../../src/llm/context-window.ts";
import { modelKeyCandidates } from "../../src/llm/pricing.ts";
import { chatCompletion } from "../../src/llm/provider.ts";
import { openRouterEndpoints, clearOpenRouterCache } from "../../src/llm/openrouter-endpoints.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import type { LlmConfig, MyClawConfig } from "../../src/core/config.ts";

/** Two providers serving the same name, which is the whole point of qualified references. */
function config(): LlmConfig {
  return {
    defaultProvider: "litellm",
    defaultModel: "mimo-v2.5",
    providers: {
      litellm: { baseUrl: "https://litellm.example/v1" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
      opencode_go: { baseUrl: "https://opencode.ai/zen/go/v1" },
    },
    models: [
      { id: "mimo-v2.5", label: "MiMo", provider: "litellm" },
      { id: "opencode_go/mimo-v2.5", label: "mimo-v2.5", apiId: "mimo-v2.5", provider: "opencode_go" },
      { id: "openrouter/openai/gpt-5.6-luna", label: "openai/gpt-5.6-luna", apiId: "openai/gpt-5.6-luna", provider: "openrouter" },
    ],
  };
}

test("a qualified reference reaches its own provider, not the first one holding the name", () => {
  const zen = resolveLlmConfig(config(), "opencode_go/mimo-v2.5");
  assert.equal(zen.provider, "opencode_go");
  assert.equal(zen.baseUrl, "https://opencode.ai/zen/go/v1");
  // The request carries the id the provider knows, never our reference.
  assert.equal(zen.apiModel, "mimo-v2.5");
  // The run keeps its identity, so status and analytics can tell the two copies apart.
  assert.equal(zen.model, "opencode_go/mimo-v2.5");
});

test("a bare reference takes the first provider that serves it, in config order", () => {
  const bare = resolveLlmConfig(config(), "mimo-v2.5");
  assert.equal(bare.provider, "litellm");
  assert.equal(bare.apiModel, undefined, "nothing to translate: the reference is already the wire id");
});

test("a reference nobody declares still resolves through its provider prefix", () => {
  const unknown = resolveLlmConfig(config(), "opencode_go/glm-5.3");
  assert.equal(unknown.provider, "opencode_go");
  assert.equal(unknown.apiModel, "glm-5.3");
});

test("an endpoint pin becomes a provider route, and only for OpenRouter", () => {
  const pinned = resolveLlmConfig(config(), "openrouter/openai/gpt-5.6-luna@azure/eu");
  assert.equal(pinned.provider, "openrouter");
  assert.equal(pinned.apiModel, "openai/gpt-5.6-luna");
  assert.equal(pinned.providerRoute, "azure/eu");

  // The same syntax on a provider that has never heard of endpoint routing sends nothing: the
  // field would be an unknown key in someone else's request body.
  const elsewhere = resolveLlmConfig(config(), "opencode_go/mimo-v2.5@azure/eu");
  assert.equal(elsewhere.providerRoute, undefined);
  assert.equal(elsewhere.apiModel, "mimo-v2.5");
});

test("OpenRouter is recognised by host, never by the key it was given", () => {
  assert.equal(isOpenRouterBaseUrl("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterBaseUrl("https://gateway.openrouter.ai/v1"), true);
  assert.equal(isOpenRouterBaseUrl("https://litellm.example/v1"), false);
  assert.equal(isOpenRouterBaseUrl(undefined), false);
  assert.equal(isOpenRouterBaseUrl("not a url"), false);
});

// The silent failure of this whole change: a qualified reference that no longer matches the price
// table would fall back to the default window, and nothing would say so.
test("the price table still recognises a qualified and pinned reference", () => {
  assert.ok(modelKeyCandidates("openrouter/openai/gpt-5.6-luna@azure/eu").includes("gpt-5.6-luna"));
  assert.ok(modelKeyCandidates("opencode_go/mimo-v2.5").includes("mimo-v2.5"));
  // The pin is never a model name of its own.
  assert.ok(!modelKeyCandidates("openrouter/x@azure/eu").includes("eu"));
});

test("a qualified reference reads the window its own entry declares", () => {
  const full: MyClawConfig = {
    whitelist: [], blacklist: [], channels: {},
    llm: {
      ...config(),
      models: [
        { id: "mimo-v2.5", label: "MiMo", provider: "litellm", limit: { context: 100 } },
        { id: "opencode_go/mimo-v2.5", label: "mimo-v2.5", apiId: "mimo-v2.5", provider: "opencode_go", limit: { context: 200 } },
      ],
    },
    agents: {}, memory: { enabled: false },
  };
  assert.equal(resolveModelContextWindow(full, "mimo-v2.5").raw, 100);
  assert.equal(resolveModelContextWindow(full, "opencode_go/mimo-v2.5").raw, 200);
});

// The pin only means something once it reaches the wire: OpenRouter reads it from the body.
test("a pinned run sends the endpoint in the request body, fallbacks off", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  try {
    await chatCompletion(resolveLlmConfig(config(), "openrouter/openai/gpt-5.6-luna@azure/eu"), [
      { role: "user", content: "hi" },
    ]);
    assert.equal(bodies[0]!["model"], "openai/gpt-5.6-luna");
    assert.deepEqual(bodies[0]!["provider"], { order: ["azure/eu"], allow_fallbacks: false });

    await chatCompletion(resolveLlmConfig(config(), "openrouter/openai/gpt-5.6-luna"), [
      { role: "user", content: "hi" },
    ]);
    assert.equal(bodies[1]!["provider"], undefined, "no pin, no routing directive");
  } finally {
    mock.restore();
  }
});

/**
 * The pinned-endpoint limits. OpenRouter publishes model-level figures taken from its *best*
 * endpoint, so a pinned run that trusts them reasons about capacity it does not have: the output
 * ask comes back as a 404, and the context budget aims past the endpoint's real window.
 */
test("a pinned run inherits the endpoint's limits, not the model's best-endpoint figures", async () => {
  clearOpenRouterCache();
  const mock = mockFetch(async () => new Response(JSON.stringify({
    data: { endpoints: [{ tag: "streamlake/fp8", context_length: 1024000, max_completion_tokens: 384000 }] },
  }), { status: 200 }) as never);
  try {
    // Warms the cache the synchronous resolver reads: a menu opening on the model does this.
    await openRouterEndpoints("deepseek/deepseek-v4-flash");
  } finally {
    mock.restore();
  }

  const config = {
    defaultProvider: "openrouter",
    providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } },
    limit: { context: 1310720, output: 393216 },
  };
  const pinned = resolveLlmConfig(config, "openrouter/deepseek/deepseek-v4-flash@streamlake/fp8");
  assert.equal(pinned.limit?.output, 384000);
  assert.equal(pinned.limit?.context, 1024000);

  // Same model, no pin: nothing is lowered, because no endpoint was chosen.
  const unpinned = resolveLlmConfig(config, "openrouter/deepseek/deepseek-v4-flash");
  assert.equal(unpinned.limit?.output, 393216);
  assert.equal(unpinned.limit?.context, 1310720);
});

test("a declared limit tighter than the endpoint's is kept: the pin is a ceiling, not a floor", async () => {
  clearOpenRouterCache();
  const mock = mockFetch(async () => new Response(JSON.stringify({
    data: { endpoints: [{ tag: "streamlake/fp8", context_length: 1024000, max_completion_tokens: 384000 }] },
  }), { status: 200 }) as never);
  try {
    await openRouterEndpoints("deepseek/deepseek-v4-flash");
  } finally {
    mock.restore();
  }
  const pinned = resolveLlmConfig({
    defaultProvider: "openrouter",
    providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } },
    limit: { context: 200000, output: 8192 },
  }, "openrouter/deepseek/deepseek-v4-flash@streamlake/fp8");
  assert.equal(pinned.limit?.output, 8192);
  assert.equal(pinned.limit?.context, 200000);
});

// The resolver runs on every display and every trim, so it cannot await a lookup. A cold cache
// must therefore change nothing rather than block or guess.
test("a cold cache leaves a pinned run's limits exactly as declared", () => {
  clearOpenRouterCache();
  const pinned = resolveLlmConfig({
    defaultProvider: "openrouter",
    providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } },
    limit: { context: 1310720, output: 393216 },
  }, "openrouter/deepseek/deepseek-v4-flash@streamlake/fp8");
  assert.equal(pinned.limit?.output, 393216);
  assert.equal(pinned.limit?.context, 1310720);
});
