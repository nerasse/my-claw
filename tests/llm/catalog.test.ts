import { test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ModelCatalog, mergeModels } from "../../src/llm/catalog.ts";
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
