import { describe, test, expect, beforeEach } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { chatCompletion, chatCompletionStream, resetCircuitBreaker } from "../../src/llm/provider.ts";
import { clearOpenRouterCache } from "../../src/llm/openrouter-endpoints.ts";
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
    clearOpenRouterCache();
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

  test("an open breaker on one provider leaves the others alone", async () => {
    resetCircuitBreaker();
    const other: ResolvedLlmConfig = { model: "test-model", baseUrl: "https://healthy.example.com", apiKey: "k" };
    // A dead local runtime used to open the only breaker there was and refuse every chat,
    // including the ones pinned on a cloud provider that was answering perfectly.
    const mock = mockFetch(async (input) => (
      String(input).startsWith("https://test.example.com")
        ? errorResponse(501, "server") as never
        : okResponse("still here") as never
    ));
    try {
      for (let i = 0; i < 5; i++) {
        await chatCompletion(config, simpleMessages).catch(() => {});
      }
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow("circuit breaker");
      const result = await chatCompletion(other, simpleMessages);
      expect(result.content).toBe("still here");
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

  test("404 no-allowed-providers with an absent pin fails without retrying", async () => {
    const pinned: ResolvedLlmConfig = { ...config, apiModel: "vendor/model", providerRoute: "deepseek/foundation" };
    let completionCalls = 0;
    const mock = mockFetch(async (input) => {
      if (String(input).includes("/models/vendor/model/endpoints")) {
        return new Response(JSON.stringify({ data: { endpoints: [{ tag: "deepinfra/fp8" }] } }), { status: 200 }) as never;
      }
      completionCalls++;
      return errorResponse(404, "No allowed providers are available for this model") as never;
    });
    try {
      await expect(chatCompletion(pinned, simpleMessages)).rejects.toThrow('pinned OpenRouter endpoint "deepseek/foundation"');
      expect(completionCalls).toBe(1);
    } finally {
      mock.restore();
    }
  });

  test("404 no-endpoints-found (the other live shape) is also caught", async () => {
    // Verified live against OpenRouter: an order pointing at a provider that never served the
    // model answers "No endpoints found for <model>" rather than "no allowed providers".
    const pinned: ResolvedLlmConfig = { ...config, apiModel: "vendor/model", providerRoute: "azure/eu" };
    let completionCalls = 0;
    const mock = mockFetch(async (input) => {
      if (String(input).includes("/models/vendor/model/endpoints")) {
        return new Response(JSON.stringify({ data: { endpoints: [{ tag: "deepinfra/fp8" }] } }), { status: 200 }) as never;
      }
      completionCalls++;
      return errorResponse(404, "No endpoints found for google/gemini-3.7-flash") as never;
    });
    try {
      await expect(chatCompletion(pinned, simpleMessages)).rejects.toThrow('pinned OpenRouter endpoint "azure/eu"');
      expect(completionCalls).toBe(1);
    } finally {
      mock.restore();
    }
  });

  test("retries a pinned OpenRouter 404 while the endpoint remains listed", async () => {
    const pinned: ResolvedLlmConfig = { ...config, apiModel: "vendor/model", providerRoute: "streamlake/fp8" };
    let completionCalls = 0;
    const mock = mockFetch(async (input) => {
      if (String(input).includes("/models/vendor/model/endpoints")) {
        return new Response(JSON.stringify({ data: { endpoints: [{ tag: "streamlake/fp8" }] } }), { status: 200 }) as never;
      }
      completionCalls++;
      if (completionCalls === 1) {
        return new Response(JSON.stringify({ error: { message: "No endpoints found for vendor/model" } }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Retry-After": "0.001" },
        }) as never;
      }
      return okResponse("recovered") as never;
    });
    try {
      const result = await chatCompletion(pinned, simpleMessages);
      expect(result.content).toBe("recovered");
      expect(completionCalls).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("retries a pinned OpenRouter 404 in streaming mode", async () => {
    const pinned: ResolvedLlmConfig = { ...config, apiModel: "vendor/model", providerRoute: "streamlake/fp8" };
    let completionCalls = 0;
    const mock = mockFetch(async (input) => {
      if (String(input).includes("/models/vendor/model/endpoints")) {
        return new Response(JSON.stringify({ data: { endpoints: [{ tag: "streamlake/fp8" }] } }), { status: 200 }) as never;
      }
      completionCalls++;
      if (completionCalls === 1) {
        return new Response(JSON.stringify({ error: { message: "No endpoints found for vendor/model" } }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Retry-After": "0.001" },
        }) as never;
      }
      const payload = JSON.stringify({ choices: [{ delta: { content: "recovered" } }] });
      return new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as never;
    });
    try {
      const tokens: string[] = [];
      const result = await chatCompletionStream(pinned, simpleMessages, (token) => {
        tokens.push(token);
      });
      expect(result.content).toBe("recovered");
      expect(tokens).toEqual(["recovered"]);
      expect(completionCalls).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("404 without a pin keeps the generic error", async () => {
    const mock = mockFetch(async () =>
      errorResponse(404, "No allowed providers are available for this model") as never,
    );
    try {
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow("HTTP 404");
    } finally {
      mock.restore();
    }
  });
});
