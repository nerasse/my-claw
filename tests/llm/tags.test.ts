import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveLlmConfig, effectiveEffort } from "../../src/llm/resolver.ts";
import { resolveContextWindow } from "../../src/llm/context-window.ts";
import { setTag, deleteTag } from "../../src/core/config-edit.ts";
import { CONFIG_PATH, type EffortLevel, type LlmConfig, type MyClawConfig } from "../../src/core/config.ts";
import { writeFile } from "node:fs/promises";

function llmConfig(tags: Record<string, { model: string; effort?: EffortLevel; contextCap?: number }> = {}): LlmConfig {
  return {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-5",
    providers: {
      anthropic: { type: "claude-sdk", baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" },
    },
    models: [
      { id: "claude-sonnet-4-5", label: "Sonnet 4.5", provider: "anthropic", vision: true, limit: { context: 200000 } },
      { id: "claude-opus-4-8", label: "Opus 4.8", provider: "anthropic", vision: true, limit: { context: 320000 } },
    ],
    tags,
  };
}

test("a tag reference resolves to the tag's model, keeping the tag id as the run identity", () => {
  const config = llmConfig({ opus: { model: "claude-opus-4-8", effort: "xhigh" } });
  const resolved = resolveLlmConfig(config, "tag:opus");
  assert.equal(resolved.model, "tag:opus");
  assert.equal(resolved.apiModel, "claude-opus-4-8");
  assert.equal(resolved.provider, "anthropic");
  assert.equal(resolved.vision, true);
  assert.deepEqual(resolved.limit, { context: 320000 });
});

test("the tag's effort pins the run between the session override and the model's own", () => {
  const config = llmConfig({ opus: { model: "claude-opus-4-8", effort: "xhigh" } });
  assert.equal(resolveLlmConfig(config, "tag:opus").effort, "xhigh");
  assert.equal(resolveLlmConfig(config, "tag:opus", "low").effort, "low");
  assert.equal(resolveLlmConfig(config, "claude-opus-4-8").effort, undefined);
});

test("a tag without its own effort inherits the model's effort", () => {
  const config: LlmConfig = {
    ...llmConfig({ opus: { model: "claude-opus-4-8" } }),
    models: [{ id: "claude-opus-4-8", label: "Opus 4.8", provider: "anthropic", effort: "high" }],
  };
  assert.equal(resolveLlmConfig(config, "tag:opus").effort, "high");
});

test("a tag may point at another tag: the chain ends at a real model with the outer effort", () => {
  const config = llmConfig({
    opus: { model: "tag:opus-pinned" },
    "opus-pinned": { model: "claude-opus-4-8", effort: "max" },
  });
  const resolved = resolveLlmConfig(config, "tag:opus");
  assert.equal(resolved.model, "tag:opus");
  assert.equal(resolved.apiModel, "claude-opus-4-8");
});

test("the virtual Default tag follows the current default model", () => {
  const config = llmConfig({});
  const resolved = resolveLlmConfig(config, "tag:Default");
  assert.equal(resolved.model, "tag:Default");
  assert.equal(resolved.apiModel, "claude-sonnet-4-5");
});

test("an unknown tag name passes through like a stale model id instead of throwing", () => {
  const config = llmConfig({});
  const resolved = resolveLlmConfig(config, "tag:gone");
  assert.equal(resolved.model, "tag:gone");
  assert.equal(resolved.apiModel, undefined);
  assert.equal(resolved.provider, "anthropic");
});

test("effectiveEffort reports a tag's pinned level as a model-level choice", () => {
  const config = llmConfig({ opus: { model: "claude-opus-4-8", effort: "xhigh" } });
  assert.deepEqual(effectiveEffort(config, "tag:opus"), { level: "xhigh", source: "model" });
  assert.deepEqual(effectiveEffort(config, "tag:opus", "low"), { level: "low", source: "session" });
});

const myClawConfig = (tags: Record<string, unknown>): MyClawConfig =>
  ({
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: { defaultModel: "claude-sonnet-4-5", providers: {}, models: [], tags: undefined },
    agents: {},
    context: { cap: 100000 },
    tags,
  }) as unknown as MyClawConfig;

test("the tag's context cap outranks the agent/global cap for runs through the tag", () => {
  const config = myClawConfig({ opus: { model: "claude-opus-4-8", contextCap: 50000 } });
  const window = resolveContextWindow({ model: "tag:opus", config, declared: 320000, agent: "orchestrator" });
  assert.equal(window.effective, 50000);
  assert.equal(window.cappedFrom, 320000);
});

test("a session override still wins over the tag's context cap", () => {
  const config = myClawConfig({ opus: { model: "claude-opus-4-8", contextCap: 50000 } });
  const window = resolveContextWindow({
    model: "tag:opus",
    config,
    declared: 320000,
    sessionOverride: 80000,
  });
  assert.equal(window.effective, 80000);
  assert.equal(window.overridden, true);
});

test("the virtual Default tag applies no context cap of its own", () => {
  const config = myClawConfig({});
  const window = resolveContextWindow({ model: "tag:Default", config, declared: 320000, agent: "orchestrator" });
  assert.equal(window.effective, 100000);
});

test("setTag writes the tag into config.json and deleteTag removes it", async () => {
  await writeFile(CONFIG_PATH, JSON.stringify({ whitelist: [], blacklist: [], channels: {}, llm: { defaultModel: "x" }, agents: {} }, null, 2) + "\n", "utf-8");

  const written = await setTag("opus", { model: "claude-opus-4-8", effort: "xhigh", contextCap: 50000 });
  assert.equal(written.ok, true);
  let onDisk = JSON.parse(await Bun.file(CONFIG_PATH).text());
  assert.deepEqual(onDisk.tags, { opus: { model: "claude-opus-4-8", effort: "xhigh", contextCap: 50000 } });

  const removed = await deleteTag("opus");
  assert.equal(removed.ok, true);
  onDisk = JSON.parse(await Bun.file(CONFIG_PATH).text());
  assert.equal(onDisk.tags, undefined);
});

test("the reserved Default name cannot be written or deleted", async () => {
  await writeFile(CONFIG_PATH, JSON.stringify({ whitelist: [], blacklist: [], channels: {}, llm: { defaultModel: "x" }, agents: {} }, null, 2) + "\n", "utf-8");
  assert.equal((await setTag("Default", { model: "y" })).ok, false);
  assert.equal((await deleteTag("Default")).ok, false);
});
