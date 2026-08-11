import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveLlmConfig, resolveLlmConfigForMessage, listAvailableModels, effortOptionsFor, effectiveEffort } from "../../src/llm/resolver.ts";
import type { LlmConfig } from "../../src/core/config.ts";

const newFormatConfig: LlmConfig = {
  defaultProvider: "fireworks",
  defaultModel: "accounts/fireworks/models/kimi-k2p6-turbo",
  providers: {
    fireworks: {
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiKeyEnv: "FIREWORKS_API_KEY",
    },
    groq: {
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      headers: { "x-groq-foo": "bar" },
    },
  },
  models: [
    { id: "accounts/fireworks/models/kimi-k2p6-turbo", label: "Kimi K2.6 Turbo", provider: "fireworks", vision: true, limit: { context: 262000, output: 64000 } },
    { id: "llama-3.3-70b", label: "Llama 3.3 70B", provider: "groq", vision: false, limit: { context: 128000, output: 32768 } },
  ],
};

test("resolveLlmConfig returns default model when no override", () => {
  const resolved = resolveLlmConfig(newFormatConfig);
  assert.equal(resolved.baseUrl, "https://api.fireworks.ai/inference/v1");
  assert.equal(resolved.model, "accounts/fireworks/models/kimi-k2p6-turbo");
  assert.equal(resolved.vision, true);
  assert.deepEqual(resolved.limit, { context: 262000, output: 64000 });
});

test("resolveLlmConfig resolves provider by model override", () => {
  const resolved = resolveLlmConfig(newFormatConfig, "llama-3.3-70b");
  assert.equal(resolved.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(resolved.model, "llama-3.3-70b");
  assert.equal(resolved.headers?.["x-groq-foo"], "bar");
  assert.equal(resolved.vision, false);
});

test("resolveLlmConfig resolves provider from defaultProvider when model has no provider", () => {
  const config: LlmConfig = {
    defaultProvider: "fireworks",
    defaultModel: "base-model",
    providers: {
      fireworks: { baseUrl: "https://fireworks.ai/v1" },
    },
    models: [
      { id: "base-model", label: "Base", provider: "fireworks" },
    ],
  };
  const resolved = resolveLlmConfig(config);
  assert.equal(resolved.baseUrl, "https://fireworks.ai/v1");
});

test("resolveLlmConfig throws when provider not found", () => {
  const config: LlmConfig = {
    defaultProvider: "missing",
    defaultModel: "x",
    providers: {},
    models: [{ id: "x", label: "X", provider: "missing" }],
  };
  assert.throws(() => resolveLlmConfig(config), /Provider "missing" not found/);
});

test("resolveLlmConfig resolves apiKey from env", () => {
  process.env["FIREWORKS_API_KEY"] = "test-fireworks-key";
  const resolved = resolveLlmConfig(newFormatConfig);
  assert.equal(resolved.apiKey, "test-fireworks-key");
  delete process.env["FIREWORKS_API_KEY"];
});

test("resolveLlmConfig prefers global apiKey over env", () => {
  process.env["FIREWORKS_API_KEY"] = "env-key";
  const config = { ...newFormatConfig, apiKey: "global-key" };
  const resolved = resolveLlmConfig(config);
  assert.equal(resolved.apiKey, "global-key");
  delete process.env["FIREWORKS_API_KEY"];
});

test("resolveLlmConfig falls back to legacy env vars", () => {
  delete process.env["FIREWORKS_API_KEY"];
  process.env["OPENAI_API_KEY"] = "openai-key";
  const configWithoutEnv: LlmConfig = {
    defaultProvider: "default",
    defaultModel: "m",
    providers: { default: { baseUrl: "https://api.openai.com/v1" } },
    models: [{ id: "m", label: "M" }],
  };
  const resolved = resolveLlmConfig(configWithoutEnv);
  assert.equal(resolved.apiKey, "openai-key");
  delete process.env["OPENAI_API_KEY"];
});

test("legacy config auto-migrates", () => {
  const legacy: LlmConfig = {
    baseUrl: "https://legacy.example.com/v1",
    model: "legacy-model",
    apiKey: "legacy-key",
    vision: true,
    limit: { context: 1000, output: 500 },
  } as unknown as LlmConfig;

  const resolved = resolveLlmConfig(legacy);
  assert.equal(resolved.baseUrl, "https://legacy.example.com/v1");
  assert.equal(resolved.model, "legacy-model");
  assert.equal(resolved.apiKey, "legacy-key");
  assert.equal(resolved.vision, true);
  assert.deepEqual(resolved.limit, { context: 1000, output: 500 });
});

test("legacy config falls back to fireworks baseUrl when empty", () => {
  const legacy: LlmConfig = {
    model: "m",
  } as unknown as LlmConfig;

  const resolved = resolveLlmConfig(legacy);
  assert.equal(resolved.baseUrl, "https://api.fireworks.ai/inference/v1");
});

test("listAvailableModels returns models array", () => {
  const models = listAvailableModels(newFormatConfig);
  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, "accounts/fireworks/models/kimi-k2p6-turbo");
});

