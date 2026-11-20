import { test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { chatCompletion, chatCompletionStream, applyPromptCache, type ChatMessage } from "../../src/llm/provider.ts";
import { isMalformedReply, isProviderOutage } from "../../src/llm/outage.ts";
import { syntheticReasoningMismatch } from "../../src/llm/answer-accounting.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";

const llm: ResolvedLlmConfig = {
  model: "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
  apiModel: "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
  baseUrl: "https://api.synthetic.new/openai/v1",
  apiKey: "fixture",
  backend: "openai",
};

const frame = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

function stream(frames: string[]): Response {
  return new Response(frames.join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function streamed(frames: string[], config = llm) {
  const mock = mockFetch(async () => stream(frames));
  try {
    return await chatCompletionStream(config, [{ role: "user", content: "hi" }], () => {});
  } finally {
    mock.restore();
  }
}

async function failureOf(promise: Promise<unknown>): Promise<Error & { status?: number }> {
  try {
    await promise;
  } catch (err) {
    return err as Error & { status?: number };
  }
  throw new Error("expected the call to fail");
}

const text = (content: string) => frame({ choices: [{ delta: { content } }] });
const stop = (usage?: Record<string, unknown>) => frame({ choices: [{ delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) });

test("a stream cut before the provider said it was done is a fault, not an answer", async () => {
  const err = await failureOf(streamed([text("An unfinished")]));
  expect(err.message).toContain("closed before the provider said it was done");
  expect(isProviderOutage(err)).toBe(true);
});

test("either end marker is enough: [DONE] alone, or a finish reason alone", async () => {
  expect((await streamed([text("Done."), "data: [DONE]\n\n"])).content).toBe("Done.");
  expect((await streamed([text("Done."), "data:[DONE]"])).content).toBe("Done.");
  expect((await streamed([text("Done."), stop()])).content).toBe("Done.");
});

test("DONE settles an open stream, preserving late usage but ignoring anything after DONE", async () => {
  const encoder = new TextEncoder();
  const usage = frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  const closed = Promise.withResolvers<void>();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text("Done.") + stop() + usage + "data: [DO"));
      controller.enqueue(encoder.encode("NE]\r\n\r\n" + text("Not part of the answer.")));
    },
    cancel() {
      cancelled = true;
      return closed.promise;
    },
  });
  const mock = mockFetch(async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  try {
    const reply = await chatCompletionStream(llm, [], () => {});
    expect(reply.content).toBe("Done.");
    expect(reply.usage?.completionTokens).toBe(2);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  } finally {
    closed.resolve();
    mock.restore();
  }
}, 2000);

test("an error frame after the status line fails the call, and keeps the status it names", async () => {
  const err = await failureOf(streamed([text("partial"), frame({ error: { message: "Too many concurrent requests", code: 429 } })]));
  expect(err.status).toBe(429);
  expect(err.message).toContain("Too many concurrent requests");
  const withStatus = await failureOf(streamed([frame({ error: { message: "Go usage limit exceeded", code: "usage_limit_reached", status: 429 } })]));
  expect(withStatus.status).toBe(429);
  const unnamed = await failureOf(streamed([text("partial"), frame({ error: { message: "upstream died" } })]));
  expect(unnamed.status).toBe(502);
  expect(isProviderOutage(unnamed)).toBe(true);
});

test("a generation that died says so in its finish reason", async () => {
  for (const reason of ["error", "network_error"]) {
    const err = await failureOf(streamed([text("partial"), frame({ choices: [{ delta: {}, finish_reason: reason }] }), "data: [DONE]\n\n"]));
    expect(err.message).toContain(`finish_reason ${reason}`);
    expect(isProviderOutage(err)).toBe(true);
  }
});

test("a large accounting mismatch on Synthetic makes the response retryable", async () => {
  const draft = "Electric\n=== user message ===\ngo\n\n".repeat(60);
  const err = await failureOf(streamed([
    text(draft),
    stop({ prompt_tokens: 300_000, completion_tokens: 615, completion_tokens_details: { reasoning_tokens: 613 } }),
  ]));
  expect(isMalformedReply(err)).toBe(true);
  expect(err.message).toBe(`${llm.model} reported inconsistent reasoning usage`);
});

