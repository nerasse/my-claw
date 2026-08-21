import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { resolveUtilityLlmConfig, resolveUtilityAgentLlmConfig } from "../../src/llm/utility-model.ts";
import { setAvailabilityWorld, resetAvailabilityWorld } from "../../src/llm/world.ts";
import type { AvailabilityWorld } from "../../src/llm/run-model.ts";
import type { LlmConfig } from "../../src/core/config.ts";

afterEach(() => {
  resetAvailabilityWorld();
});

/**
 * Every engine runs on the home loop now, so a utility call never has to borrow another model: the
 * session's own model answers, whatever its backend. These tests pin that down, because the old
 * borrow ladder existed only to route around the SDK's session-owning subprocess.
 */
const house: LlmConfig = {
  defaultProvider: "anthropic",
  defaultModel: "anthropic/claude-opus-5",
  providers: {
    anthropic: { type: "anthropic" },
    litellm: { baseUrl: "https://litellm.example/v1", apiKeyEnv: "LITELLM_API_KEY" },
  },
  models: [
    { id: "litellm/tiny-local", label: "Tiny", provider: "litellm", apiId: "tiny-local" },
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

test("an anthropic session summarizes itself on the native transport", () => {
  setAvailabilityWorld(() => world());
  const resolved = resolveUtilityLlmConfig(house);
  // Same model, same subscription, an HTTP transport: Opus summarizes Opus. The local model at the
  // top of the list is what used to answer, and it is what made a compacted Opus session read
  // like a different assistant had written the summary.
  assert.equal(resolved.backend, "anthropic");
  assert.equal(resolved.model, "anthropic/claude-opus-5");
});

test("an explicit pin is kept, never traded for the default or the first in the list", () => {
  setAvailabilityWorld(() => world());
  const resolved = resolveUtilityLlmConfig(house, "litellm/tiny-local");
  assert.equal(resolved.model, "litellm/tiny-local");
  assert.equal(resolved.backend, undefined);
});

test("the default answers when nothing is pinned, whatever declaration order says", () => {
  setAvailabilityWorld(() => world());
  const preferred: LlmConfig = { ...house, defaultModel: "litellm/tiny-local" };
  assert.equal(resolveUtilityLlmConfig(preferred).model, "litellm/tiny-local");
});

test("an agent's own model is honoured over the global default", () => {
  setAvailabilityWorld(() => world());
  const resolved = resolveUtilityAgentLlmConfig({ defaultModel: "litellm/tiny-local" }, house);
  assert.equal(resolved.model, "litellm/tiny-local");
  // And an agent pinned to the subscription model keeps the native transport.
  const native = resolveUtilityAgentLlmConfig({ defaultModel: "anthropic/claude-opus-5" }, house);
  assert.equal(native.backend, "anthropic");
  assert.equal(native.model, "anthropic/claude-opus-5");
});
