import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { chatCompletion, chatCompletionStream, type LlmResponse } from "../../src/llm/provider.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";

const config: ResolvedLlmConfig = {
  baseUrl: "https://api.example.com",
  model: "test-model",
  apiKey: "test-key",
};

// --- Usage extraction from non-streaming response ---

test("chatCompletion: extracts usage from response", async () => {
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const result = await chatCompletion(config, [{ role: "user", content: "hi" }]);
    assert.equal(result.content, "hello");
    assert.ok(result.usage);
    assert.equal(result.usage!.promptTokens, 100);
    assert.equal(result.usage!.completionTokens, 25);
    assert.equal(result.usage!.totalTokens, 125);
  } finally {
    fetchMock.restore();
  }
});

test("chatCompletion: handles Anthropic-style input_tokens/output_tokens", async () => {
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hello" } }],
        usage: { input_tokens: 80, output_tokens: 20 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const result = await chatCompletion(config, [{ role: "user", content: "hi" }]);
    assert.ok(result.usage);
    assert.equal(result.usage!.promptTokens, 80);
    assert.equal(result.usage!.completionTokens, 20);
    assert.equal(result.usage!.totalTokens, 100);
  } finally {
    fetchMock.restore();
  }
});

test("chatCompletion: usage is undefined when not in response", async () => {
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hello" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const result = await chatCompletion(config, [{ role: "user", content: "hi" }]);
    assert.equal(result.content, "hello");
    assert.equal(result.usage, undefined);
  } finally {
    fetchMock.restore();
  }
});

test("chatCompletion: usage is undefined when all zeros", async () => {
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const result = await chatCompletion(config, [{ role: "user", content: "hi" }]);
    assert.equal(result.usage, undefined);
  } finally {
    fetchMock.restore();
  }
});

// --- Usage extraction from streaming response ---

function makeStreamBody(chunks: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push("data: [DONE]\n\n");
  const full = lines.join("");

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(full));
      controller.close();
    },
  });
}

test("chatCompletionStream: extracts usage from final chunk", async () => {
  const fetchMock = mockFetch(async () =>
    new Response(
      makeStreamBody([
        { choices: [{ delta: { content: "hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } },
      ]),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ) as never,
  );

  try {
    const tokens: string[] = [];
    const result = await chatCompletionStream(
      config,
      [{ role: "user", content: "hi" }],
      async (t) => { tokens.push(t); },
    );
    assert.equal(result.content, "hello world");
    assert.deepEqual(tokens, ["hello", " world"]);
    assert.ok(result.usage);
    assert.equal(result.usage!.promptTokens, 50);
    assert.equal(result.usage!.completionTokens, 10);
    assert.equal(result.usage!.totalTokens, 60);
  } finally {
    fetchMock.restore();
  }
});

test("chatCompletionStream: usage is undefined when provider does not include it", async () => {
  const fetchMock = mockFetch(async () =>
    new Response(
      makeStreamBody([
        { choices: [{ delta: { content: "hi" } }] },
      ]),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ) as never,
  );

  try {
    const result = await chatCompletionStream(
      config,
      [{ role: "user", content: "hi" }],
      async () => {},
    );
    assert.equal(result.content, "hi");
    assert.equal(result.usage, undefined);
  } finally {
    fetchMock.restore();
  }
});

// --- stream_options.include_usage is sent ---

test("chatCompletionStream: sends stream_options.include_usage in request body", async () => {
  let capturedBody: Record<string, unknown> | undefined;

  const fetchMock = mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(
      makeStreamBody([{ choices: [{ delta: { content: "ok" } }] }]),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ) as never;
  });

  try {
    await chatCompletionStream(config, [{ role: "user", content: "hi" }], async () => {});
    assert.ok(capturedBody);
    assert.equal(capturedBody!.stream, true);
    assert.deepEqual(capturedBody!.stream_options, { include_usage: true });
  } finally {
    fetchMock.restore();
  }
});

// --- Session accumulation ---

test("session tokenUsage accumulates across multiple responses", () => {
  // Simulate what bridge.ts does
  const session = {
    tokenUsage: undefined as { promptTokens: number; completionTokens: number; totalTokens: number; apiCalls: number } | undefined,
  };

  function accumulateUsage(s: typeof session, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
    if (!usage) return;
    if (!s.tokenUsage) {
      s.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, apiCalls: 0 };
    }
    s.tokenUsage.promptTokens += usage.promptTokens;
    s.tokenUsage.completionTokens += usage.completionTokens;
    s.tokenUsage.totalTokens += usage.totalTokens;
    s.tokenUsage.apiCalls += 1;
  }

  accumulateUsage(session, { promptTokens: 100, completionTokens: 25, totalTokens: 125 });
  accumulateUsage(session, { promptTokens: 200, completionTokens: 50, totalTokens: 250 });
  accumulateUsage(session, undefined); // no usage from provider — should be a no-op

  assert.ok(session.tokenUsage);
  assert.equal(session.tokenUsage!.promptTokens, 300);
  assert.equal(session.tokenUsage!.completionTokens, 75);
  assert.equal(session.tokenUsage!.totalTokens, 375);
  assert.equal(session.tokenUsage!.apiCalls, 2);
});
