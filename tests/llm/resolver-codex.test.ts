import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveLlmConfig, effortOptionsFor } from "../../src/llm/resolver.ts";
import { resolveUtilityAgentLlmConfig, resolveUtilityLlmConfig } from "../../src/llm/utility-model.ts";
import type { LlmConfig } from "../../src/core/config.ts";

const config: LlmConfig = {
  defaultProvider: "fireworks",
  defaultModel: "kimi",
  effort: undefined,
  providers: {
    fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY" },
    chatgpt: { type: "codex", group: "ChatGPT (abo)" },
  },
  models: [
    { id: "kimi", label: "Kimi", provider: "fireworks" },
    { id: "gpt-5-codex", label: "GPT-5 Codex", provider: "chatgpt" },
  ],
};

test("codex provider resolves to the codex backend with the ChatGPT backend base url", () => {
  const resolved = resolveLlmConfig(config, "gpt-5-codex");
  assert.equal(resolved.backend, "codex");
  assert.equal(resolved.baseUrl, "https://chatgpt.com/backend-api");
  assert.equal(resolved.model, "gpt-5-codex");
  assert.equal(resolved.apiKey, undefined);
});

test("codex effort is native: sent without supportsEffort opt-in", () => {
  const resolved = resolveLlmConfig(config, "gpt-5-codex", "high");
  assert.equal(resolved.effort, "high");
});

test("effortOptionsFor is enabled when a codex model is present", () => {
  assert.equal(effortOptionsFor(config).enabled, true);
});

test("resolveUtilityLlmConfig keeps a codex model: the utility callers dispatch by backend now", () => {
  const codexOnlyDefault: LlmConfig = { ...config, defaultModel: "gpt-5-codex" };
  const resolved = resolveUtilityLlmConfig(codexOnlyDefault);
  // Forcing this onto chat-completions is what had a 1M-context session summarized by whichever
  // model was listed first. Codex has an HTTP transport, so it summarizes itself.
  assert.equal(resolved.backend, "codex");
  assert.equal(resolved.model, "gpt-5-codex");
});

/**
 * The browser sub-agent's resolution. Every engine has an HTTP transport now, so there is no
 * borrow ladder left to test: what it must honour is its own pin, which it was skipping altogether
 * in favour of "the first model in the catalogue".
 */
const twoChatModels: LlmConfig = {
  ...config,
  models: [
    { id: "blocked-by-the-gateway", label: "First", provider: "fireworks" },
    { id: "kimi", label: "Kimi", provider: "fireworks" },
  ],
};

test("an agent's own model wins over the first usable model in the list", () => {
  const resolved = resolveUtilityAgentLlmConfig({ defaultModel: "kimi" }, twoChatModels);
  assert.equal(resolved.model, "kimi");
});

test("an agent pinned to the subscription model keeps it: every engine runs on the home loop", () => {
  const nativePin: LlmConfig = {
    ...twoChatModels,
    providers: { ...twoChatModels.providers, anthropic: { type: "anthropic" } },
    models: [...(twoChatModels.models ?? []), { id: "claude-sonnet", label: "Sonnet", provider: "anthropic" }],
  };
  const resolved = resolveUtilityAgentLlmConfig({ defaultModel: "claude-sonnet" }, nativePin);
  assert.equal(resolved.backend, "anthropic");
  assert.equal(resolved.model, "claude-sonnet");
});