test("a Synthetic answer consistent with hidden reasoning usage is accepted", async () => {
  const reply = await streamed([
    text("Yes, the check passed and nothing else is needed."),
    stop({ prompt_tokens: 10, completion_tokens: 420, completion_tokens_details: { reasoning_tokens: 400 } }),
  ]);
  expect(reply.content).toBe("Yes, the check passed and nothing else is needed.");
  expect(reply.usage?.reasoningTokens).toBe(400);
});

test("another provider's usage and technical examples cannot trigger the Synthetic guard", async () => {
  const prose = "Here is the literal marker `<ds_safety>` in a technical example. ".repeat(12);
  const reply = await streamed([
    text(prose),
    stop({ prompt_tokens: 10, completion_tokens: 420, completion_tokens_details: { reasoning_tokens: 419 } }),
  ], { ...llm, baseUrl: "https://other-provider.example/v1" });
  expect(reply.content).toBe(prose);
});

test("a Synthetic accounting mismatch does not open the circuit for its endpoint", async () => {
  const responses = [
    ...Array.from({ length: 5 }, () => stream([
      text("x".repeat(2000)),
      stop({ prompt_tokens: 10, completion_tokens: 615, completion_tokens_details: { reasoning_tokens: 613 } }),
    ])),
    stream([text("Healthy model."), stop()]),
  ];
  const mock = mockFetch(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected call");
    return response;
  });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const err = await failureOf(chatCompletionStream(llm, [], () => {}));
      expect(isMalformedReply(err)).toBe(true);
    }
    const other = { ...llm, model: "synthetic/another-model", apiModel: "another-model" };
    expect((await chatCompletionStream(other, [], () => {})).content).toBe("Healthy model.");
  } finally {
    mock.restore();
  }
});

test("reasoning that arrived on its own channel is never second-guessed", async () => {
  const reply = await streamed([
    frame({ choices: [{ delta: { reasoning_content: "thinking it through" } }] }),
    text("x".repeat(4000)),
    stop({ prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 19 } }),
  ]);
  expect(reply.reasoning).toBe("thinking it through");
});

test("the Synthetic guard requires comparable usage and a large mismatch", () => {
  const usage = (completionTokens: number, reasoningTokens: number) => ({ promptTokens: 1, completionTokens, totalTokens: 1 + completionTokens, reasoningTokens });
  const content = "x".repeat(2000);
  expect(syntheticReasoningMismatch(llm, content, "", usage(615, 613))).toBe(true);
  expect(syntheticReasoningMismatch(llm, content, "", usage(1200, 700))).toBe(false);
  expect(syntheticReasoningMismatch(llm, content, "", usage(10, 100))).toBe(false);
  expect(syntheticReasoningMismatch(llm, content, "", undefined)).toBe(false);
  expect(syntheticReasoningMismatch(llm, "Ok.", "", usage(14, 13))).toBe(false);
  expect(syntheticReasoningMismatch({ ...llm, apiModel: "another-model" }, content, "", usage(615, 613))).toBe(false);
});

test("the buffered path holds the same contract", async () => {
  const body = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  let mock = mockFetch(async () => body({ error: { message: "Provider returned error", code: 503 } }));
  try {
    const err = await failureOf(chatCompletion(llm, [{ role: "user", content: "hi" }]));
    expect(err.status).toBe(503);
  } finally {
    mock.restore();
  }
  mock = mockFetch(async () => body({
    choices: [{ message: { content: "y".repeat(3000) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 699 } },
  }));
  try {
    expect(isMalformedReply(await failureOf(chatCompletion(llm, [{ role: "user", content: "hi" }])))).toBe(true);
  } finally {
    mock.restore();
  }
});

test("a model that reads reasoning_content gets the field on every assistant turn", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "a" },
    // Another model's turn: no reasoning of its own to give.
    { role: "assistant", content: "from another model" },
    { role: "user", content: "b" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      providerMeta: { backend: "openai", model: "deep-1", chat: { field: "reasoning_content", text: "own thought" } },
    },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];
  const wire = applyPromptCache(history, { backend: "openai", model: "deep-1", reasoningField: "reasoning_content" });
  expect(wire[1]!["reasoning_content"]).toBe("");
  expect(wire[3]!["reasoning_content"]).toBe("own thought");
  expect("reasoning_content" in wire[0]!).toBe(false);
  // A model that names no field is sent none, as before.
  const plain = applyPromptCache(history, { backend: "openai", model: "other" });
  expect(plain.some((m) => "reasoning_content" in m)).toBe(false);
});
