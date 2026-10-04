/**
 * How `spawn` takes a model -- docs/subagents.md.
 *
 * The parameter was an enum of every model the catalog knows: 544 ids on this install, 20 000
 * characters, about 5 000 tokens sent with every request of the orchestrator (measured
 * 2026-10-04). It also moved whenever discovery found a model, and the tool definitions open the
 * cached prefix. So the model is a plain string, checked here: a tag or a known id passes, and a
 * wrong one is answered with the few ids that look like it rather than the whole catalog.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { closestModels, createSpawnTool, spawnModelIds } from "../../src/tools/spawn.ts";
import type { SubAgentRunner } from "../../src/subagents/runner.ts";
import type { SubAgentRegistry } from "../../src/subagents/registry.ts";
import type { AgentInfo } from "../../src/agents/types.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const catalog = (): AgentInfo[] => [
  { name: "research", description: "reads and reports", base: "research", source: "built-in", path: "research.md" },
];

const IDS = [
  "tag:Cheap",
  "tag:Smart",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "openrouter/anthropic/claude-sonnet-5.5",
  "opencode_go/deepseek-v4.1-flash",
  "openrouter/deepseek/deepseek-v4.1-flash",
  "chatgpt/gpt-6.1-sol",
  "groq/whisper-large-v3",
];

const message: UnifiedMessage = {
  id: "m1", platform: "my-claw-app", userId: "owner", chatId: "owner", chatType: "dm", text: "go",
  attachments: [], isForwarded: false, raw: {},
};

function harness(ids: () => string[] = () => IDS) {
  const asked: Array<string | undefined> = [];
  const runner = {
    spawn: async (opts: { model?: string }) => {
      asked.push(opts.model);
      return { id: "subagent/x-1", result: "done", attachments: [] };
    },
  } as unknown as SubAgentRunner;
  const registry = {
    listExistingIds: async () => [],
    generateId: () => "subagent/x-1",
    enqueue: <T,>(_id: string, run: () => Promise<T>) => run(),
  } as unknown as SubAgentRegistry;
  const tool = createSpawnTool(runner, registry, ids, catalog);
  const call = (model?: string) =>
    tool.execute({ name: "x", type: "research", mode: "run", task: "t", ...(model ? { model } : {}), __message: message });
  return { tool, asked, call };
}

type Schema = { properties: Record<string, { type?: string; enum?: unknown[]; description?: string }> };

test("the model is a string the schema does not enumerate, however large the catalog", () => {
  const big = () => [...IDS, ...Array.from({ length: 600 }, (_, i) => `openrouter/vendor/model-${i}`)];
  const { tool } = harness(big);
  const model = (tool.parameters as Schema).properties["model"]!;
  assert.equal(model.type, "string");
  assert.equal(model.enum, undefined);
  assert.ok(JSON.stringify(tool.parameters).length < 2_000, "the definition no longer carries the catalog");
});

test("the definition does not move when discovery finds a model: the cached prefix holds", () => {
  let ids = IDS;
  const { tool } = harness(() => ids);
  const before = JSON.stringify({ d: tool.description, p: tool.parameters });
  ids = [...IDS, "openrouter/newcomer/fresh-model"];
  assert.equal(JSON.stringify({ d: tool.description, p: tool.parameters }), before);
});

test("the tags are named, since they are what a caller should reach for", () => {
  const { tool } = harness();
  const text = `${tool.description} ${(tool.parameters as Schema).properties["model"]!.description}`;
  assert.match(text, /tag:Cheap/);
  assert.match(text, /tag:Smart/);
});

test("a tag and a known id reach the runner as given", async () => {
  const { asked, call } = harness();
  assert.equal((await call("tag:Cheap")).success, true);
  assert.equal((await call("opencode_go/deepseek-v4.1-flash")).success, true);
  assert.equal((await call()).success, true);
  assert.deepEqual(asked, ["tag:Cheap", "opencode_go/deepseek-v4.1-flash", undefined]);
});

test("a wrong model is refused with the ids that look like it, not the whole catalog", async () => {
  const big = () => [...IDS, ...Array.from({ length: 600 }, (_, i) => `openrouter/vendor/model-${i}`)];
  const { asked, call } = harness(big);
  const result = await call("deepseek-v4.1-flash");
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /opencode_go\/deepseek-v4\.1-flash/);
  assert.match(result.error ?? "", /tag:Cheap/);
  assert.ok((result.error ?? "").length < 600, "a few suggestions, never 600 ids");
  assert.deepEqual(asked, []);
});

test("closest: the ids sharing the most of the name come first", () => {
  assert.deepEqual(closestModels("claude-sonnet-5-5", IDS, 2), ["anthropic/claude-sonnet-5-5", "openrouter/anthropic/claude-sonnet-5.5"]);
  assert.deepEqual(closestModels("gpt sol", IDS, 3), ["chatgpt/gpt-6.1-sol"]);
  assert.deepEqual(closestModels("nothing-like-it", IDS, 3), []);
  // Same share of the name: the id that holds it whole wins, even the longer one.
  assert.equal(closestModels("sonnet-5.5", IDS, 1)[0], "openrouter/anthropic/claude-sonnet-5.5");
});

test("what a spawn may name: the configured tags, then the catalog", () => {
  const ids = spawnModelIds({ tags: { Cheap: {}, Smart: {} }, llm: { models: [{ id: "a/b" }, { id: "c/d" }] } });
  assert.deepEqual(ids, ["tag:Cheap", "tag:Smart", "a/b", "c/d"]);
  assert.deepEqual(spawnModelIds({ llm: {} }), []);
});
