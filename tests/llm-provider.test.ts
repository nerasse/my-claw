import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "./helpers/mock-fetch.ts";
import { chatCompletion, chatCompletionStream } from "../src/llm/provider.ts";

const config = {
  provider: "x",
  baseUrl: "https://example.com",
  model: "base-model",
  apiKey: "token",
};

test("chatCompletion parses content and tool calls", async () => {
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "hello",
              tool_calls: [
                {
                  id: "tc1",
                  function: { name: "demo", arguments: '{"x":1}' },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const result = await chatCompletion(config, [{ role: "user", content: "hi" }]);
    assert.equal(result.content, "hello");
    assert.deepEqual(result.toolCalls, [{ id: "tc1", name: "demo", arguments: { x: 1 } }]);
  } finally {
    fetchMock.restore();
  }
});

test("chatCompletionStream parses SSE tokens and streamed tool calls", async () => {
  const encoder = new TextEncoder();
  const chunk1 = JSON.stringify({ choices: [{ delta: { content: "hel" } }] });
  const chunk2 = JSON.stringify({
    choices: [{ delta: { content: "lo", tool_calls: [{ index: 0, id: "tc1", function: { name: "demo", arguments: '{"x":' } }] } }],
  });
  const chunk3 = JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }],
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${chunk1}\n`));
      controller.enqueue(encoder.encode(`data: ${chunk2}\n`));
      controller.enqueue(encoder.encode(`data: ${chunk3}\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n'));
      controller.close();
    },
  });

  const fetchMock = mockFetch(async () =>
    new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never,
  );

  try {
    const tokens: string[] = [];
    const result = await chatCompletionStream(
      config,
      [{ role: "user", content: "hi" }],
      async (token) => {
        tokens.push(token);
      },
    );

    assert.deepEqual(tokens, ["hel", "lo"]);
    assert.equal(result.content, "hello");
    assert.deepEqual(result.toolCalls, [{ id: "tc1", name: "demo", arguments: { x: 1 } }]);
  } finally {
    fetchMock.restore();
  }
});