test("listAvailableModels returns empty when none", () => {
  const models = listAvailableModels({} as LlmConfig);
  assert.equal(models.length, 0);
});

test("model vision flag overrides global vision", () => {
  const config: LlmConfig = {
    defaultProvider: "p",
    defaultModel: "m",
    vision: false,
    providers: { p: { baseUrl: "https://p.com" } },
    models: [
      { id: "m", label: "M", provider: "p", vision: true },
    ],
  };
  const resolved = resolveLlmConfig(config);
  assert.equal(resolved.vision, true);
});

test("model limit overrides global limit", () => {
  const config: LlmConfig = {
    defaultProvider: "p",
    defaultModel: "m",
    limit: { context: 1000, output: 500 },
    providers: { p: { baseUrl: "https://p.com" } },
    models: [
      { id: "m", label: "M", provider: "p", limit: { context: 2000, output: 1000 } },
    ],
  };
  const resolved = resolveLlmConfig(config);
  assert.deepEqual(resolved.limit, { context: 2000, output: 1000 });
});

test("resolveLlmConfig with custom provider", () => {
  const config: LlmConfig = {
    defaultProvider: "custom",
    defaultModel: "custom-model",
    providers: {
      custom: {
        baseUrl: "http://192.168.1.50:8000/v1",
        apiKeyEnv: "LOCAL_API_KEY",
        headers: { "x-auth": "secret" },
      },
    },
    models: [
      { id: "custom-model", label: "Custom", provider: "custom" },
    ],
  };
  const resolved = resolveLlmConfig(config);
  assert.equal(resolved.baseUrl, "http://192.168.1.50:8000/v1");
  assert.equal(resolved.headers?.["x-auth"], "secret");
});

const visionFallbackConfig: LlmConfig = {
  ...newFormatConfig,
  defaultModel: "llama-3.3-70b",
  visionFallback: "accounts/fireworks/models/kimi-k2p6-turbo",
};

test("resolveLlmConfigForMessage keeps the resolved model when there is no image", () => {
  const resolved = resolveLlmConfigForMessage(visionFallbackConfig, undefined, false);
  assert.equal(resolved.model, "llama-3.3-70b");
});

test("resolveLlmConfigForMessage keeps a vision-capable resolved model with images", () => {
  const resolved = resolveLlmConfigForMessage(visionFallbackConfig, "accounts/fireworks/models/kimi-k2p6-turbo", true);
  assert.equal(resolved.model, "accounts/fireworks/models/kimi-k2p6-turbo");
});

test("resolveLlmConfigForMessage reroutes an image run from a text-only model to the fallback", () => {
  const resolved = resolveLlmConfigForMessage(visionFallbackConfig, undefined, true);
  assert.equal(resolved.model, "accounts/fireworks/models/kimi-k2p6-turbo");
  assert.equal(resolved.vision, true);
  assert.equal(resolved.baseUrl, "https://api.fireworks.ai/inference/v1");
});

test("resolveLlmConfigForMessage ignores a fallback that is not a declared vision model", () => {
  const typo: LlmConfig = { ...visionFallbackConfig, visionFallback: "does-not-exist" };
  assert.equal(resolveLlmConfigForMessage(typo, undefined, true).model, "llama-3.3-70b");

  const textOnly: LlmConfig = { ...visionFallbackConfig, visionFallback: "llama-3.3-70b" };
  assert.equal(resolveLlmConfigForMessage(textOnly, undefined, true).model, "llama-3.3-70b");
});

test("resolveLlmConfigForMessage without visionFallback keeps current behavior", () => {
  const none: LlmConfig = { ...visionFallbackConfig, visionFallback: undefined };
  assert.equal(resolveLlmConfigForMessage(none, undefined, true).model, "llama-3.3-70b");
});

// --- Effort ---

