import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { MY_CLAW_DIR, type LlmModelConfig, type LlmProviderConfig } from "../../src/core/config.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { ModelPricing, CACHE_VERSION, effortLadderOf } from "../../src/llm/pricing.ts";
import { applyModelMetadata } from "../../src/llm/catalog.ts";
import { EFFORT_LEVELS } from "../../src/llm/resolver.ts";
import { toSdkEffort } from "../../src/agent/claude-sdk/backend.ts";

/**
 * Capabilities for providers that answer with ids and nothing else -- docs/model-metadata.md.
 *
 * The fixture is the shape that actually caused this work: `opencode-go` and `opencode` are two
 * models.dev providers on one host, publishing different prices and different reasoning shapes for
 * the same model ids, while the local provider is keyed `opencode_go`.
 */
const CACHE_FILE = join(MY_CLAW_DIR, "model-pricing.json");

/** The four shapes measured in the live file, plus the junk it carries. */
function rawApi(): Record<string, unknown> {
  return {
    "opencode-go": {
      api: "https://opencode.ai/zen/go/v1",
      models: {
        "deepseek-v4-flash": {
          name: "DeepSeek V4 Flash (2x usage)",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["max", "low", "high"] }],
          modalities: { input: ["text"] },
          limit: { context: 1_000_000, output: 384_000 },
          cost: { input: 0.07, output: 0.14, cache_read: 0.0014 },
        },
        "qwen3.7-max": {
          name: "Qwen3.7 Max",
          reasoning: true,
          reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 1024, max: 38_912 }],
          modalities: { input: ["text", "image"] },
          limit: { context: 262_144 },
        },
        "kimi-k2.5": {
          name: "Kimi K2.5",
          reasoning: true,
          modalities: { input: ["text"] },
          limit: { context: 262_144 },
        },
        "junk-model": {
          name: "Junk",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["default", null, "high"] }],
        },
      },
    },
    // The same ids, resold at twice the price with a different reasoning shape. First-wins by host
    // would answer with whichever of the two the file happens to list first.
    opencode: {
      api: "https://opencode.ai/zen/v1",
      models: {
        "deepseek-v4-flash": {
          name: "DeepSeek V4 Flash",
          reasoning: true,
          reasoning_options: [{ type: "toggle" }],
          limit: { context: 1_000_000 },
          cost: { input: 0.14, output: 0.28, cache_read: 0.028 },
        },
      },
    },
    xiaomi: {
      api: "https://api.xiaomimimo.com/v1",
      models: { "mimo-v2.5-pro": { name: "MiMo v2.5 Pro", cost: { input: 0.435, output: 0.87 } } },
    },
    // Deliberately without an `api`, as the live file has it: models.dev describes Anthropic's own
    // models while publishing an endpoint only for the resellers. Nothing can resolve this provider
    // by host, which is why the vendor is named by the engine instead.
    anthropic: {
      models: {
        "claude-opus-5": {
          name: "Claude Opus 5",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
          modalities: { input: ["text", "image"] },
          limit: { context: 1_000_000, output: 128_000 },
          cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        },
      },
    },
  };
}

const PROVIDERS: Record<string, LlmProviderConfig> = {
  opencode_go: { type: "openai", baseUrl: "https://opencode.ai/zen/go/v1", discover: true },
};

/** A pricing table built through the real compaction, so the filtering rules are exercised. */
async function withApi(
  declared: Record<string, { baseUrl?: string; pricingProvider?: string }> = { opencode_go: { baseUrl: "https://opencode.ai/zen/go/v1" } },
  /** Key order of the upstream file, which is what the host rung silently depends on. */
  order: "go-first" | "go-last" = "go-first",
): Promise<ModelPricing> {
  mkdirSync(MY_CLAW_DIR, { recursive: true });
  rmSync(CACHE_FILE, { force: true });
  const raw = rawApi();
  const api =
    order === "go-first"
      ? raw
      : Object.fromEntries(Object.entries(raw).sort(([a], [b]) => (a === "opencode-go" ? 1 : b === "opencode-go" ? -1 : 0)));
  const pricing = new ModelPricing(() => declared);
  const fetchMock = mockFetch(async () => new Response(JSON.stringify(api), { status: 200 }));
  try {
    await pricing.refresh();
  } finally {
    fetchMock.restore();
  }
  return pricing;
}

function model(over: Partial<LlmModelConfig> & { id: string }): LlmModelConfig {
  return { label: over.id, provider: "opencode_go", ...over };
}

