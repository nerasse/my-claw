import { test } from "bun:test";
import assert from "node:assert/strict";
import { ModelCatalog, mergeModels, applyProviderGroups, applyModelWindows, applyModelMetadata } from "../../src/llm/catalog.ts";
import { openRouterModels, clearOpenRouterCache } from "../../src/llm/openrouter-endpoints.ts";
import type { EffortLevel, LlmConfig, LlmModelConfig } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

// The catalog is fully dynamic (no disk cache): each ModelCatalog starts empty and is populated
// by its own discovery, so tests no longer inherit each other's state through a shared file.

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

test("mergeModels: a declaration overrides field by field and keeps the rest of discovery", () => {
  const discovered: LlmModelConfig[] = [
    {
      id: "anthropic/claude-opus-5",
      label: "Opus 5",
      provider: "anthropic",
      apiId: "claude-opus-5",
      family: "Opus",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high", "max"],
      thinkingTypes: { adaptive: true, enabled: false },
      limit: { context: 1_000_000, output: 128_000 },
    },
  ];
  // The owner pins one window and nothing else. Replacing the entry outright would drop `apiId`
  // (wrong endpoint) and `thinkingTypes` (an HTTP 400 on the first request).
  const base: LlmModelConfig[] = [
    { id: "anthropic/claude-opus-5", label: "Opus 5 (200k)", limit: { context: 200_000 } },
  ];
  const merged = mergeModels(base, discovered);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.label, "Opus 5 (200k)");
  assert.equal(merged[0]?.limit?.context, 200_000);
  // Untouched fields keep following the provider.
  assert.equal(merged[0]?.limit?.output, 128_000);
  assert.equal(merged[0]?.apiId, "claude-opus-5");
  assert.equal(merged[0]?.provider, "anthropic");
  assert.deepEqual(merged[0]?.thinkingTypes, { adaptive: true, enabled: false });
  assert.deepEqual(merged[0]?.supportedEffortLevels, ["low", "high", "max"]);
});

test("mergeModels: an entry with no window and no discovered window declares none at all", () => {
  // An empty `limit` object would read as "declared" and stop the model inheriting `llm.limit`.
  const merged = mergeModels(
    [{ id: "litellm/local", label: "Local" }],
    [{ id: "litellm/local", label: "local", provider: "litellm", apiId: "local" }],
  );
  assert.equal(merged[0]?.limit, undefined);
});