const effortConfig: LlmConfig = {
  defaultProvider: "litellm",
  defaultModel: "mimo",
  effort: "high",
  providers: {
    litellm: { baseUrl: "https://x/v1" },
    anthropic: { type: "claude-sdk" },
  },
  models: [
    { id: "mimo", label: "MiMo", provider: "litellm" },
    { id: "grok-reasoner", label: "Grok", provider: "litellm", supportsEffort: true },
    { id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" },
  ],
};

test("effort: SDK model always carries effort", () => {
  assert.equal(resolveLlmConfig(effortConfig, "claude-sonnet-5").effort, "high");
});

test("effort: home model without supportsEffort never carries it", () => {
  assert.equal(resolveLlmConfig(effortConfig, "mimo").effort, undefined);
});

test("effort: home model with supportsEffort carries the global default", () => {
  assert.equal(resolveLlmConfig(effortConfig, "grok-reasoner").effort, "high");
});

test("effort: session override beats the scope pin", () => {
  assert.equal(resolveLlmConfig(effortConfig, "claude-sonnet-5", "max").effort, "max");
  // gating still applies to home models
  assert.equal(resolveLlmConfig(effortConfig, "mimo", "max").effort, undefined);
});

test("effort: the scope pin rides under the session override and over the global", () => {
  // scopeEffort is the job/agent pin, passed by the caller: it must beat the global default
  // but lose to the session's /effort.
  assert.equal(resolveLlmConfig(effortConfig, "claude-sonnet-5", undefined, "low").effort, "low");
  assert.equal(resolveLlmConfig(effortConfig, "claude-sonnet-5", "max", "low").effort, "max");
});

test("effortOptionsFor enabled when any SDK model, supportsEffort, or global effort", () => {
  assert.equal(effortOptionsFor(effortConfig).enabled, true);
  // "ultra" is Codex-only, but the global list is the superset; per-model filtering is what
  // keeps it off the menu for models that do not support it.
  assert.deepEqual(effortOptionsFor(effortConfig).levels, ["low", "medium", "high", "xhigh", "max", "ultra"]);

  const plain: LlmConfig = {
    defaultProvider: "litellm",
    defaultModel: "mimo",
    providers: { litellm: { baseUrl: "https://x/v1" } },
    models: [{ id: "mimo", label: "MiMo", provider: "litellm" }],
  };
  assert.equal(effortOptionsFor(plain).enabled, false);
});

// --- effectiveEffort: what the menus must display ---

test("effectiveEffort: reports the level and its origin", () => {
  // Origin, not just the level: the menus have to distinguish a deliberate setting from a fallback.
  assert.deepEqual(effectiveEffort(effortConfig, "claude-sonnet-5", "max"), { level: "max", source: "session" });
  assert.deepEqual(effectiveEffort(effortConfig, "claude-sonnet-5"), { level: "high", source: "config" });
  assert.deepEqual(effectiveEffort(effortConfig, "grok-reasoner"), { level: "high", source: "config" });
});

test("effectiveEffort: a scope pin is reported, not skipped", () => {
  // The menus resolved session > global only, so a job/agent-level effort displayed as
  // "default" while the run actually used it.
  const cfg: LlmConfig = { ...effortConfig, effort: undefined };
  assert.deepEqual(effectiveEffort(cfg, "claude-sonnet-5", undefined, "low"), { level: "low", source: "scope" });
});

test("effectiveEffort: an unset SDK model names the documented SDK fallback", () => {
  const cfg: LlmConfig = { ...effortConfig, effort: undefined };
  assert.deepEqual(effectiveEffort(cfg, "claude-sonnet-5"), { level: "high", source: "sdk-default" });
});

test("effectiveEffort: an unset opt-in home model stays unnamed", () => {
  // Only the Claude SDK documents its fallback. Naming one for the others would be an invention.
  const cfg: LlmConfig = { ...effortConfig, effort: undefined };
  assert.deepEqual(effectiveEffort(cfg, "grok-reasoner"), { source: "provider-default" });
});

test("effectiveEffort: a model that discards effort reports unsupported", () => {
  // mimo is OpenAI-compatible with no opt-in, so the parameter is never sent: the old menus still
  // advertised "Effort: default" for it.
  assert.deepEqual(effectiveEffort(effortConfig, "mimo"), { source: "unsupported" });
  assert.deepEqual(effectiveEffort(effortConfig, "mimo", "max"), { source: "unsupported" });
});

test("effectiveEffort: an explicit supportsEffort false outranks an effort-native backend", () => {
  const cfg: LlmConfig = {
    ...effortConfig,
    models: [{ id: "haiku", label: "Haiku", provider: "anthropic", supportsEffort: false }],
  };
  assert.deepEqual(effectiveEffort(cfg, "haiku"), { source: "unsupported" });
});

test("effort: a supportsEffort false model sends none, whatever the backend claims natively", () => {
  // The wire and the display have to agree: the menus reported "unsupported" for Haiku while the
  // run kept sending it a level, because the native shortcut returned before reading the model.
  const cfg: LlmConfig = {
    ...effortConfig,
    models: [{ id: "haiku", label: "Haiku", provider: "anthropic", supportsEffort: false }],
  };
  assert.equal(resolveLlmConfig(cfg, "haiku").effort, undefined);
  // Not even an explicit ask: the provider states the model has no effort at all.
  assert.equal(resolveLlmConfig(cfg, "haiku", "max").effort, undefined);
  assert.deepEqual(effectiveEffort(cfg, "haiku"), { source: "unsupported" });
});

test("effort: a native model that says nothing still carries it", () => {
  // Only an explicit `false` blocks a native backend: `undefined` is the normal case there.
  assert.equal(resolveLlmConfig(effortConfig, "claude-sonnet-5").effort, "high");
});

test("effectiveEffort: an unresolvable model or provider claims nothing", () => {
  assert.deepEqual(effectiveEffort(effortConfig, "gone-from-config"), { source: "unsupported" });
  // Provider resolution throws here; a display must not invent a level out of the failure.
  const broken: LlmConfig = { ...effortConfig, models: [{ id: "orphan", label: "Orphan", provider: "vanished" }] };
  assert.deepEqual(effectiveEffort(broken, "orphan"), { source: "unsupported" });
});
