import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { resolveUtilityLlmConfig, resolveUtilityAgentLlmConfig } from "../../src/llm/utility-model.ts";
import { setAvailabilityWorld, resetAvailabilityWorld } from "../../src/llm/world.ts";
import type { AvailabilityWorld } from "../../src/llm/run-model.ts";
import type { LlmConfig } from "../../src/core/config.ts";

afterEach(() => {
  resetAvailabilityWorld();
});

/** A house with both halves of the Claude subscription declared, which is the shipped shape. */
const bothHalves: LlmConfig = {
  defaultProvider: "claude-sdk",
  defaultModel: "claude-sdk/claude-opus-5",
  providers: {
    "claude-sdk": { type: "claude-sdk" },
    anthropic: { type: "anthropic" },
    litellm: { baseUrl: "https://litellm.example/v1", apiKeyEnv: "LITELLM_API_KEY" },
  },
  models: [
    { id: "litellm/tiny-local", label: "Tiny", provider: "litellm", apiId: "tiny-local" },
    { id: "claude-sdk/claude-opus-5", label: "Opus 5", provider: "claude-sdk", apiId: "claude-opus-5" },
    { id: "anthropic/claude-opus-5", label: "Opus 5", provider: "anthropic", apiId: "claude-opus-5" },
  ],
};

/** Everything declared is runnable and no provider has testified: the permissive default. */
function world(overrides: Partial<AvailabilityWorld> = {}): AvailabilityWorld {
  return {
    answered: () => false,
    listedBy: () => new Set(),
    hasEnv: () => true,
    claudeAuth: true,
    codexAuth: true,
    ...overrides,
  };
}

test("an SDK session borrows its own model on the native transport, not the first in the list", () => {
  setAvailabilityWorld(() => world());
  const resolved = resolveUtilityLlmConfig(bothHalves);
  // Same model, same subscription, an HTTP transport: Opus summarizes Opus. The local 35B at the
  // top of the list is what used to answer, and it is what made a compacted Opus session read
  // like a different assistant had written the summary.
  assert.equal(resolved.backend, "anthropic");
  assert.equal(resolved.model, "anthropic/claude-opus-5");
});

test("an alias pin has no twin of its own, so it inherits the default's", () => {
  setAvailabilityWorld(() => world());
  const aliased: LlmConfig = {
    ...bothHalves,
    models: [...(bothHalves.models ?? []), { id: "claude-sdk/opus", label: "Opus", provider: "claude-sdk", apiId: "opus" }],
  };
  // `opus` is resolved server-side by the SDK and no /v1/models lists it, so there is nothing to
  // match on and the twin rule must not guess a version. The default is versioned, so its twin is.
  assert.equal(resolveUtilityLlmConfig(aliased, "claude-sdk/opus").model, "anthropic/claude-opus-5");
});

test("when neither the pin nor the default has a twin, the list answers", () => {
  setAvailabilityWorld(() => world());
  const aliasedDefault: LlmConfig = {
    ...bothHalves,
    defaultModel: "claude-sdk/opus",
    models: [...(bothHalves.models ?? []), { id: "claude-sdk/opus", label: "Opus", provider: "claude-sdk", apiId: "opus" }],
  };
  assert.equal(resolveUtilityLlmConfig(aliasedDefault).model, "litellm/tiny-local");
});

test("the default model wins over declaration order", () => {
  setAvailabilityWorld(() => world());
  const httpDefault: LlmConfig = {
    ...bothHalves,
    providers: { "claude-sdk": { type: "claude-sdk" }, litellm: { baseUrl: "https://litellm.example/v1" } },
    defaultModel: "claude-sdk/claude-opus-5",
    models: [
      { id: "litellm/tiny-local", label: "Tiny", provider: "litellm" },
      { id: "litellm/the-one-i-chose", label: "Chosen", provider: "litellm" },
      { id: "claude-sdk/claude-opus-5", label: "Opus 5", provider: "claude-sdk", apiId: "claude-opus-5" },
    ],
  };
  // No anthropic provider here, so no twin; the default is SDK-backed and cannot serve, but the
  // owner's second choice is not "whatever is first".
  const preferred: LlmConfig = { ...httpDefault, defaultModel: "litellm/the-one-i-chose" };
  assert.equal(resolveUtilityLlmConfig(preferred).model, "litellm/the-one-i-chose");
});

test("a model the provider no longer lists is skipped, not called", () => {
  // litellm answered and lists only the renamed model: the declared id is gone, and calling it
  // would be an HTTP 400 on every compaction.
  setAvailabilityWorld(() =>
    world({
      answered: (provider) => provider === "litellm",
      listedBy: (provider) => (provider === "litellm" ? new Set(["tiny-local-v2"]) : new Set()),
    }),
  );
  const stale: LlmConfig = {
    defaultProvider: "claude-sdk",
    defaultModel: "claude-sdk/claude-opus-5",
    providers: {
      "claude-sdk": { type: "claude-sdk" },
      litellm: { baseUrl: "https://litellm.example/v1" },
    },
    models: [
      { id: "litellm/tiny-local", label: "Gone", provider: "litellm", apiId: "tiny-local" },
      { id: "litellm/tiny-local-v2", label: "Renamed", provider: "litellm", apiId: "tiny-local-v2" },
      { id: "claude-sdk/claude-opus-5", label: "Opus 5", provider: "claude-sdk", apiId: "claude-opus-5" },
    ],
  };
  assert.equal(resolveUtilityLlmConfig(stale).model, "litellm/tiny-local-v2");
});

test("a default pointing at nothing is skipped like any other unusable candidate", () => {
  setAvailabilityWorld(() => world());
  const danglingDefault: LlmConfig = {
    defaultProvider: "claude-sdk",
    defaultModel: "claude-sdk/claude-opus-5",
    providers: { "claude-sdk": { type: "claude-sdk" }, litellm: { baseUrl: "https://litellm.example/v1" } },
    models: [
      { id: "litellm/tiny-local", label: "Tiny", provider: "litellm" },
      { id: "claude-sdk/claude-opus-5", label: "Opus 5", provider: "claude-sdk", apiId: "claude-opus-5" },
    ],
  };
  const broken: LlmConfig = { ...danglingDefault, defaultModel: "typed-this-by-hand" };
  assert.equal(resolveUtilityLlmConfig(broken).model, "litellm/tiny-local");
});

test("nothing runnable is an error, not a silent call to a dead model", () => {
  setAvailabilityWorld(() =>
    world({
      answered: (provider) => provider === "litellm",
      listedBy: () => new Set(["something-else"]),
    }),
  );
  const allGone: LlmConfig = {
    defaultProvider: "claude-sdk",
    defaultModel: "claude-sdk/claude-opus-5",
    providers: { "claude-sdk": { type: "claude-sdk" }, litellm: { baseUrl: "https://litellm.example/v1" } },
    models: [
      { id: "litellm/tiny-local", label: "Gone", provider: "litellm", apiId: "tiny-local" },
      { id: "claude-sdk/claude-opus-5", label: "Opus 5", provider: "claude-sdk", apiId: "claude-opus-5" },
    ],
  };
  assert.throws(() => resolveUtilityLlmConfig(allGone), /HTTP transport/);
});

test("an agent pinned to an SDK model gets the twin too", () => {
  setAvailabilityWorld(() => world());
  const resolved = resolveUtilityAgentLlmConfig({ defaultModel: "claude-sdk/claude-opus-5" }, bothHalves);
  assert.equal(resolved.backend, "anthropic");
  assert.equal(resolved.model, "anthropic/claude-opus-5");
});
