import { describe, test, expect, beforeEach } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { chatCompletion, resetCircuitBreaker } from "../../src/llm/provider.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";

const config: ResolvedLlmConfig = {
  model: "test-model",
  baseUrl: "https://test.example.com",
  apiKey: "test-key",
};

const simpleMessages = [{ role: "user" as const, content: "hello" }];

function okResponse(content = "hi") {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function errorResponse(status: number, message = "error") {
  return new Response(
    JSON.stringify({ error: { message } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

describe("LLM provider retry logic", () => {
  beforeEach(() => {
    resetCircuitBreaker();
  });

  test("successful request returns content and usage", async () => {
    const mock = mockFetch(async () => okResponse("hello world") as never);
    try {
      const result = await chatCompletion(config, simpleMessages);
      expect(result.content).toBe("hello world");
      expect(result.usage?.totalTokens).toBe(15);
    } finally {
      mock.restore();
    }
  });

  test("retries on 429 and succeeds on second attempt", async () => {
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return errorResponse(429, "rate limited") as never;
      return okResponse("retried ok") as never;
    });
    try {
      const result = await chatCompletion(config, simpleMessages);
      expect(result.content).toBe("retried ok");
      expect(callCount).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("retries on 500", async () => {
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return errorResponse(500, "internal error") as never;
      return okResponse() as never;
    });
    try {
      await chatCompletion(config, simpleMessages);
      expect(callCount).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("retries on 502", async () => {
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return errorResponse(502) as never;
      return okResponse() as never;
    });
    try {
      await chatCompletion(config, simpleMessages);
      expect(callCount).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("retries on 503", async () => {
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return errorResponse(503) as never;
      return okResponse() as never;
    });
    try {
      await chatCompletion(config, simpleMessages);
      expect(callCount).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("retries on 504", async () => {
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return errorResponse(504) as never;
      return okResponse() as never;
    });
    try {
      await chatCompletion(config, simpleMessages);
      expect(callCount).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("does NOT retry on 400", async () => {
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      return errorResponse(400, "bad request") as never;
    });
    try {
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow("400");
      expect(callCount).toBe(1);
    } finally {
      mock.restore();
    }
  });

  test("does NOT retry on 401", async () => {
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      return errorResponse(401, "unauthorized") as never;
    });
    try {
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow("401");
      expect(callCount).toBe(1);
    } finally {
      mock.restore();
    }
  });

  test("does NOT retry on 403", async () => {
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      return errorResponse(403, "forbidden") as never;
    });
    try {
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow("403");
      expect(callCount).toBe(1);
    } finally {
      mock.restore();
    }
  });

  test("exhausts all 3 retry attempts then throws", async () => {
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      return errorResponse(503, "overloaded") as never;
    });
    try {
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow("503");
      expect(callCount).toBe(3);
    } finally {
      mock.restore();
    }
  });

  test("retries on transient network errors (ECONNRESET)", async () => {
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("connection reset");
        (err as NodeJS.ErrnoException).code = "ECONNRESET";
        throw err;
      }
      return okResponse("recovered") as never;
    });
    try {
      const result = await chatCompletion(config, simpleMessages);
      expect(result.content).toBe("recovered");
      expect(callCount).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("circuit breaker opens after 5 consecutive failures", async () => {
    resetCircuitBreaker();
    // 501 is a server error (counts toward the breaker) but not in RETRYABLE_STATUS, so each call
    // fails immediately without retry backoff — fast and deterministic.
    const mock = mockFetch(async () => errorResponse(501, "server") as never);
    try {
      for (let i = 0; i < 5; i++) {
        await chatCompletion(config, simpleMessages).catch(() => {});
      }
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow("circuit breaker");
    } finally {
      mock.restore();
    }
  });

  test("circuit breaker ignores non-retryable 4xx client errors", async () => {
    resetCircuitBreaker();
    // A malformed request (400) is request-specific, not a provider outage: it must not push the
    // breaker toward opening, or one bad tool call would block all LLM traffic.
    const mock = mockFetch(async () => errorResponse(400, "bad request") as never);
    try {
      for (let i = 0; i < 6; i++) {
        await chatCompletion(config, simpleMessages).catch(() => {});
      }
      // 7th call still reaches the backend (400), not blocked by an open breaker.
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow("HTTP 400");
    } finally {
      mock.restore();
    }
  });

  test("circuit breaker resets after successful call", async () => {
    resetCircuitBreaker();
    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount <= 3) return errorResponse(400, "bad") as never;
      return okResponse("ok") as never;
    });
    try {
      for (let i = 0; i < 3; i++) {
        await chatCompletion(config, simpleMessages).catch(() => {});
      }
      // 3 failures, circuit not yet open (threshold is 5)
      const result = await chatCompletion(config, simpleMessages);
      expect(result.content).toBe("ok");
      // Circuit should be reset, not accumulating
    } finally {
      mock.restore();
    }
  });

  test("handles empty response body gracefully", async () => {
    const mock = mockFetch(async () =>
      new Response("", { status: 200, headers: { "Content-Type": "application/json" } }) as never,
    );
    try {
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow();
    } finally {
      mock.restore();
    }
  });

  test("handles malformed JSON response", async () => {
    const mock = mockFetch(async () =>
      new Response("not json at all {{{", { status: 200, headers: { "Content-Type": "application/json" } }) as never,
    );
    try {
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow();
    } finally {
      mock.restore();
    }
  });

  test("handles response with no choices", async () => {
    const mock = mockFetch(async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "Content-Type": "application/json" } }) as never,
    );
    try {
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow();
    } finally {
      mock.restore();
    }
  });
});
