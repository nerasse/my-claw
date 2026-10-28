import { describe, test, expect, beforeEach } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { chatCompletion, chatCompletionStream, countsTowardBreaker, resetCircuitBreaker } from "../../src/llm/provider.ts";
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

/**
 * The incident: OpenRouter publishes the output ceiling of a model's *best* endpoint, so a run
 * pinned to a lesser one asked for more than that endpoint accepts and got "404 No endpoints
 * found" naming the model. Measured live on deepseek-v4-flash@streamlake/fp8: 384000 -> 200,
 * 393216 -> 404, the rest of the request being equal.
 */
describe("max_tokens against a pinned endpoint ceiling", () => {
  beforeEach(() => {
    resetCircuitBreaker();
    clearOpenRouterCache();
  });

  const endpointsBody = (tag: string, maxOutput: number | null) =>
    new Response(JSON.stringify({ data: { endpoints: [{ tag, max_completion_tokens: maxOutput }] } }), { status: 200 });

  async function sentMaxTokens(
    cfg: ResolvedLlmConfig,
    endpoints: () => Response,
  ): Promise<number | undefined> {
    let sent: number | undefined;
    const mock = mockFetch(async (input, init) => {
      if (String(input).includes("/endpoints")) return endpoints() as never;
      sent = JSON.parse(String((init as RequestInit).body)).max_tokens;
      return okResponse() as never;
    });
    try {
      await chatCompletion(cfg, simpleMessages);
    } finally {
      mock.restore();
    }
    return sent;
  }

  test("an ask above the pinned endpoint ceiling is lowered to it", async () => {
    const pinned: ResolvedLlmConfig = {
      ...config, apiModel: "vendor/model", providerRoute: "streamlake/fp8", limit: { output: 393216 },
    };
    expect(await sentMaxTokens(pinned, () => endpointsBody("streamlake/fp8", 384000))).toBe(384000);
  });

  test("an ask the endpoint accepts is sent untouched", async () => {
    const pinned: ResolvedLlmConfig = {
      ...config, apiModel: "vendor/model", providerRoute: "streamlake/fp8", limit: { output: 122880 },
    };
    expect(await sentMaxTokens(pinned, () => endpointsBody("streamlake/fp8", 384000))).toBe(122880);
  });

  test("an endpoint that publishes no ceiling leaves the ask alone: absent is not zero", async () => {
    const pinned: ResolvedLlmConfig = {
      ...config, apiModel: "vendor/model", providerRoute: "digitalocean", limit: { output: 393216 },
    };
    expect(await sentMaxTokens(pinned, () => endpointsBody("digitalocean", null))).toBe(393216);
  });

  test("an unreachable endpoints API leaves the ask alone rather than inventing a ceiling", async () => {
    const pinned: ResolvedLlmConfig = {
      ...config, apiModel: "vendor/model", providerRoute: "streamlake/fp8", limit: { output: 393216 },
    };
    expect(await sentMaxTokens(pinned, () => new Response("nope", { status: 500 }))).toBe(393216);
  });

  test("an unpinned run is never clamped, whatever the catalogue says", async () => {
    const unpinned: ResolvedLlmConfig = { ...config, apiModel: "vendor/model", limit: { output: 393216 } };
    let endpointCalls = 0;
    let sent: number | undefined;
    const mock = mockFetch(async (input, init) => {
      if (String(input).includes("/endpoints")) {
        endpointCalls++;
        return endpointsBody("streamlake/fp8", 384000) as never;
      }
      sent = JSON.parse(String((init as RequestInit).body)).max_tokens;
      return okResponse() as never;
    });
    try {
      await chatCompletion(unpinned, simpleMessages);
    } finally {
      mock.restore();
    }
    expect(sent).toBe(393216);
    // No pin, no lookup: an unpinned run must not pay a round trip it cannot use.
    expect(endpointCalls).toBe(0);
  });
});

describe("a stop reaches a run that is waiting to retry", () => {
  beforeEach(() => {
    resetCircuitBreaker();
    clearOpenRouterCache();
  });

  test("a 429 with a long Retry-After does not hold the run past the stop", async () => {
    // The backoff slept on a bare setTimeout, so `Retry-After: 30` made /stop a no-op for half a
    // minute: the signal was aborted, the run was marked stopped, and the process sat in a timer
    // nothing could reach. The owner pressed the button and watched nothing happen.
    const mock = mockFetch(async () =>
      new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "30" },
      }) as never,
    );
    const controller = new AbortController();
    try {
      const started = Date.now();
      const call = chatCompletion(config, simpleMessages, undefined, controller.signal);
      // The stop lands while the run is in the backoff, not before it.
      setTimeout(() => controller.abort(), 20);
      await expect(call).rejects.toThrow("Run aborted by user");
      // The point is what did *not* happen: thirty seconds of waiting.
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      mock.restore();
      controller.abort();
    }
  });

  test("a signal already aborted buys no delay at all", async () => {
    const mock = mockFetch(async () =>
      new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "30" },
      }) as never,
    );
    const controller = new AbortController();
    try {
      const call = chatCompletion(config, simpleMessages, undefined, controller.signal);
      controller.abort();
      await expect(call).rejects.toThrow();
    } finally {
      mock.restore();
    }
  });
});

describe("a spent quota is not an endpoint outage", () => {
  test("five exhausted-account refusals do not open the breaker for the other accounts", async () => {
    resetCircuitBreaker();
    // Measured 2026-10-27: `chatgpt-2`'s `usage_limit_reached` opened the breaker keyed on
    // `https://chatgpt.com/backend-api`, which is the endpoint all three ChatGPT subscriptions
    // share. `chatgpt-3` answered fine ninety seconds later and the run had already been rerouted.
    const mock = mockFetch(async () => errorResponse(429, '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}') as never);
    try {
      for (let i = 0; i < 6; i++) {
        await chatCompletion(config, simpleMessages).catch(() => {});
      }
      // The seventh still reaches the backend: the endpoint is fine, one plan is out.
      await expect(chatCompletion(config, simpleMessages)).rejects.toThrow("HTTP 429");
    } finally {
      mock.restore();
    }
  });

  test("a rate limit still counts: it is the endpoint struggling, not a plan running dry", () => {
    const quota = Object.assign(new Error('{"error":{"type":"usage_limit_reached"}}'), { status: 429 });
    const rate = Object.assign(new Error("Too many concurrent requests"), { status: 429 });
    const outage = Object.assign(new Error("server"), { status: 503 });
    const malformed = Object.assign(new Error("bad request"), { status: 400 });

    expect(countsTowardBreaker(quota)).toBe(false);
    expect(countsTowardBreaker(rate)).toBe(true);
    expect(countsTowardBreaker(outage)).toBe(true);
    expect(countsTowardBreaker(malformed)).toBe(false);
  });
});