test("a published effort ladder is offered verbatim, not our fallback list", async () => {
  const pricing = await withApi();
  const [enriched] = applyModelMetadata([model({ id: "deepseek-v4-flash" })], PROVIDERS, pricing);
  // Criterion 1: exactly what the model publishes, ordered bottom-up whatever order it was written.
  expect(enriched?.supportedEffortLevels).toEqual(["low", "high", "max"]);
  expect(enriched?.supportsEffort).toBe(true);
  // Criterion 1 again, from the other side: the six-rung fallback must not leak in.
  expect(enriched?.supportedEffortLevels).not.toContain("medium");
});

test("a toggle-only model offers two rungs, and a token budget is never one of them", async () => {
  const pricing = await withApi();
  const [enriched] = applyModelMetadata([model({ id: "qwen3.7-max" })], PROVIDERS, pricing);
  // Criterion 2. Measured on the live gateway: `reasoning_effort` is honoured by these models even
  // though they publish a switch rather than a ladder.
  expect(enriched?.supportedEffortLevels).toEqual(["none", "high"]);
  expect(enriched?.supportedEffortLevels).not.toContain("budget_tokens");
});

test("reasoning with no published ladder yields no effort step at all", async () => {
  const pricing = await withApi();
  const [enriched] = applyModelMetadata([model({ id: "kimi-k2.5" })], PROVIDERS, pricing);
  // Criterion 3: the honest answer is silence, not a guessed ladder.
  expect(enriched?.supportsEffort).toBeUndefined();
  expect(enriched?.supportedEffortLevels).toBeUndefined();
  // The rest of the entry still lands.
  expect(enriched?.label).toBe("Kimi K2.5");
});

test("a level outside the vocabulary never reaches a menu", async () => {
  const pricing = await withApi();
  const [enriched] = applyModelMetadata([model({ id: "junk-model" })], PROVIDERS, pricing);
  // Criterion 4: the live file carries one "default" and two nulls.
  expect(enriched?.supportedEffortLevels).toEqual(["high"]);
});

test("a subscription provider is described even though it declares no endpoint", async () => {
  const pricing = await withApi();
  // What the config actually holds: a type, a discovery flag, and no baseUrl. Reading the declared
  // field here returned undefined, so the gap-fill skipped the three subscription providers -- the
  // ones whose own discovery says the least. The effective endpoint is what names the vendor.
  const providers: Record<string, LlmProviderConfig> = {
    anthropic: { type: "anthropic", discover: true },
    "claude-sdk": { type: "claude-sdk", discover: true },
  };
  const models = [
    { id: "claude-opus-5", label: "claude-opus-5", provider: "anthropic" },
    { id: "claude-opus-5", label: "claude-opus-5", provider: "claude-sdk" },
  ];
  for (const enriched of applyModelMetadata(models, providers, pricing)) {
    expect(enriched.label).toBe("Claude Opus 5");
    expect(enriched.limit?.output).toBe(128_000);
    expect(enriched.supportedEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(enriched.vision).toBe(true);
  }
});

test("effortLadderOf: an effort entry outranks a toggle on the same model", () => {
  expect(effortLadderOf({ reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "max"] }] })).toEqual({
    levels: ["low", "max"],
    toggle: true,
  });
  expect(effortLadderOf({ reasoning_options: [{ type: "budget_tokens" }] })).toEqual({ toggle: false });
  expect(effortLadderOf({})).toEqual({ toggle: false });
});

test("the fallback list stays narrow: no rung is offered on no evidence", () => {
  // Criterion 5. This list reaches every model no source describes, across every provider, so a
  // rung added here is a rung claimed for models that never published one.
  expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  expect(EFFORT_LEVELS).not.toContain("none");
  expect(EFFORT_LEVELS).not.toContain("minimal");
});

test("the SDK ladder has no bottom, so the rungs below it clamp instead of being dropped", () => {
  // Criterion 6: dropping the parameter would land on the SDK's own default of "high", the
  // opposite of what "none" asked for.
  expect(toSdkEffort("none")).toBe("low");
  expect(toSdkEffort("minimal")).toBe("low");
  expect(toSdkEffort("ultra")).toBe("max");
  expect(toSdkEffort("high")).toBe("high");
  expect(toSdkEffort(undefined)).toBeUndefined();
});

test("a provider is matched by name, whatever separators the key uses", async () => {
  // Criterion 7: all three spellings reach models.dev's `opencode-go`.
  for (const key of ["opencode_go", "opencodego", "OpenCode-Go"]) {
    const pricing = await withApi({ [key]: { baseUrl: "https://opencode.ai/zen/go/v1" } });
    const meta = pricing.metadataOf("deepseek-v4-flash", "https://opencode.ai/zen/go/v1");
    expect(meta?.label).toBe("DeepSeek V4 Flash (2x usage)");
    expect(meta?.source).toContain("key opencode-go");
  }
});

