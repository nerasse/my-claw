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

test("resolveUtilityLlmConfig throws only when every model is claude-sdk backed", () => {
  const sdkOnly: LlmConfig = {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet",
    providers: { anthropic: { type: "claude-sdk" } },
    models: [{ id: "claude-sonnet", label: "Sonnet", provider: "anthropic" }],
  };
  // The one backend with no request to send: a subprocess owning its own session.
  assert.throws(() => resolveUtilityLlmConfig(sdkOnly), /HTTP transport/);
});

/**
 * The browser sub-agent's resolution. It runs on the home loop, so it cannot run the claude-sdk
 * default of this house; what it must still honour is its own pin, which it was skipping altogether
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

test("a claude-sdk default still falls back, and the agent pin is what it falls back from", () => {
  const sdkDefault: LlmConfig = {
    ...twoChatModels,
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet",
    providers: { ...twoChatModels.providers, anthropic: { type: "claude-sdk" } },
    models: [...(twoChatModels.models ?? []), { id: "claude-sonnet", label: "Sonnet", provider: "anthropic" }],
  };
  // No pin: the global default is unusable here, so the first usable model is taken.
  assert.equal(resolveUtilityAgentLlmConfig(undefined, sdkDefault).model, "blocked-by-the-gateway");
  // Pinned: the pin is used as it stands.
  assert.equal(resolveUtilityAgentLlmConfig({ defaultModel: "kimi" }, sdkDefault).model, "kimi");
});

test("an agent pinned to a claude-sdk model falls back rather than breaking the loop", () => {
  const sdkPin: LlmConfig = {
    ...twoChatModels,
    providers: { ...twoChatModels.providers, anthropic: { type: "claude-sdk" } },
    models: [...(twoChatModels.models ?? []), { id: "claude-sonnet", label: "Sonnet", provider: "anthropic" }],
  };
  const resolved = resolveUtilityAgentLlmConfig({ defaultModel: "claude-sonnet" }, sdkPin);
  assert.equal(resolved.backend, undefined);
  assert.equal(resolved.model, "blocked-by-the-gateway");
});

test("declaration order decides only once the preferred candidates are out", () => {
  // The default is claude-sdk and there is no anthropic provider to twin with, so nothing is
  // preferred and the list order is all that is left. It is still stated, because it is still what
  // answers in that case.
  const sdkDefault: LlmConfig = {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet",
    providers: {
      anthropic: { type: "claude-sdk" },
      fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1" },
    },
    models: [
      { id: "tiny-local", label: "Tiny", provider: "fireworks" },
      { id: "the-big-one", label: "Big", provider: "fireworks" },
      { id: "claude-sonnet", label: "Sonnet", provider: "anthropic" },
    ],
  };
  assert.equal(resolveUtilityLlmConfig(sdkDefault).model, "tiny-local");
  const reordered: LlmConfig = { ...sdkDefault, models: [...(sdkDefault.models ?? [])].reverse() };
  // Same models, same providers: only the order moved, and the answer moved with it.
  assert.equal(resolveUtilityLlmConfig(reordered).model, "the-big-one");
});
