import { test } from "bun:test";
import assert from "node:assert/strict";
import { toOpenAiToolDefinitions, toOpenAiToolCalls } from "../../src/llm/openai-format.ts";
import type { Tool } from "../../src/tools/types.ts";

function fakeTool(overrides?: Partial<Tool>): Tool {
  return {
    name: "test_tool",
    description: "A test tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output: "" }),
    ...overrides,
  };
}

test("toOpenAiToolDefinitions: empty array returns empty array", () => {
  assert.deepStrictEqual(toOpenAiToolDefinitions([]), []);
});

test("toOpenAiToolDefinitions: single tool has correct format", () => {
  const tool = fakeTool({ name: "my_fn", description: "does stuff", parameters: { type: "object" } });
  const result = toOpenAiToolDefinitions([tool]);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "function");
  assert.equal(result[0].function.name, "my_fn");
  assert.equal(result[0].function.description, "does stuff");
  assert.deepStrictEqual(result[0].function.parameters, { type: "object" });
});

test("toOpenAiToolDefinitions: multiple tools converted in order", () => {
  const tools = [
    fakeTool({ name: "alpha" }),
    fakeTool({ name: "beta" }),
    fakeTool({ name: "gamma" }),
  ];
  const result = toOpenAiToolDefinitions(tools);
  assert.equal(result.length, 3);
  assert.equal(result[0].function.name, "alpha");
  assert.equal(result[1].function.name, "beta");
  assert.equal(result[2].function.name, "gamma");
});

test("toOpenAiToolDefinitions: complex nested parameters passed through as-is", () => {
  const params = {
    type: "object",
    properties: {
      query: { type: "string" },
      filters: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          nested: { type: "object", properties: { deep: { type: "number" } } },
        },
      },
    },
  };
  const tool = fakeTool({ parameters: params });
  const result = toOpenAiToolDefinitions([tool]);
  assert.deepStrictEqual(result[0].function.parameters, params);
});

test("toOpenAiToolDefinitions: every output has type function", () => {
  const tools = [fakeTool({ name: "a" }), fakeTool({ name: "b" })];
  const result = toOpenAiToolDefinitions(tools);
  for (const def of result) {
    assert.equal(def.type, "function");
  }
});

test("toOpenAiToolCalls: empty array returns empty array", () => {
  assert.deepStrictEqual(toOpenAiToolCalls([]), []);
});

test("toOpenAiToolCalls: object arguments get JSON.stringified", () => {
  const result = toOpenAiToolCalls([
    { id: "call_1", name: "fn", arguments: { key: "value", n: 42 } },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "call_1");
  assert.equal(result[0].function.name, "fn");
  assert.equal(result[0].function.arguments, JSON.stringify({ key: "value", n: 42 }));
});

test("toOpenAiToolCalls: string arguments passed as-is", () => {
  const raw = '{"already":"stringified"}';
  const result = toOpenAiToolCalls([{ id: "call_2", name: "fn", arguments: raw }]);
  assert.equal(result[0].function.arguments, raw);
});

test("toOpenAiToolCalls: multiple calls preserve order", () => {
  const calls = [
    { id: "a", name: "first", arguments: {} },
    { id: "b", name: "second", arguments: "x" },
    { id: "c", name: "third", arguments: { k: 1 } },
  ];
  const result = toOpenAiToolCalls(calls);
  assert.equal(result.length, 3);
  assert.equal(result[0].id, "a");
  assert.equal(result[1].id, "b");
  assert.equal(result[2].id, "c");
});

test("toOpenAiToolCalls: every output has type function", () => {
  const result = toOpenAiToolCalls([
    { id: "x", name: "fn", arguments: {} },
    { id: "y", name: "fn2", arguments: "z" },
  ]);
  for (const tc of result) {
    assert.equal(tc.type, "function");
  }
});

test("toOpenAiToolCalls: empty object arguments become empty JSON object string", () => {
  const result = toOpenAiToolCalls([{ id: "e", name: "fn", arguments: {} }]);
  assert.equal(result[0].function.arguments, "{}");
});
