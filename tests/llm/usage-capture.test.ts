import { test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { chatCompletion, chatCompletionStream } from "../../src/llm/provider.ts";
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

/** The same answer as `reply`, streamed: usage rides the last chunk, as OpenRouter sends it. */
function streamReply(usage: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", ...headers } });
}

/** One streamed call, for the paths that have to produce the same figure as the buffered one. */
async function streamed(usage: Record<string, unknown>, headers: Record<string, string> = {}) {
  const mock = mockFetch(async () => streamReply(usage, headers) as never);
  try {
    return await chatCompletionStream(llm, [{ role: "user", content: "hi" }], () => {});
  } finally {
    mock.restore();
  }
}

/** One buffered call. */
async function buffered(usage: Record<string, unknown>, headers: Record<string, string> = {}) {
  const mock = mockFetch(async () => reply(usage, headers));
  try {
    return await chatCompletion(llm, [{ role: "user", content: "hi" }]);
  } finally {
    mock.restore();
  }
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

/**
 * OpenRouter declares what it charged in the body and nowhere else, so the two paths that read a
 * body have to read it. The figures below are measured, not invented: a non-BYOK call of
 * `z-ai/glm-5.2` through Baidu, and a BYOK call of `google/gemini-3.7-flash` through Google AI
 * Studio where OpenRouter charged nothing and the owner's own Google key was debited instead.
 */
test("an aggregator's own cost is read off the body, on both paths", async () => {
  const declared = { prompt_tokens: 10, completion_tokens: 2, cost: 3.45058e-6, cost_details: { upstream_inference_cost: 3.45058e-6 }, is_byok: false };
  expect((await buffered(declared)).proxyCostUsd).toBeCloseTo(3.45058e-6, 12);
  expect((await streamed(declared)).proxyCostUsd).toBeCloseTo(3.45058e-6, 12);
});

test("a BYOK call is worth its upstream cost, not the zero the aggregator charged", async () => {
  // OpenRouter bills 0 and the upstream provider debits the owner. Believing `cost` alone here
  // erases the expense, which is the whole reason `is_byok` is read.
  const byok = { prompt_tokens: 10, completion_tokens: 2, cost: 0, cost_details: { upstream_inference_cost: 4.5e-6 }, is_byok: true };
  expect((await buffered(byok)).proxyCostUsd).toBeCloseTo(4.5e-6, 12);
  expect((await streamed(byok)).proxyCostUsd).toBeCloseTo(4.5e-6, 12);
});

test("a body that declares no cost leaves the row for the price tables, exactly as before", async () => {
  expect((await buffered({ prompt_tokens: 10, completion_tokens: 2 })).proxyCostUsd).toBeUndefined();
  expect((await streamed({ prompt_tokens: 10, completion_tokens: 2 })).proxyCostUsd).toBeUndefined();
});

test("a declared zero is not a price: it falls to the tables rather than pinning the row at 0", async () => {
  // Same rule as the header. Without `is_byok` a zero means both "free" and "nothing priced", and
  // recording it would freeze $0.00 on a row the tables can describe.
  const zero = { prompt_tokens: 10, completion_tokens: 2, cost: 0 };
  expect((await buffered(zero)).proxyCostUsd).toBeUndefined();
  expect((await streamed(zero)).proxyCostUsd).toBeUndefined();
  // A BYOK route whose upstream is zero too says nothing more than the zero above.
  expect((await buffered({ ...zero, is_byok: true, cost_details: { upstream_inference_cost: 0 } })).proxyCostUsd).toBeUndefined();
});

test("an aggregator that declares a cost and no is_byok at all is taken at its word", async () => {
  // Off a BYOK route the two figures agree, so the absence of the flag is not a reason to discard
  // the only number on offer.
  expect((await buffered({ prompt_tokens: 10, completion_tokens: 2, cost: 6.46e-7 })).proxyCostUsd).toBeCloseTo(6.46e-7, 12);
});

test("a BYOK call with no upstream figure falls back to the cost the aggregator declared", async () => {
  expect((await buffered({ prompt_tokens: 10, completion_tokens: 2, cost: 2.5e-6, is_byok: true })).proxyCostUsd).toBeCloseTo(2.5e-6, 12);
});

test("the proxy header outranks the body, because it is the bill of the leg that forwarded the call", async () => {
  const res = await buffered(
    { prompt_tokens: 10, completion_tokens: 2, cost: 1e-6 },
    { "x-litellm-response-cost-original": "0.0042", "x-litellm-model-api-base": "https://up.example/v1" },
  );
  expect(res.proxyCostUsd).toBeCloseTo(0.0042, 8);
  expect(res.upstreamApiBase).toBe("https://up.example/v1");
});

test("a zero header does not shadow a body that does declare a cost", async () => {
  // The header is only trusted when positive, so a proxy with no price on file must leave the
  // aggregator's own figure standing rather than swallow it.
  const res = await buffered(
    { prompt_tokens: 10, completion_tokens: 2, cost: 7e-6 },
    { "x-litellm-response-cost-original": "0.0", "x-litellm-model-api-base": "https://up.example/v1" },
  );
  expect(res.proxyCostUsd).toBeCloseTo(7e-6, 12);
  expect(res.upstreamApiBase).toBe("https://up.example/v1");
});

test("the reasoning share of the output is captured, buffered and streamed alike", async () => {
  // A subset of completion_tokens: what the app shows of a thought, never added to the bill.
  const usage = { prompt_tokens: 10, completion_tokens: 300, total_tokens: 310, completion_tokens_details: { reasoning_tokens: 256 } };
  for (const res of [await buffered(usage), await streamed(usage)]) {
    expect(res.usage?.completionTokens).toBe(300);
    expect(res.usage?.totalTokens).toBe(310);
    expect(res.usage?.reasoningTokens).toBe(256);
  }
});

test("a zero reasoning share is no count at all", async () => {
  const res = await buffered({ prompt_tokens: 10, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 0 } });
  expect(res.usage?.reasoningTokens).toBeUndefined();
});
