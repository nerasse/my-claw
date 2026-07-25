import { test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ModelCatalog, mergeModels, applyProviderGroups } from "../../src/llm/catalog.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import type { LlmConfig, LlmModelConfig } from "../../src/core/config.ts";

// Discovery persists to a shared cache file; clear it so tests don't inherit each other's state.
function clearCatalogCache(): void {
  rmSync(join(MY_CLAW_DIR, "model-catalog.json"), { force: true });
}

test("mergeModels: config wins on id collision, appends extras in order", () => {
  const base: LlmModelConfig[] = [
    { id: "mimo", label: "MiMo (curated)", provider: "litellm" },
    { id: "shared", label: "Shared (curated)", provider: "litellm" },
  ];
  const discovered: LlmModelConfig[] = [
    { id: "shared", label: "Shared (discovered)", provider: "litellm", group: "LiteLLM" },
    { id: "sonnet", label: "Sonnet", provider: "anthropic", group: "Claude" },
  ];
  const merged = mergeModels(base, discovered);
  assert.deepEqual(merged.map((m) => m.id), ["mimo", "shared", "sonnet"]);
  // curated entry preserved (not overwritten by discovery)
  assert.equal(merged.find((m) => m.id === "shared")?.label, "Shared (curated)");
});

test("applyProviderGroups: ungrouped models inherit their provider's group", () => {
  const providers = {
    litellm: { baseUrl: "x", group: "LiteLLM" },
    anthropic: { type: "claude-sdk" as const, group: "Claude" },
    groq: { baseUrl: "y" },
  };
  const models: LlmModelConfig[] = [
    { id: "mimo", label: "MiMo", provider: "litellm" },
    { id: "sonnet", label: "Sonnet", provider: "anthropic", group: "Claude/Sonnet" },
    { id: "llama", label: "Llama", provider: "groq" },
  ];
  const out = applyProviderGroups(models, providers);
  assert.equal(out.find((m) => m.id === "mimo")?.group, "LiteLLM"); // inherited
  assert.equal(out.find((m) => m.id === "sonnet")?.group, "Claude/Sonnet"); // explicit kept
  assert.equal(out.find((m) => m.id === "llama")?.group, undefined); // provider has no group
});

function makeConfig(): LlmConfig {
  return {
    defaultProvider: "litellm",
    defaultModel: "mimo",
    providers: {
      litellm: { baseUrl: "https://litellm.example/v1", apiKeyEnv: "TEST_LLM_KEY", discover: true, group: "LiteLLM" },
      anthropic: { type: "claude-sdk", discover: true, group: "Claude (abo)" },
      groq: { baseUrl: "https://groq.example/v1" },
    },
    models: [{ id: "mimo", label: "MiMo", provider: "litellm" }],
  };
}

