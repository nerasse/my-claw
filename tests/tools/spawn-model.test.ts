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
import { closestModels, judgePins, subagentModelIds } from "../../src/tools/model-choice.ts";
import { createSpawnTool } from "../../src/tools/spawn.ts";
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

test("what a sub-agent run may be pinned to: the configured tags, then the catalog", () => {
  const ids = subagentModelIds({ tags: { Cheap: {}, Smart: {} }, llm: { models: [{ id: "a/b" }, { id: "c/d" }] } });
  assert.deepEqual(ids, ["tag:Cheap", "tag:Smart", "a/b", "c/d"]);
  assert.deepEqual(subagentModelIds({ llm: {} }), []);
});

/**
 * The catalog says what a node agent is worth right now: `[offline]`, `[disabled]`, `[gone]`.
 * A refusal at spawn time is the backstop; the line here is what keeps the orchestrator from
 * asking in the first place.
 */
test("a node agent is marked with the machine's state, and a local agent is not", async () => {
  const { setNodeAccess, nodesFilePath, resetNodesStore, mintNode } = await import("../../src/nodes/store.ts");
  const hub = await import("../../src/nodes/hub.ts");
  const { rm } = await import("node:fs/promises");
  await resetNodesStore();
  await rm(nodesFilePath(), { force: true });
  hub.resetNodeHub();

  const facts = {
    os: "linux", arch: "x64", hostname: "web01", user: "neras", mode: "user" as const, version: "0.1.0",
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
  };
  const minted = await mintNode({ name: "web01", facts });
  if (!minted.ok) throw new Error("mint failed");
  const nodeId = minted.minted.record.nodeId;
  const nodeCatalog = (): AgentInfo[] => [
    ...catalog(),
    { name: "node-web01", description: "Remote node web01", base: "node", node: nodeId, source: "custom", path: "node-web01.md" },
  ];

  const offline = createSpawnTool({} as SubAgentRunner, {} as SubAgentRegistry, () => [], nodeCatalog).description;
  assert.match(offline, /node-web01: Remote node web01 \[offline\]/);
  assert.match(offline, /research: reads and reports\n/);

  await setNodeAccess(nodeId, { disabled: true });
  const disabled = createSpawnTool({} as SubAgentRunner, {} as SubAgentRegistry, () => [], nodeCatalog).description;
  assert.match(disabled, /node-web01: Remote node web01 \[disabled\]/);

  const gone = createSpawnTool({} as SubAgentRunner, {} as SubAgentRegistry, () => [], () => [
    { name: "node-web01", description: "Remote node web01", base: "node", node: "node-deadbeef", source: "custom", path: "node-web01.md" },
  ]).description;
  assert.match(gone, /\[gone\]/);
  await resetNodesStore();
  hub.resetNodeHub();
});

/**
 * The two optional pins a caller may set on a sub-agent run. They ride on the sub-agent's session
 * -- `effortOverride` and `contextOverride`, exactly what a chat's `/effort` and `/cap` write --
 * so the resolver and the window reader apply them with no second precedence to keep in step.
 */
test("the effort and the ceiling are optional, and both reach the runner as pins", async () => {
  const pins: Array<{ effort?: string; contextCap?: number } | undefined> = [];
  const runner = {
    spawn: async (opts: { pins?: { effort?: string; contextCap?: number } }) => {
      pins.push(opts.pins);
      return { id: "subagent/x-1", result: "done", attachments: [] };
    },
  } as unknown as SubAgentRunner;
  const registry = {
    listExistingIds: async () => [],
    generateId: () => "subagent/x-1",
    enqueue: <T,>(_id: string, run: () => Promise<T>) => run(),
  } as unknown as SubAgentRegistry;
  const tool = createSpawnTool(runner, registry, () => IDS, catalog);
  const call = (extra: Record<string, unknown>) =>
    tool.execute({ name: "x", type: "research", mode: "run", task: "t", __message: message, ...extra });

  // Omitted: no pins at all, so the agent's own scope decides.
  assert.equal((await call({})).success, true);
  assert.equal((await call({ effort: "HIGH", contextCap: "720000" })).success, true);
  assert.equal((await call({ effort: "inherit" })).success, true);
  assert.deepEqual(pins, [undefined, { effort: "high", contextCap: 720000 }, undefined]);

  // A level the ladder does not carry, and a cap that is not a positive number, are refused
  // before any run starts.
  const badLevel = await call({ effort: "turbo" });
  assert.equal(badLevel.success, false);
  assert.match(badLevel.error ?? "", /Unknown effort/);
  const badCap = await call({ contextCap: -5 });
  assert.equal(badCap.success, false);
  assert.match(badCap.error ?? "", /positive number/);
  assert.equal(pins.length, 3, "a refused pin never reaches the runner");
});

test("the two new parameters are optional and described, and the definition stays small", () => {
  const { tool } = harness();
  const schema = tool.parameters as Schema;
  assert.equal(schema.properties["effort"]!.type, "string");
  assert.ok(Array.isArray(schema.properties["effort"]!.enum));
  assert.match(schema.properties["effort"]!.description ?? "", /Optional/);
  assert.equal(schema.properties["contextCap"]!.type, "number");
  assert.match(schema.properties["contextCap"]!.description ?? "", /Optional/);
  assert.deepEqual((tool.parameters as { required?: string[] }).required, ["name", "type", "mode", "task"]);
  assert.ok(JSON.stringify(tool.parameters).length < 3_000);
});

test("judgePins: one vocabulary, so both doors accept the same words", () => {
  assert.deepEqual(judgePins({}), { ok: true, pins: {} });
  assert.deepEqual(judgePins({ effort: "max" }), { ok: true, pins: { effort: "max" } });
  assert.deepEqual(judgePins({ effort: "  HIGH  " }), { ok: true, pins: { effort: "high" } });
  assert.deepEqual(judgePins({ effort: "default" }), { ok: true, pins: {} });
  assert.deepEqual(judgePins({ contextCap: 512000 }), { ok: true, pins: { contextCap: 512000 } });
  assert.deepEqual(judgePins({ contextCap: "512000.7" }), { ok: true, pins: { contextCap: 512000 } });
  assert.equal(judgePins({ effort: "none-of-them" }).ok, false);
  assert.equal(judgePins({ contextCap: 0 }).ok, false);
  assert.equal(judgePins({ contextCap: "beaucoup" }).ok, false);
});

/**
 * The whole `provider/model` reference and nothing less: six providers serve "gpt-6-luna" on a
 * real install, so a label or a bare id tail is refused rather than resolved.
 */
test("only the whole provider/model reference is accepted as a model", async () => {
  const { asked, call } = harness();
  assert.equal((await call("openrouter/anthropic/claude-sonnet-5.5")).success, true);
  for (const guess of ["Claude Sonnet 5.5", "claude-sonnet-5.5", "sonnet-5.5"]) {
    const result = await call(guess);
    assert.equal(result.success, false, `${guess} must be refused`);
    assert.match(result.error ?? "", /provider\/model/);
  }
  assert.deepEqual(asked, ["openrouter/anthropic/claude-sonnet-5.5"], "only the exact reference reached the runner");
});