test("an explicit pricingProvider outranks the name and the host", async () => {
  const pricing = await withApi({ opencode_go: { baseUrl: "https://opencode.ai/zen/go/v1", pricingProvider: "opencode" } });
  const meta = pricing.metadataOf("deepseek-v4-flash", "https://opencode.ai/zen/go/v1");
  expect(meta?.label).toBe("DeepSeek V4 Flash");
  expect(meta?.source).toContain("declared opencode");
});

const CALL = { model: "deepseek-v4-flash", promptTokens: 1_000_000, completionTokens: 0 };
const GO_URL = "https://opencode.ai/zen/go/v1";

test("the price follows the same ladder as the metadata", async () => {
  const pricing = await withApi();
  const cost = pricing.costOf({ ...CALL, baseUrl: GO_URL });
  expect(cost?.usd).toBeCloseTo(0.07, 6);
  expect(cost?.source).toContain("key opencode-go");
});

test("a neighbour on the same host cannot double the bill by being listed first", async () => {
  // Criterion 8. 0.07 is opencode-go's price and 0.14 is opencode's, for the same id on one host.
  // The host rung answers with whichever the upstream file lists first, so without the name rung
  // the amount billed depends on the key order of a 3.3 MB document we do not control.
  const pricing = await withApi(undefined, "go-last");
  const cost = pricing.costOf({ ...CALL, baseUrl: GO_URL });
  expect(cost?.usd).toBeCloseTo(0.07, 6);
  // The capability half comes from the same rung: `opencode` publishes a toggle for this model,
  // `opencode-go` publishes the real ladder, and reading the wrong one offers the wrong menu.
  expect(pricing.metadataOf("deepseek-v4-flash", GO_URL)?.effortLevels).toEqual(["low", "high", "max"]);
});

test("an unknown host still resolves nothing, rather than borrowing a neighbour's table", async () => {
  const pricing = await withApi({ elsewhere: { baseUrl: "https://unknown.example/v1" } });
  expect(pricing.metadataOf("deepseek-v4-flash", "https://unknown.example/v1")).toBeUndefined();
});

test("enrichment fills gaps and never overwrites what is already known", async () => {
  const pricing = await withApi();
  const declared = model({
    id: "deepseek-v4-flash",
    label: "My own name",
    supportsEffort: false,
    vision: true,
    limit: { context: 42, output: 99 },
  });
  const [kept] = applyModelMetadata([declared], PROVIDERS, pricing);
  // Criterion 9: a community database outranks neither the owner nor a provider that answers for
  // its own models.
  expect(kept?.label).toBe("My own name");
  expect(kept?.supportsEffort).toBe(false);
  expect(kept?.supportedEffortLevels).toBeUndefined();
  expect(kept?.vision).toBe(true);
  expect(kept?.limit).toEqual({ context: 42, output: 99 });
});

test("a label equal to the id is a gap, because that is what discovery leaves behind", async () => {
  const pricing = await withApi();
  const [enriched] = applyModelMetadata([model({ id: "qwen3.7-max" })], PROVIDERS, pricing);
  expect(enriched?.label).toBe("Qwen3.7 Max");
  // The other half of the same entry, from the same lookup.
  expect(enriched?.vision).toBe(true);
  expect(enriched?.limit?.output).toBeUndefined();
});

test("the output limit lands only when published, and the window is left alone", async () => {
  const pricing = await withApi();
  const [enriched] = applyModelMetadata([model({ id: "deepseek-v4-flash", limit: { context: 500 } })], PROVIDERS, pricing);
  expect(enriched?.limit).toEqual({ context: 500, output: 384_000 });
});

test("no table means no enrichment, and no crash", () => {
  const models = [model({ id: "deepseek-v4-flash" })];
  expect(applyModelMetadata(models, PROVIDERS, undefined)).toBe(models);
});

test("a stale cache shape is ignored rather than half-read", async () => {
  mkdirSync(MY_CLAW_DIR, { recursive: true });
  writeFileSync(
    CACHE_FILE,
    JSON.stringify({ version: CACHE_VERSION - 1, fetchedAt: new Date().toISOString(), hosts: {}, models: { "opencode-go": {} } }),
  );
  const stale = new ModelPricing(() => ({ opencode_go: { baseUrl: "https://opencode.ai/zen/go/v1" } }));
  expect(stale.ready()).toBe(false);
  expect(stale.metadataOf("deepseek-v4-flash", "https://opencode.ai/zen/go/v1")).toBeUndefined();
});