test("applyProviderGroups: ungrouped models inherit their provider's group, or its key", () => {
  const providers = {
    litellm: { baseUrl: "x", group: "LiteLLM" },
    anthropic: { type: "claude-sdk" as const, group: "Claude" },
    groq: { baseUrl: "y" },
  };
  const models: LlmModelConfig[] = [
    { id: "mimo", label: "MiMo", provider: "litellm" },
    { id: "sonnet", label: "Sonnet", provider: "anthropic", group: "Claude/Sonnet" },
    { id: "llama", label: "Llama", provider: "groq" },
    { id: "orphan", label: "Orphan", provider: "gone" },
    { id: "loose", label: "Loose" },
  ];
  const out = applyProviderGroups(models, providers);
  assert.equal(out.find((m) => m.id === "mimo")?.group, "LiteLLM"); // inherited
  assert.equal(out.find((m) => m.id === "sonnet")?.group, "Claude/Sonnet"); // explicit kept
  // No group declared: the provider key is the group, so its models never spill at the root.
  assert.equal(out.find((m) => m.id === "llama")?.group, "groq");
  assert.equal(out.find((m) => m.id === "orphan")?.group, "gone"); // provider gone from config
  assert.equal(out.find((m) => m.id === "loose")?.group, undefined); // no provider: global default
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
  const mock = mockFetch(async (url?: string | URL | Request) => {
    assert.match(String(url), /litellm\.example\/v1\/models$/);
    return new Response(JSON.stringify({ data: [{ id: "mimo" }, { id: "qwen-72b" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {

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
    // "default" skipped; sonnet/haiku from SDK; qwen from openai. Every reference is qualified by
    // its provider, and carries the id that provider knows as `apiId`.
    assert.ok(ids.includes("anthropic/sonnet"));
    assert.ok(ids.includes("anthropic/haiku"));
    assert.ok(ids.includes("litellm/qwen-72b"));
    assert.ok(!ids.some((id) => id.endsWith("/default")));

    const sonnet = catalog.discovered().find((m) => m.id === "anthropic/sonnet");
    assert.equal(sonnet?.apiId, "sonnet");
    assert.equal(sonnet?.provider, "anthropic");
    assert.equal(sonnet?.group, "Claude (abo)");
    assert.equal(sonnet?.vision, true);
    assert.equal(sonnet?.supportsEffort, true);
    assert.deepEqual(sonnet?.supportedEffortLevels, ["low", "high"]);

    const qwen = catalog.discovered().find((m) => m.id === "litellm/qwen-72b");
    assert.equal(qwen?.apiId, "qwen-72b");
    assert.equal(qwen?.provider, "litellm");
    assert.equal(qwen?.group, "LiteLLM");

    assert.equal(notified, 1);
  } finally {
    mock.restore();
  }
});

test("refresh is resilient: a failing provider keeps its previous models", async () => {
  const config = makeConfig();
  // First refresh: openai fails, SDK ok.
  let failFetch = true;
  const mock = mockFetch(async () => {
    if (failFetch) throw new Error("network down");
    return new Response(JSON.stringify({ data: [{ id: "qwen-72b" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {

    const catalog = new ModelCatalog(() => config, async () => [{ value: "sonnet", displayName: "Sonnet" }]);
    await catalog.refresh();
    assert.deepEqual(catalog.discovered().map((m) => m.id).sort(), ["anthropic/sonnet"]);

    // Second refresh: openai now works, adds qwen; sonnet still there.
    failFetch = false;
    await catalog.refresh();
    assert.deepEqual(catalog.discovered().map((m) => m.id).sort(), ["anthropic/sonnet", "litellm/qwen-72b"]);
  } finally {
    mock.restore();
  }
});

test("two refreshes at once are one pass: the second joins the first", async () => {
  const config = makeConfig();
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = mockFetch(async () => {
    calls += 1;
    // Held open on purpose: the second caller has to arrive while the first is still in flight,
    // which is exactly what a button pressed during the boot pass does.
    await gate;
    return new Response(JSON.stringify({ data: [{ id: "qwen-72b" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {

    const catalog = new ModelCatalog(() => config, async () => [{ value: "sonnet", displayName: "Sonnet" }]);
    const first = catalog.refresh();
    const second = catalog.refresh();
    assert.equal(first, second, "the second call must be handed the run already in flight");
    release!();
    await Promise.all([first, second]);
    assert.equal(calls, 1, "one provider, one HTTP call, however many callers asked");

    // And once it is over, a new call really does run again: this coalesces, it does not memoize.
    await catalog.refresh();
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("answered(): only a provider that listed in full is evidence about its own catalog", async () => {
  // The distinction the model picker rests on: "answered and did not list X" means X is gone,
  // "did not answer" means nothing. Reading the second as the first empties the menu on a hiccup.
  const config = makeConfig();
  let failFetch = true;
  const mock = mockFetch(async () => {
    if (failFetch) throw new Error("network down");
    return new Response(JSON.stringify({ data: [{ id: "qwen-72b" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {

    const catalog = new ModelCatalog(() => config, async () => [{ value: "sonnet", displayName: "Sonnet" }]);
    // Before any refresh: nothing has testified, so nothing is missing.
    assert.equal(catalog.answered("litellm"), false);
    assert.equal(catalog.listedBy("litellm").size, 0);

    await catalog.refresh();
    assert.equal(catalog.answered("litellm"), false);
    assert.equal(catalog.answered("anthropic"), true);
    assert.deepEqual([...catalog.listedBy("anthropic")], ["sonnet"]);

    failFetch = false;
    await catalog.refresh();
    assert.equal(catalog.answered("litellm"), true);
    assert.deepEqual([...catalog.listedBy("litellm")], ["qwen-72b"]);

    // A provider that stops answering stops testifying: its last listing is not reusable as proof.
    failFetch = true;
    await catalog.refresh();
    assert.equal(catalog.answered("litellm"), false);
    assert.deepEqual(catalog.discovered().map((m) => m.id).sort(), ["anthropic/sonnet", "litellm/qwen-72b"]);
  } finally {
    mock.restore();
  }
});

test("answered(): half an answer from the anthropic provider is not an answer", async () => {
  const config = makeConfig();
  // The versioned endpoint is only called when a token exists; without one it returns nothing at
  // all and there is no partial failure to observe.
  const originalToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "tok";
  const mock = mockFetch(anthropicAwareFetch({ versionsFail: true }));
  try {

    const catalog = new ModelCatalog(() => config, async () => [{ value: "sonnet", displayName: "Sonnet" }]);
    await catalog.refresh();
    // The aliases arrived, the versioned list did not: the models kept are partly the previous
    // set, so this listing cannot prove a versioned model disappeared.
    assert.ok(catalog.discovered().some((m) => m.id === "anthropic/sonnet"));
    assert.equal(catalog.answered("anthropic"), false);
    // The provider that did answer is unaffected by its neighbour's half-failure.
    assert.equal(catalog.answered("litellm"), true);
  } finally {
    mock.restore();
    if (originalToken === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = originalToken;
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
function anthropicAwareFetch(opts: { versions?: unknown[]; versionsFail?: boolean }) {
  return async (url?: string | URL | Request) => {
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
  };
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

test("claude-sdk provider: aliases and pinned versions list flat, like every other provider", async () => {
  const originalToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "tok";
  const mock = mockFetch(anthropicAwareFetch({ versions: VERSIONED_FIXTURE }));

  try {

    const config = makeConfig();
    const catalog = new ModelCatalog(() => config, async () => [
      { value: "sonnet", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "max"] },
    ]);
    await catalog.refresh();

    // One group per provider, no submenu: the label is what tells the moving alias from the
    // pinned versions.
    const alias = catalog.discovered().find((m) => m.id === "anthropic/sonnet");
    assert.equal(alias?.group, "Claude (abo)");
    assert.equal(alias?.label, "Sonnet (auto)");
    // The aliases still come first, so the list opens on the auto-tracking entries.
    const ids = catalog.discovered().map((m) => m.id);
    assert.ok(ids.indexOf("anthropic/sonnet") < ids.indexOf("anthropic/claude-sonnet-4-6"));

    const opus = catalog.discovered().find((m) => m.id === "anthropic/claude-opus-4-8");
    assert.equal(opus?.group, "Claude (abo)");
    assert.equal(opus?.label, "Opus 4.8");
    assert.equal(opus?.provider, "anthropic");
    assert.equal(opus?.supportsEffort, true);
    assert.deepEqual(opus?.supportedEffortLevels, ["low", "high"]);
    assert.deepEqual(opus?.limit, { context: 1000000, output: 128000 });

    // Effort is per model: a model that reports none must not inherit the global list.
    const sonnet46 = catalog.discovered().find((m) => m.id === "anthropic/claude-sonnet-4-6");
    assert.equal(sonnet46?.group, "Claude (abo)");
    assert.equal(sonnet46?.supportsEffort, false);
    assert.equal(sonnet46?.supportedEffortLevels, undefined);
  } finally {
    mock.restore();
    if (originalToken === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = originalToken;
  }
});

test("claude-sdk provider: losing the version endpoint keeps the aliases and the cached versions", async () => {
  const originalToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "tok";
  let mock: { restore(): void } | undefined;

  try {

    const config = makeConfig();
    const catalog = new ModelCatalog(() => config, async () => [{ value: "sonnet", displayName: "Sonnet" }]);

    mock = mockFetch(anthropicAwareFetch({ versions: VERSIONED_FIXTURE }));
    await catalog.refresh();
    assert.ok(catalog.discovered().some((m) => m.id === "anthropic/claude-opus-4-8"));

    // The aliases are what make the provider usable, so they must survive on their own; the
    // previously discovered versions are kept too rather than vanishing from the menu.
    mock.restore();
    mock = mockFetch(anthropicAwareFetch({ versionsFail: true }));
    await catalog.refresh();
    const ids = catalog.discovered().map((m) => m.id).sort();
    assert.deepEqual(ids, ["anthropic/claude-opus-4-8", "anthropic/claude-sonnet-4-6", "anthropic/sonnet"]);
    assert.equal(catalog.discovered().find((m) => m.id === "anthropic/claude-opus-4-8")?.group, "Claude (abo)");
  } finally {
    mock?.restore();
    if (originalToken === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = originalToken;
  }
});

test("claude-sdk provider: no token means aliases only, not a failed refresh", async () => {
  const mock = mockFetch(anthropicAwareFetch({ versionsFail: true }));
  try {

    const config = makeConfig();
    const catalog = new ModelCatalog(() => config, async () => [{ value: "sonnet", displayName: "Sonnet" }]);
    await catalog.refresh();
    assert.deepEqual(catalog.discovered().map((m) => m.id), ["anthropic/sonnet"]);
  } finally {
    mock.restore();
  }
});

test("claude-sdk provider: an alias is marked (auto) only when its family is known", async () => {
  const originalToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "tok";
  const mock = mockFetch(anthropicAwareFetch({ versions: VERSIONED_FIXTURE }));

  try {

    const config = makeConfig();
    const catalog = new ModelCatalog(() => config, async () => [
      { value: "default", displayName: "Default" },
      { value: "opus[1m]", displayName: "Opus (1M context)" },
      { value: "mystery", displayName: "Mystery" },
    ]);
    await catalog.refresh();

    // A variant marker names the same family as the plain alias, so it tracks a family too.
    const variant = catalog.discovered().find((m) => m.id === "anthropic/opus[1m]");
    assert.equal(variant?.group, "Claude (abo)");
    assert.equal(variant?.label, "Opus (1M context) (auto)");
    // An alias the versioned list knows nothing about tracks nothing: no "(auto)" on it.
    const mystery = catalog.discovered().find((m) => m.id === "anthropic/mystery");
    assert.equal(mystery?.group, "Claude (abo)");
    assert.equal(mystery?.label, "Mystery");
    // "default" resolves to another listed model, so it stays out of the menu.
    assert.ok(!catalog.discovered().some((m) => m.apiId === "default"));
  } finally {
    mock.restore();
    if (originalToken === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = originalToken;
  }
});

/**
 * Window enrichment runs at boot in the same pass as the provider groups, so everything downstream
 * reads a populated `limit.context` without the price table being threaded through it.
 * See docs/context-window.md.
 */
const windowTable = { contextWindowOf: (id: string) => (id === "known" ? { tokens: 400_000 } : undefined) };

test("an OpenRouter model's exact metadata fills gaps before models.dev, including a pinned endpoint", async () => {
  clearOpenRouterCache();
  const mock = mockFetch(async () => new Response(JSON.stringify({ data: [{
    id: "vendor/model:batch",
    name: "OpenRouter Model",
    context_length: 999_999,
    architecture: { input_modalities: ["text", "image"] },
    pricing: {},
    top_provider: { context_length: 222_222, max_completion_tokens: 12_345 },
    supported_parameters: ["reasoning"],
    reasoning: { mandatory: false, supported_efforts: ["low", "high"] },
  }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
  try {
    await openRouterModels();
    const providers = { openrouter: { baseUrl: "https://gateway.openrouter.ai/api/v1" } };
    const source = [{ id: "vendor/model:batch", apiId: "vendor/model:batch", label: "vendor/model:batch", provider: "openrouter" }];
    const fallback = {
      contextWindowOf: () => ({ tokens: 111_111 }),
      metadataOf: () => ({ source: "models.dev" as const, label: "models.dev label", effortLevels: ["max"] as EffortLevel[], vision: false, outputLimit: 1 }),
    };
    const [windowed] = applyModelWindows(source, providers, fallback);
    assert.equal(windowed?.limit?.context, 222_222);
    assert.equal(windowed?.contextFrom, "openrouter");
    // A selected endpoint is decoration on the reference, never a different model id.
    const [pinned] = applyModelWindows([{ ...source[0]!, id: "vendor/model:batch@azure/eu", apiId: "vendor/model:batch@azure/eu" }], providers, fallback);
    assert.equal(pinned?.limit?.context, 222_222);
    const [enriched] = applyModelMetadata(windowed ? [windowed] : [], providers, fallback);
    assert.equal(enriched?.label, "OpenRouter Model");
    assert.equal(enriched?.limit?.output, 12_345);
    assert.equal(enriched?.vision, true);
    assert.deepEqual(enriched?.supportedEffortLevels, ["none", "low", "high"]);
  } finally {
    mock.restore();
    clearOpenRouterCache();
  }
});

test("a model with no declared window gets one from the table, tagged with its provenance", () => {
  const out = applyModelWindows([{ id: "known", label: "Known", provider: "p" }], {}, windowTable);
  assert.equal(out[0]?.limit?.context, 400_000);
  // Without the tag, /status could not tell a curated number from a third-party one.
  assert.equal(out[0]?.contextFrom, "models.dev");
});

test("a declared window is never overwritten, because config outranks a third party", () => {
  const out = applyModelWindows([{ id: "known", label: "Known", limit: { context: 123, output: 456 } }], {}, windowTable);
  assert.deepEqual(out[0]?.limit, { context: 123, output: 456 });
  assert.equal(out[0]?.contextFrom, undefined);
});

test("a model the table cannot answer is left untouched, to fall back on the default later", () => {
  const out = applyModelWindows([{ id: "mystery", label: "Mystery" }], {}, windowTable);
  assert.equal(out[0]?.limit?.context, undefined);
  assert.equal(out[0]?.contextFrom, undefined);
});

test("with no table at all the list passes through unchanged, so boot works offline", () => {
  const models = [{ id: "known", label: "Known" }];
  assert.equal(applyModelWindows(models, {}, undefined), models);
});

test("an output limit declared alone survives the context fill", () => {
  const out = applyModelWindows([{ id: "known", label: "Known", limit: { output: 8192 } }], {}, windowTable);
  assert.deepEqual(out[0]?.limit, { output: 8192, context: 400_000 });
});
