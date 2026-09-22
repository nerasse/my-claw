/**
 * The family rung of the catalogue: last in, and only into what is still empty.
 *
 * The pipeline is `mergeModels -> applyProviderGroups -> applyModelWindows -> applyModelMetadata`,
 * and the family fills inside the last of those, after OpenRouter and models.dev had their say.
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { MY_CLAW_DIR, type LlmModelConfig, type LlmProviderConfig } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { ModelPricing } from "../../src/llm/pricing.ts";
import { applyModelMetadata } from "../../src/llm/catalog.ts";

const CACHE_FILE = join(MY_CLAW_DIR, "model-pricing.json");

const PROVIDERS: Record<string, LlmProviderConfig> = {
  litellm: { type: "openai", baseUrl: "https://litellm.local/v1", discover: true },
  opencode_go: { type: "openai", baseUrl: "https://opencode.ai/zen/go/v1", discover: true },
};

/** A table with an `opencode-go` row for one MiMo and nothing for the gateway. */
async function withTable(): Promise<ModelPricing> {
  mkdirSync(MY_CLAW_DIR, { recursive: true });
  rmSync(CACHE_FILE, { force: true });
  const api = {
    "opencode-go": {
      api: "https://opencode.ai/zen/go/v1",
      models: {
        "mimo-v2.5-pro": {
          name: "MiMo v2.5 Pro",
          reasoning: true,
          interleaved: { field: "reasoning_content" },
          modalities: { input: ["text"] },
          limit: { context: 1_048_576, output: 128_000 },
          cost: { input: 0.435, output: 0.87 },
        },
      },
    },
  };
  const pricing = new ModelPricing(() => PROVIDERS);
  const fetchMock = mockFetch(async () => new Response(JSON.stringify(api), { status: 200 }));
  try {
    await pricing.refresh();
  } finally {
    fetchMock.restore();
  }
  return pricing;
}

function model(over: Partial<LlmModelConfig> & { id: string }): LlmModelConfig {
  return { label: over.id, ...over };
}

test("a model no table describes gets its family's defaults", async () => {
  const pricing = await withTable();
  const [enriched] = applyModelMetadata([model({ id: "litellm/mimo-v2.6-pro", provider: "litellm" })], PROVIDERS, pricing);
  expect(enriched?.reasoningField).toBe("reasoning_content");
  expect(enriched?.limit?.output).toBe(131072);
  expect(enriched?.vision).toBe(true);
});

test("it holds with no table at all, which is the offline bootstrap", async () => {
  // The guard at the top of applyModelMetadata used to return early when neither source had data.
  const [enriched] = applyModelMetadata([model({ id: "litellm/mimo-v2.6-flash", provider: "litellm" })], PROVIDERS, undefined);
  expect(enriched?.reasoningField).toBe("reasoning_content");
  expect(enriched?.limit?.output).toBe(131072);
});

test("a declaration wins over the family", async () => {
  const pricing = await withTable();
  const [enriched] = applyModelMetadata(
    [model({ id: "litellm/mimo-v2.6-pro", provider: "litellm", reasoningField: "reasoning_details", limit: { output: 4096 } })],
    PROVIDERS,
    pricing,
  );
  expect(enriched?.reasoningField).toBe("reasoning_details");
  expect(enriched?.limit?.output).toBe(4096);
});

test("a table that describes the model wins over the family", async () => {
  const pricing = await withTable();
  const [enriched] = applyModelMetadata([model({ id: "opencode_go/mimo-v2.5-pro", provider: "opencode_go" })], PROVIDERS, pricing);
  // The table's own numbers, not the family's 131072 and its pass-back field.
  expect(enriched?.limit?.output).toBe(128000);
  expect(enriched?.reasoningField).toBe("reasoning_content");
});

test("a model outside the family is left exactly as it was", async () => {
  const pricing = await withTable();
  const before = model({ id: "litellm/qwen3.8-max", provider: "litellm" });
  const [enriched] = applyModelMetadata([before], PROVIDERS, pricing);
  expect(enriched?.reasoningField).toBeUndefined();
  expect(enriched?.limit?.output).toBeUndefined();
  expect(enriched?.vision).toBeUndefined();
});
