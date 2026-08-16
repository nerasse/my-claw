import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  resolveLlmConfig,
  resolveOpenAiAgentLlmConfig,
  resolveOpenAiLlmConfig,
  effortOptionsFor,
} from "../../src/llm/resolver.ts";
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

test("resolveOpenAiLlmConfig skips codex models and falls back to a chat-completions model", () => {
  const codexOnlyDefault: LlmConfig = { ...config, defaultModel: "gpt-5-codex" };
  const resolved = resolveOpenAiLlmConfig(codexOnlyDefault);
  assert.equal(resolved.backend, undefined);
  assert.equal(resolved.model, "kimi");
});

test("resolveOpenAiLlmConfig throws when every model is codex or claude-sdk backed", () => {
  const noChat: LlmConfig = {
    defaultProvider: "chatgpt",
    defaultModel: "gpt-5-codex",
    providers: { chatgpt: { type: "codex" } },
    models: [{ id: "gpt-5-codex", label: "GPT-5 Codex", provider: "chatgpt" }],
  };
  assert.throws(() => resolveOpenAiLlmConfig(noChat), /No OpenAI-compatible model/);
});

/**
 * The browser sub-agent's resolution. It speaks chat-completions, so it cannot run the
 * claude-sdk default of this house; what it must still honour is its own pin, which it was
 * skipping altogether in favour of "the first model in the catalogue".
 */
const twoChatModels: LlmConfig = {
  ...config,
  models: [
    { id: "blocked-by-the-gateway", label: "First", provider: "fireworks" },
    { id: "kimi", label: "Kimi", provider: "fireworks" },
  ],
};

test("an agent's own model wins over the first chat-completions model in the list", () => {
  const resolved = resolveOpenAiAgentLlmConfig({ defaultModel: "kimi" }, twoChatModels);
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
  assert.equal(resolveOpenAiAgentLlmConfig(undefined, sdkDefault).model, "blocked-by-the-gateway");
  // Pinned: the pin is used as it stands.
  assert.equal(resolveOpenAiAgentLlmConfig({ defaultModel: "kimi" }, sdkDefault).model, "kimi");
});

test("an agent pinned to a claude-sdk model falls back rather than breaking the loop", () => {
  const sdkPin: LlmConfig = {
    ...twoChatModels,
    providers: { ...twoChatModels.providers, anthropic: { type: "claude-sdk" } },
    models: [...(twoChatModels.models ?? []), { id: "claude-sonnet", label: "Sonnet", provider: "anthropic" }],
  };
  const resolved = resolveOpenAiAgentLlmConfig({ defaultModel: "claude-sonnet" }, sdkPin);
  assert.equal(resolved.backend, undefined);
  assert.equal(resolved.model, "blocked-by-the-gateway");
});
