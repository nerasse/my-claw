import { test } from "bun:test";
import assert from "node:assert/strict";
import { chatCompletionStream } from "../../src/llm/provider.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

function sseResponse(...chunks: object[]): Response {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n") + "\n\ndata: [DONE]\n\n";
  return new Response(lines, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const config = { baseUrl: "https://example.com", model: "test", apiKey: "k" };

test("parallel tool calls with missing index use id to disambiguate", async () => {
  const mock = mockFetch(async () =>
    sseResponse(
      { choices: [{ delta: { tool_calls: [{ id: "call_a", function: { name: "bash", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: "call_b", function: { name: "read", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: "call_a", function: { arguments: '{"cmd":"ls"}' } }] } }] },
    ),
  );

  try {
    const result = await chatCompletionStream(config, [{ role: "user", content: "go" }], () => {});
    assert.ok(result.toolCalls);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0]!.id, "call_a");
    assert.equal(result.toolCalls[0]!.name, "bash");
    assert.deepEqual(result.toolCalls[0]!.arguments, { cmd: "ls" });
    assert.equal(result.toolCalls[1]!.id, "call_b");
    assert.equal(result.toolCalls[1]!.name, "read");
  } finally {
    mock.restore();
  }
});

test("tool calls with index field still work normally", async () => {
  const mock = mockFetch(async () =>
    sseResponse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "bash", arguments: '{"cmd":"echo"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_y", function: { name: "read", arguments: '{"path":"/tmp"}' } }] } }] },
    ),
  );

  try {
    const result = await chatCompletionStream(config, [{ role: "user", content: "go" }], () => {});
    assert.ok(result.toolCalls);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0]!.id, "call_x");
    assert.equal(result.toolCalls[0]!.name, "bash");
    assert.deepEqual(result.toolCalls[0]!.arguments, { cmd: "echo" });
    assert.equal(result.toolCalls[1]!.id, "call_y");
    assert.equal(result.toolCalls[1]!.name, "read");
    assert.deepEqual(result.toolCalls[1]!.arguments, { path: "/tmp" });
  } finally {
    mock.restore();
  }
});

test("single tool call without index works", async () => {
  const mock = mockFetch(async () =>
    sseResponse(
      { choices: [{ delta: { tool_calls: [{ id: "call_solo", function: { name: "bash", arguments: '{"cmd":"pwd"}' } }] } }] },
    ),
  );

  try {
    const result = await chatCompletionStream(config, [{ role: "user", content: "go" }], () => {});
    assert.ok(result.toolCalls);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.id, "call_solo");
    assert.equal(result.toolCalls[0]!.name, "bash");
    assert.deepEqual(result.toolCalls[0]!.arguments, { cmd: "pwd" });
  } finally {
    mock.restore();
  }
});
