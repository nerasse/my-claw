import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveAgentLlmConfig, resolveLlmConfig, effectiveEffort } from "../../src/llm/resolver.ts";
import { resolveContextWindow } from "../../src/llm/context-window.ts";
import { setTag, deleteTag } from "../../src/core/config-edit.ts";
import { CONFIG_PATH, type EffortLevel, type LlmConfig, type MyClawConfig, type TagRouteCandidate } from "../../src/core/config.ts";
import { readFile, writeFile } from "node:fs/promises";

function llmConfig(tags: Record<string, { model?: string; effort?: EffortLevel; contextCap?: number; route?: TagRouteCandidate[]; fallbackToGlobalDefault?: boolean }> = {}): LlmConfig {
  return {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-5",
    providers: {
      anthropic: { type: "anthropic", baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" },
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

test("a route tag resolves its first concrete candidate with that candidate's pins", () => {
  const config = llmConfig({ cheap: {
    route: [
      { model: "claude-opus-4-8", effort: "max", contextCap: 150000 },
      { model: "claude-sonnet-4-5", effort: "high", contextCap: 100000 },
    ],
  }});
  const resolved = resolveLlmConfig(config, "tag:cheap");
  assert.equal(resolved.model, "tag:cheap");
  assert.equal(resolved.apiModel, "claude-opus-4-8");
  assert.equal(resolved.effort, "max");
});

test("a route tag's first candidate owns the context cap", () => {
  const config = myClawConfig({ cheap: {
    route: [
      { model: "claude-opus-4-8", contextCap: 50000 },
      { model: "claude-sonnet-4-5", contextCap: 100000 },
    ],
  }});
  const window = resolveContextWindow({ model: "tag:cheap", config, declared: 320000, agent: "orchestrator" });
  assert.equal(window.effective, 50000);
});

test("a route candidate cannot be a nested tag", async () => {
  await writeFile(CONFIG_PATH, JSON.stringify({ whitelist: [], blacklist: [], channels: {}, llm: { defaultModel: "x" }, agents: {} }, null, 2) + "\n", "utf-8");
  const result = await setTag("cheap", { route: [{ model: "tag:other" }] });
  assert.equal(result.ok, false);
});

test("the tag's effort pins the run between the session override and the scope", () => {
  const config = llmConfig({ opus: { model: "claude-opus-4-8", effort: "xhigh" } });
  assert.equal(resolveLlmConfig(config, "tag:opus").effort, "xhigh");
  assert.equal(resolveLlmConfig(config, "tag:opus", "low").effort, "low");
  // A scope pin (job/agent) loses to the tag: referencing a tag accepts both halves of it.
  assert.equal(resolveLlmConfig(config, "tag:opus", undefined, "medium").effort, "xhigh");
  assert.equal(resolveLlmConfig(config, "claude-opus-4-8").effort, undefined);
});

test("a tag without its own effort lets the scope pin through", () => {
  const config = llmConfig({ opus: { model: "claude-opus-4-8" } });
  assert.equal(resolveLlmConfig(config, "tag:opus").effort, undefined);
  assert.equal(resolveLlmConfig(config, "tag:opus", undefined, "medium").effort, "medium");
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

test("a deleted tag falls back to the virtual Default tag without rewriting its identity", () => {
  const config = llmConfig({});
  const resolved = resolveLlmConfig(config, "tag:gone");
  assert.equal(resolved.model, "tag:gone");
  assert.equal(resolved.apiModel, "claude-sonnet-4-5");
  assert.equal(resolved.provider, "anthropic");
});

test("a deleted tag follows a tag used as the current Default", () => {
  const config = llmConfig({ preferred: { model: "claude-opus-4-8", effort: "high" } });
  config.defaultModel = "tag:preferred";
  const resolved = resolveLlmConfig(config, "tag:gone");
  assert.equal(resolved.apiModel, "claude-opus-4-8");
  assert.equal(resolved.effort, "high");
});

test("a deleted agent tag falls back to the global default instead of itself", () => {
  const config = llmConfig({});
  const resolved = resolveAgentLlmConfig({ defaultModel: "tag:gone" }, config);
  assert.equal(resolved.model, "tag:gone");
  assert.equal(resolved.apiModel, "claude-sonnet-4-5");
});

test("an existing agent tag whose target was deleted also reaches the global default", () => {
  const config = llmConfig({ outer: { model: "tag:gone" } });
  const resolved = resolveAgentLlmConfig({ defaultModel: "tag:outer" }, config);
  assert.equal(resolved.model, "tag:outer");
  assert.equal(resolved.apiModel, "claude-sonnet-4-5");
});

test("a missing global Default target still reports a cycle instead of recursing", () => {
  const config = llmConfig({});
  config.defaultModel = "tag:gone";
  assert.throws(() => resolveLlmConfig(config, "tag:gone"), /Tag cycle/);
});

test("an existing outer tag keeps its pins when its target was deleted", () => {
  const config = llmConfig({ outer: { model: "tag:gone", effort: "high" } });
  const resolved = resolveLlmConfig(config, "tag:outer");
  assert.equal(resolved.model, "tag:outer");
  assert.equal(resolved.apiModel, "claude-sonnet-4-5");
  assert.equal(resolved.effort, "high");
});

test("effectiveEffort reports a tag's pinned level as a tag choice", () => {
  const config = llmConfig({ opus: { model: "claude-opus-4-8", effort: "xhigh" } });
  assert.deepEqual(effectiveEffort(config, "tag:opus"), { level: "xhigh", source: "tag" });
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

test("a tag pinning itself is refused loudly: the chain has no leaf", () => {
  const config = llmConfig({ Self: { model: "tag:Self" } });
  assert.throws(() => resolveLlmConfig(config, "tag:Self"), /Tag cycle: Self -> Self/);
});

test("a cycle of two tags is refused loudly and names the chain", () => {
  const config = llmConfig({
    AB: { model: "tag:BA" },
    BA: { model: "tag:AB" },
  });
  assert.throws(() => resolveLlmConfig(config, "tag:AB"), /Tag cycle: AB -> BA -> AB/);
});

test("a valid chain still resolves with the outer tag's effort", () => {
  const config = llmConfig({
    opus: { model: "tag:opus-pinned" },
    "opus-pinned": { model: "claude-opus-4-8", effort: "max" },
  });
  const resolved = resolveLlmConfig(config, "tag:opus");
  assert.equal(resolved.apiModel, "claude-opus-4-8");
  assert.equal(resolved.effort, "max");
});

test("setTag refuses a self-referencing tag", async () => {
  await writeFile(CONFIG_PATH, JSON.stringify({ whitelist: [], blacklist: [], channels: {}, llm: { defaultModel: "x" }, agents: {}, tags: { opus: { model: "claude-opus-4-8" } } }, null, 2) + "\n", "utf-8");
  const result = await setTag("opus", { model: "tag:opus" });
  assert.equal(result.ok, false);
  assert.match(String(result.ok === false ? result.error : ""), /boucle/);
  const onDisk = JSON.parse(await Bun.file(CONFIG_PATH).text());
  assert.deepEqual(onDisk.tags, { opus: { model: "claude-opus-4-8" } });
});

test("setTag refuses a write that would close a two-tag cycle", async () => {
  await writeFile(CONFIG_PATH, JSON.stringify({ whitelist: [], blacklist: [], channels: {}, llm: { defaultModel: "x" }, agents: {}, tags: { BA: { model: "tag:AB" } } }, null, 2) + "\n", "utf-8");
  assert.equal((await setTag("AB", { model: "tag:BA" })).ok, false);
});

test("setTag still accepts a valid tag reference chain", async () => {
  await writeFile(CONFIG_PATH, JSON.stringify({ whitelist: [], blacklist: [], channels: {}, llm: { defaultModel: "x" }, agents: {}, tags: { "opus-pinned": { model: "claude-opus-4-8" } } }, null, 2) + "\n", "utf-8");
  const result = await setTag("opus", { model: "tag:opus-pinned" });
  assert.equal(result.ok, true);
});

test("setTag stores an ordered route and its explicit global fallback", async () => {
  await writeFile(CONFIG_PATH, JSON.stringify({ whitelist: [], blacklist: [], channels: {}, llm: { defaultModel: "x" }, agents: {}, tags: {} }, null, 2) + "\n", "utf-8");
  const result = await setTag("cheap", {
    route: [{ model: "claude-opus-4-8", effort: "high", contextCap: 120000 }, { model: "claude-sonnet-4-5" }],
    fallbackToGlobalDefault: true,
  });
  assert.equal(result.ok, true);
  const stored = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as { tags: Record<string, { route: TagRouteCandidate[]; fallbackToGlobalDefault?: boolean }> };
  assert.deepEqual(stored.tags.cheap?.route, [{ model: "claude-opus-4-8", effort: "high", contextCap: 120000 }, { model: "claude-sonnet-4-5" }]);
  assert.equal(stored.tags.cheap?.fallbackToGlobalDefault, true);
});

test("setTag refuses a missing-reference cycle through Default", async () => {
  await writeFile(CONFIG_PATH, JSON.stringify({ whitelist: [], blacklist: [], channels: {}, llm: { defaultModel: "tag:opus" }, agents: {}, tags: {} }, null, 2) + "\n", "utf-8");
  const result = await setTag("opus", { model: "tag:gone" });
  assert.equal(result.ok, false);
});