test("refresh discovers SDK + OpenAI models, groups them, skips default alias", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    assert.match(String(url), /litellm\.example\/v1\/models$/);
    return new Response(JSON.stringify({ data: [{ id: "mimo" }, { id: "qwen-72b" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  try {
    clearCatalogCache();
    const config = makeConfig();
    const catalog = new ModelCatalog(
      () => config,
      async () => [
        { value: "default", displayName: "Default", resolvedModel: "claude-sonnet-5" },
        { value: "sonnet", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
        { value: "haiku", displayName: "Haiku" },
      ],
    );
    let notified = 0;
    catalog.onUpdate(() => notified++);
    await catalog.refresh();

    const ids = catalog.discovered().map((m) => m.id);
    // "default" skipped; sonnet/haiku from SDK; qwen from openai (mimo deduped later by mergeModels, not here)
    assert.ok(ids.includes("sonnet"));
    assert.ok(ids.includes("haiku"));
    assert.ok(ids.includes("qwen-72b"));
    assert.ok(!ids.includes("default"));

    const sonnet = catalog.discovered().find((m) => m.id === "sonnet");
    assert.equal(sonnet?.provider, "anthropic");
    assert.equal(sonnet?.group, "Claude (abo)");
    assert.equal(sonnet?.vision, true);
    assert.equal(sonnet?.supportsEffort, true);
    assert.deepEqual(sonnet?.supportedEffortLevels, ["low", "high"]);

    const qwen = catalog.discovered().find((m) => m.id === "qwen-72b");
    assert.equal(qwen?.provider, "litellm");
    assert.equal(qwen?.group, "LiteLLM");

    assert.equal(notified, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refresh is resilient: a failing provider keeps its previous models", async () => {
  const config = makeConfig();
  // First refresh: openai fails, SDK ok.
  const originalFetch = globalThis.fetch;
  let failFetch = true;
  globalThis.fetch = (async () => {
    if (failFetch) throw new Error("network down");
    return new Response(JSON.stringify({ data: [{ id: "qwen-72b" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  try {
    clearCatalogCache();
    const catalog = new ModelCatalog(() => config, async () => [{ value: "sonnet", displayName: "Sonnet" }]);
    await catalog.refresh();
    assert.deepEqual(catalog.discovered().map((m) => m.id).sort(), ["sonnet"]);

    // Second refresh: openai now works, adds qwen; sonnet still there.
    failFetch = false;
    await catalog.refresh();
    assert.deepEqual(catalog.discovered().map((m) => m.id).sort(), ["qwen-72b", "sonnet"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enabled() false when no provider opts into discovery", () => {
  const config: LlmConfig = {
    providers: { litellm: { baseUrl: "x" } },
    models: [],
  };
  const catalog = new ModelCatalog(() => config);
  assert.equal(catalog.enabled(), false);
});

/** Routes the two discovery endpoints used by the anthropic provider tests below. */
function anthropicAwareFetch(opts: { versions?: unknown[]; versionsFail?: boolean }): typeof fetch {
  return (async (url: string) => {
    const href = String(url);
    if (href.includes("api.anthropic.com")) {
      if (opts.versionsFail) throw new Error("anthropic down");
      return new Response(JSON.stringify({ data: opts.versions ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const VERSIONED_FIXTURE = [
  {
    id: "claude-opus-4-8",
    display_name: "Claude Opus 4.8",
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: {
      effort: { supported: true, low: { supported: true }, high: { supported: true } },
      image_input: { supported: true },
    },
  },
  {
    id: "claude-sonnet-4-6",
    display_name: "Claude Sonnet 4.6",
    capabilities: { effort: { supported: false }, image_input: { supported: true } },
  },
];

test("claude-sdk provider: aliases stay at the root, versions land in family submenus", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "tok";
  globalThis.fetch = anthropicAwareFetch({ versions: VERSIONED_FIXTURE });

  try {
    clearCatalogCache();
    const config = makeConfig();
    const catalog = new ModelCatalog(() => config, async () => [
      { value: "sonnet", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "max"] },
    ]);
    await catalog.refresh();

    // The alias keeps tracking the latest, so it must not be buried in a version submenu.
    const alias = catalog.discovered().find((m) => m.id === "sonnet");
    assert.equal(alias?.group, "Claude (abo)");

    const opus = catalog.discovered().find((m) => m.id === "claude-opus-4-8");
    assert.equal(opus?.group, "Claude (abo)/Opus");
    assert.equal(opus?.label, "Opus 4.8");
    assert.equal(opus?.provider, "anthropic");
    assert.equal(opus?.supportsEffort, true);
    assert.deepEqual(opus?.supportedEffortLevels, ["low", "high"]);
    assert.deepEqual(opus?.limit, { context: 1000000, output: 128000 });

    // Effort is per model: a model that reports none must not inherit the global list.
    const sonnet46 = catalog.discovered().find((m) => m.id === "claude-sonnet-4-6");
    assert.equal(sonnet46?.group, "Claude (abo)/Sonnet");
    assert.equal(sonnet46?.supportsEffort, false);
    assert.equal(sonnet46?.supportedEffortLevels, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = originalToken;
  }
});

test("claude-sdk provider: losing the version endpoint keeps the aliases and the cached versions", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "tok";

  try {
    clearCatalogCache();
    const config = makeConfig();
    const catalog = new ModelCatalog(() => config, async () => [{ value: "sonnet", displayName: "Sonnet" }]);

    globalThis.fetch = anthropicAwareFetch({ versions: VERSIONED_FIXTURE });
    await catalog.refresh();
    assert.ok(catalog.discovered().some((m) => m.id === "claude-opus-4-8"));

    // The aliases are what make the provider usable, so they must survive on their own; the
    // previously discovered versions are kept too rather than vanishing from the menu.
    globalThis.fetch = anthropicAwareFetch({ versionsFail: true });
    await catalog.refresh();
    const ids = catalog.discovered().map((m) => m.id).sort();
    assert.deepEqual(ids, ["claude-opus-4-8", "claude-sonnet-4-6", "sonnet"]);
    assert.equal(catalog.discovered().find((m) => m.id === "claude-opus-4-8")?.group, "Claude (abo)/Opus");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = originalToken;
  }
});

test("claude-sdk provider: no token means aliases only, not a failed refresh", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = anthropicAwareFetch({ versionsFail: true });
  try {
    clearCatalogCache();
    const config = makeConfig();
    const catalog = new ModelCatalog(() => config, async () => [{ value: "sonnet", displayName: "Sonnet" }]);
    await catalog.refresh();
    assert.deepEqual(catalog.discovered().map((m) => m.id), ["sonnet"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
