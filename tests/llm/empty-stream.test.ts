import { describe, test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";
import { llmCompleteStream } from "../../src/llm/transport.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";

/**
 * Silence is a failure, not an answer.
 *
 * 2026-09-14: `deepseek-flash` behind opencode zen started answering HTTP 200 with a
 * `text/event-stream` it never wrote a byte to -- proven on a prompt that said "dis OK". The stream
 * closed clean, so nothing threw: the turn came back empty, the bridge logged "LLM ended an empty
 * turn; retrying" and tried again, and the route never fell through to its second model because a
 * route falls through on an error and an empty turn is not one. Every session on that tag sat there
 * for half an hour with a spinner and no error anywhere.
 *
 * A provider that never said why it stopped did not answer. That is what throws here, and it is
 * deliberately narrower than "the answer was empty": a cut answer and a model that chooses to say
 * nothing both stay valid turns below.
 */

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

describe("a stream that says nothing", () => {
  test("an opened stream closed without one byte is a failure", async () => {
    const mock = mockFetch(async () =>
      new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never,
    );
    try {
      await expect(llmCompleteStream(baseConfig, messages, (_) => {})).rejects.toThrow(
        /stream closed without sending anything/i,
      );
    } finally {
      mock.restore();
    }
  });

  test("a stream whose only frame is [DONE] is a failure too", async () => {
    // What the gateway does when it accepts the request and has nothing to route it to.
    const mock = mockFetch(async () => sse([]) as never);
    try {
      await expect(llmCompleteStream(baseConfig, messages, (_) => {})).rejects.toThrow(
        /stream closed without sending anything/i,
      );
    } finally {
      mock.restore();
    }
  });

  test("the message says stream closed, which is what makes the route fall through", async () => {
    // `isOutageClass` in the dispatcher matches /stream.*closed/: the wording is the contract
    // between this throw and the fallback to the next model of the route.
    const mock = mockFetch(async () => sse([]) as never);
    try {
      await llmCompleteStream(baseConfig, messages, (_) => {});
      throw new Error("expected a rejection");
    } catch (err) {
      expect(/stream.*closed|empty (?:response|completion)|no (?:content|output)/i.test(String((err as Error).message))).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("a turn that thought and was cut is still a turn", async () => {
    // Something arrived: the answer was cut, the provider did answer. Retrying the same model is
    // the right move here, and that is the bridge's empty-turn path, not an outage.
    const mock = mockFetch(async () =>
      sse([
        { choices: [{ index: 0, delta: { reasoning_content: "thinking..." } }] },
        { choices: [{ index: 0, delta: {} }] },
      ]) as never,
    );
    try {
      const res = await llmCompleteStream(baseConfig, messages, async (_) => {}, undefined, undefined, { onText: async (_) => {} });
      expect(res.content).toBe("");
      expect(res.incomplete).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("a model that chooses to say nothing is not a failure", async () => {
    const mock = mockFetch(async () =>
      sse([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]) as never,
    );
    try {
      const res = await llmCompleteStream(baseConfig, messages, (_) => {});
      expect(res.content).toBe("");
      expect(res.finishReason).toBe("stop");
      expect(res.incomplete).toBe(false);
    } finally {
      mock.restore();
    }
  });

  test("usage alone proves the provider answered", async () => {
    // A turn billed for its tokens was served, whatever it came back with.
    const mock = mockFetch(async () =>
      sse([{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } }]) as never,
    );
    try {
      const res = await llmCompleteStream(baseConfig, messages, (_) => {});
      expect(res.content).toBe("");
      expect(res.usage?.promptTokens).toBe(10);
    } finally {
      mock.restore();
    }
  });
});
