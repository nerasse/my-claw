import { describe, test, expect, beforeEach } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { chatCompletion, chatCompletionStream, resetCircuitBreaker } from "../../src/llm/provider.ts";
import { clearOpenRouterCache } from "../../src/llm/openrouter-endpoints.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";

const messages = [{ role: "user" as const, content: "hello" }];

/** Short walls, so the suite proves the behaviour instead of waiting two minutes for it. */
const bounded: ResolvedLlmConfig = {
  model: "test-model",
  baseUrl: "https://timeout.example.com",
  apiKey: "k",
  timeoutMs: 40,
  timeoutFrom: "model",
};

const unbounded: ResolvedLlmConfig = { ...bounded, timeoutMs: 0 };

function okResponse(content = "hi"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A socket that is open and says nothing, which is the only thing the timer exists to catch. */
function silentForever(fetchSignal: AbortSignal | undefined | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    fetchSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

/** An SSE body that ships one token per `everyMs`, `count` times, then closes. */
function drip(count: number, everyMs: number): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < count; i++) {
        await new Promise((r) => setTimeout(r, everyMs));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("request timeout, non-streaming", () => {
  beforeEach(() => {
    resetCircuitBreaker();
    clearOpenRouterCache();
  });

  test("cuts a silent request and names the value and its provenance", async () => {
    const mock = mockFetch(async (_url, init) => silentForever(init?.signal) as never);
    try {
      await expect(chatCompletion(bounded, messages)).rejects.toThrow("timed out after 40ms (model)");
    } finally {
      mock.restore();
    }
  });

  test("our own wall is not replayed: one fetch, not three", async () => {
    // A wall we chose is not a transient fault. Retrying tripled the load on the machine that was
    // already too slow to answer once, and pushed the wait to three times the budget.
    let calls = 0;
    const mock = mockFetch(async (_url, init) => {
      calls++;
      return silentForever(init?.signal) as never;
    });
    try {
      await expect(chatCompletion(bounded, messages)).rejects.toThrow("timed out");
      expect(calls).toBe(1);
    } finally {
      mock.restore();
    }
  });

  test("a timeout does not feed the breaker, while a real fault does", async () => {
    // Contrast in one test on purpose: the breaker is keyed by baseUrl, so a self-inflicted wall
    // counting toward it would take every model of the provider down with it. Both halves stay
    // inside their own mock, because mockFetch resets the breaker on setup and on restore.
    let calls = 0;
    const timing = mockFetch(async (_url, init) => {
      calls++;
      // Six timeouts, one past the threshold of five, then an answer an open breaker never reaches.
      if (calls <= 6) return silentForever(init?.signal) as never;
      return okResponse("still reachable") as never;
    });
    try {
      for (let i = 0; i < 6; i++) {
        await chatCompletion(bounded, messages).catch(() => {});
      }
      const result = await chatCompletion(bounded, messages);
      expect(result.content).toBe("still reachable");
    } finally {
      timing.restore();
    }

    // 501 counts toward the breaker and is not in RETRYABLE_STATUS, so it fails without backoff.
    const broken = mockFetch(async () => (
      new Response(JSON.stringify({ error: { message: "server" } }), {
        status: 501,
        headers: { "Content-Type": "application/json" },
      }) as never
    ));
    try {
      for (let i = 0; i < 5; i++) {
        await chatCompletion(bounded, messages).catch(() => {});
      }
      await expect(chatCompletion(bounded, messages)).rejects.toThrow("circuit breaker");
    } finally {
      broken.restore();
    }
  });

  test("zero arms no timer at all, and Stop is still the wall", async () => {
    const controller = new AbortController();
    const mock = mockFetch(async (_url, init) => silentForever(init?.signal) as never);
    try {
      const pending = chatCompletion(unbounded, messages, undefined, controller.signal);
      // Ten times the bounded budget: a timer would have fired long before this.
      await new Promise((r) => setTimeout(r, 400));
      controller.abort();
      await expect(pending).rejects.toThrow(/aborted/i);
    } finally {
      mock.restore();
    }
  });

  test("an abort the network raised is still transient and still retried", async () => {
    // Non-regression: the flag tells our own wall apart from a dead socket, and a dead socket must
    // keep its retry. Both surface as `DOMException: AbortError`.
    let calls = 0;
    const mock = mockFetch(async () => {
      calls++;
      if (calls === 1) throw new DOMException("socket closed", "AbortError");
      return okResponse("recovered") as never;
    });
    try {
      const result = await chatCompletion({ ...bounded, timeoutMs: 5_000 }, messages);
      expect(result.content).toBe("recovered");
      expect(calls).toBe(2);
    } finally {
      mock.restore();
    }
  });
});

describe("request timeout, streaming", () => {
  beforeEach(() => {
    resetCircuitBreaker();
    clearOpenRouterCache();
  });

  test("the budget is silence and not duration: every token re-arms it", async () => {
    // Six tokens at 30 ms each is 180 ms of stream under a 90 ms wall. A total-duration budget
    // would cut a reasoning model mid-answer, which is what this timer was rewritten to stop.
    const mock = mockFetch(async () => drip(6, 30) as never);
    const seen: string[] = [];
    try {
      const result = await chatCompletionStream(
        { ...bounded, timeoutMs: 90 },
        messages,
        (token) => {
          seen.push(token);
        },
      );
      expect(seen.length).toBe(6);
      expect(result.content).toBe("xxxxxx");
    } finally {
      mock.restore();
    }
  });

  test("a stream that stops producing is cut, and says for how long it was silent", async () => {
    const mock = mockFetch(async (_url, init) => silentForever(init?.signal) as never);
    try {
      await expect(chatCompletionStream(bounded, messages, () => {})).rejects.toThrow(
        "stalled for 40ms (model)",
      );
    } finally {
      mock.restore();
    }
  });

  test("zero leaves a slow stream alone", async () => {
    // Four tokens at 60 ms: every one of them is past the 40 ms the bounded config would allow.
    const mock = mockFetch(async () => drip(4, 60) as never);
    try {
      const result = await chatCompletionStream(unbounded, messages, () => {});
      expect(result.content).toBe("xxxx");
    } finally {
      mock.restore();
    }
  });
});
