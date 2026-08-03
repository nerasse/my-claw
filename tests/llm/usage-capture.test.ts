import { test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { chatCompletion } from "../../src/llm/provider.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";

/**
 * The cache split arrives on the wire and used to be dropped before anything could see it, so
 * these tests go through the real transport rather than a normalisation helper.
 */
const llm = {
  model: "test-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "k",
  backend: "openai",
} as unknown as ResolvedLlmConfig;

function reply(usage: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage }), { status: 200, headers });
}

test("OpenAI-style cached tokens are captured as a subset of the prompt", async () => {
  const mock = mockFetch(async () => reply({ prompt_tokens: 252, completion_tokens: 1, total_tokens: 253, prompt_tokens_details: { cached_tokens: 192 } }));
  try {
    const res = await chatCompletion(llm, [{ role: "user", content: "hi" }]);
    // prompt_tokens already includes the cached ones, so it must not be inflated.
    expect(res.usage?.promptTokens).toBe(252);
    expect(res.usage?.cacheReadTokens).toBe(192);
  } finally {
    mock.restore();
  }
});

test("Anthropic-style cache buckets are added to the prompt total", async () => {
  const mock = mockFetch(async () => reply({ input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }));
  try {
    const res = await chatCompletion(llm, [{ role: "user", content: "hi" }]);
    // input_tokens counts only fresh input here, so "all input" is the sum of the three buckets.
    expect(res.usage?.promptTokens).toBe(1050);
    expect(res.usage?.cacheReadTokens).toBe(900);
    expect(res.usage?.cacheWriteTokens).toBe(50);
  } finally {
    mock.restore();
  }
});

test("a provider that names cache hits differently is still understood", async () => {
  const mock = mockFetch(async () => reply({ prompt_tokens: 500, completion_tokens: 2, prompt_cache_hit_tokens: 400 }));
  try {
    const res = await chatCompletion(llm, [{ role: "user", content: "hi" }]);
    expect(res.usage?.cacheReadTokens).toBe(400);
  } finally {
    mock.restore();
  }
});

test("no cache fields leaves them absent rather than zero", async () => {
  const mock = mockFetch(async () => reply({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }));
  try {
    const res = await chatCompletion(llm, [{ role: "user", content: "hi" }]);
    expect(res.usage?.promptTokens).toBe(10);
    expect(res.usage?.cacheReadTokens).toBeUndefined();
  } finally {
    mock.restore();
  }
});

test("the proxy's cost and upstream are read from the response headers", async () => {
  const mock = mockFetch(async () =>
    reply(
      { prompt_tokens: 10, completion_tokens: 2 },
      {
        "x-litellm-response-cost-original": "0.0042",
        "x-litellm-model-api-base": "https://token-plan-ams.xiaomimimo.com/v1",
      },
    ),
  );
  try {
    const res = await chatCompletion(llm, [{ role: "user", content: "hi" }]);
    expect(res.proxyCostUsd).toBeCloseTo(0.0042, 8);
    expect(res.upstreamApiBase).toBe("https://token-plan-ams.xiaomimimo.com/v1");
  } finally {
    mock.restore();
  }
});

test("a zero cost header is not carried, because it means both free and unpriced", async () => {
  const mock = mockFetch(async () =>
    reply({ prompt_tokens: 10, completion_tokens: 2 }, { "x-litellm-response-cost-original": "0.0", "x-litellm-model-api-base": "https://up.example/v1" }),
  );
  try {
    const res = await chatCompletion(llm, [{ role: "user", content: "hi" }]);
    expect(res.proxyCostUsd).toBeUndefined();
    // The upstream is still useful: it is what lets the price table resolve the real tariff.
    expect(res.upstreamApiBase).toBe("https://up.example/v1");
  } finally {
    mock.restore();
  }
});
