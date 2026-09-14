import { describe, test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";
import { llmCompleteStream } from "../../src/llm/transport.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";

/**
 * A keep-alive is not progress.
 *
 * 2026-09-14, measured on the wire: `opencode.ai/zen/go/v1` answers a dead `deepseek-flash` with
 * `HTTP 200`, a `text/event-stream`, and then `: keep-alive` -- fourteen bytes, every twelve
 * seconds, forever. The budget re-armed on every byte received, so those fourteen bytes reset the
 * 120 s wall five times a minute and it could never fire. The stream never closed either, so the
 * guard that turns a silent close into a failure was never reached: a `/compact` sat there for
 * sixteen minutes with nothing in the log after `command received`.
 *
 * The budget measures how long a provider has produced nothing, so only something counts: a frame
 * that parses. A comment keeps a socket warm and says nothing about the model.
 */

const messages: ChatMessage[] = [{ role: "user", content: "hello" }];

const config = (timeoutMs: number): ResolvedLlmConfig => ({
  provider: "default",
  backend: "openai",
  baseUrl: "https://example.com",
  model: "test-model",
  apiKey: "k",
  timeoutMs,
});

/**
 * A stream that stays open, emitting SSE comments and never a frame -- the gateway, exactly.
 *
 * The abort signal is wired the way a real `fetch` wires it: a mock Response that ignores it
 * cannot show a wall firing at all, since the read simply never returns.
 */
function keepAliveForever(everyMs: number, signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (timer) clearInterval(timer);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), everyMs);
      signal?.addEventListener("abort", () => {
        stop();
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      });
    },
    cancel: stop,
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Comments for a while, then a real answer: the budget must survive its own keep-alives. */
function keepAliveThenAnswer(everyMs: number, framesAfter: number): Response {
  const encoder = new TextEncoder();
  let ticks = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        ticks += 1;
        if (ticks <= framesAfter) {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        if (timer) clearInterval(timer);
        controller.close();
      }, everyMs);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("the budget measures progress, not traffic", () => {
  test("a stream that only keeps itself alive is cut at the budget", async () => {
    const mock = mockFetch(async (_url, init) => keepAliveForever(20, init?.signal) as never);
    try {
      const started = Date.now();
      await expect(llmCompleteStream(config(300), messages, (_) => {})).rejects.toThrow(/stalled/i);
      // Cut on its own wall, not left to the gateway's: well under the fifteen minutes it took.
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      mock.restore();
    }
  });

  test("the wall it reports is the budget, which is what makes the route fall through", async () => {
    // `isOutageClass` matches /stalled/: this wording is the contract with the fallback.
    const mock = mockFetch(async (_url, init) => keepAliveForever(20, init?.signal) as never);
    try {
      await llmCompleteStream(config(300), messages, (_) => {});
      throw new Error("expected a rejection");
    } catch (err) {
      expect(String((err as Error).message)).toMatch(/stalled for 300ms/);
    } finally {
      mock.restore();
    }
  });

  test("a slow answer behind keep-alives still arrives", async () => {
    // The comments must not shorten the budget either: what they must not do is extend it.
    const mock = mockFetch(async () => keepAliveThenAnswer(20, 3) as never);
    try {
      const res = await llmCompleteStream(config(2000), messages, (_) => {});
      expect(res.content).toBe("hi");
      expect(res.finishReason).toBe("stop");
    } finally {
      mock.restore();
    }
  });

  test("a stream producing frames keeps its budget alive past that budget", async () => {
    // 6 frames, 40 ms apart, on a 120 ms budget: each frame re-arms, so the whole run is legal
    // even though it lasts twice the wall. This is the half of the rule that must not break.
    const encoder = new TextEncoder();
    const mock = mockFetch(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 6; i++) {
              await Bun.sleep(40);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ) as never,
    );
    try {
      const res = await llmCompleteStream(config(120), messages, (_) => {});
      expect(res.content).toBe("xxxxxx");
    } finally {
      mock.restore();
    }
  });
});
