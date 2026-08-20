import { describe, test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";
import type { ReasoningSink } from "../../src/agent/backend.ts";
import { llmComplete, llmCompleteStream } from "../../src/llm/transport.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";
import { __testing as anthropicTesting } from "../../src/llm/anthropic.ts";

// Direct assertions on finishReason/incomplete, the two fields the empty-turn retry logic in
// AgentBridge reads. Each transport reports them differently on the wire, so each gets its own
// parsing test instead of relying on the bridge's behavior to prove the parsing.

const baseConfig: ResolvedLlmConfig = {
  provider: "default",
  backend: "openai",
  baseUrl: "https://example.com",
  model: "test-model",
  apiKey: "k",
};

const messages: ChatMessage[] = [{ role: "user", content: "hello" }];

function sse(chunks: object[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("OpenAI-compatible finishReason", () => {
  test("non-streaming surfaces finish_reason and flags empty non-stop turns as incomplete", async () => {
    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );
    try {
      const res = await llmComplete(baseConfig, messages);
      expect(res.content).toBe("");
      expect(res.finishReason).toBe("length");
      expect(res.incomplete).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("non-streaming empty turn with finish_reason=stop is not incomplete", async () => {
    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );
    try {
      const res = await llmComplete(baseConfig, messages);
      expect(res.finishReason).toBe("stop");
      expect(res.incomplete).toBe(false);
    } finally {
      mock.restore();
    }
  });

  test("streaming carries the last finish_reason", async () => {
    const mock = mockFetch(async () =>
      sse([
        { choices: [{ index: 0, delta: { content: "hi" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]) as never,
    );
    try {
      const res = await llmCompleteStream(baseConfig, messages, (_) => {});
      expect(res.content).toBe("hi");
      expect(res.finishReason).toBe("stop");
      expect(res.incomplete).toBe(false);
    } finally {
      mock.restore();
    }
  });

  test("stream cut before any finish_reason and before any content is incomplete", async () => {
    const mock = mockFetch(async () =>
      sse([
        { choices: [{ index: 0, delta: { reasoning_content: "thinking..." } }] },
        { choices: [{ index: 0, delta: {} }] },
      ]) as never,
    );
    try {
      const res = await llmCompleteStream(baseConfig, messages, async (_) => {}, undefined, undefined, { onText: async (_) => {} });
      expect(res.content).toBe("");
      expect(res.finishReason).toBeUndefined();
      expect(res.incomplete).toBe(true);
    } finally {
      mock.restore();
    }
  });
});

describe("Anthropic finishReason", () => {
  function anthropicSse(events: object[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    });
  }

  test("message_delta stop_reason is surfaced, empty content is incomplete even on end_turn", async () => {
    const res = await anthropicTesting.processStream(
      anthropicSse([
        { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ]),
      undefined,
    );
    expect(res.content).toBe("");
    expect(res.finishReason).toBe("end_turn");
    // Anthropic can end_turn after thinking only: still an empty turn from the user's point of view.
    expect(res.incomplete).toBe(true);
  });

  test("max_tokens stop is surfaced with text present", async () => {
    const res = await anthropicTesting.processStream(
      anthropicSse([
        { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ]),
      undefined,
    );
    expect(res.content).toBe("partial");
    expect(res.finishReason).toBe("max_tokens");
    expect(res.incomplete).toBe(false);
  });
});
