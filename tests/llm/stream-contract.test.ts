/**
 * What a chat-completions reply has to be before it is an answer.
 *
 * The transport used to take whatever arrived: a stream cut mid-sentence, an error frame sent after
 * the status line, a reply whose usage billed its content as reasoning. Each became a phase of the
 * log and was replayed to every later request. These are the contracts opencode and pi-ai enforce
 * on the same protocol, plus the one the provider's own accounting makes possible.
 */

import { test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { chatCompletion, chatCompletionStream, applyPromptCache, type ChatMessage } from "../../src/llm/provider.ts";
import { isMalformedReply, isProviderOutage } from "../../src/llm/outage.ts";
import { reasoningSentAsAnswer } from "../../src/llm/answer-accounting.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";

const llm = {
  model: "synthetic/deep-1",
  apiModel: "deep-1",
  baseUrl: "https://provider.example/v1",
  apiKey: "k",
  backend: "openai",
} as unknown as ResolvedLlmConfig;

const frame = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

function stream(frames: string[]): Response {
  return new Response(frames.join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function streamed(frames: string[]) {
  const mock = mockFetch(async () => stream(frames) as never);
  try {
    return await chatCompletionStream(llm, [{ role: "user", content: "hi" }], () => {});
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
  expect((await streamed([text("Done."), stop()])).content).toBe("Done.");
});

test("an error frame after the status line fails the call, and keeps the status it names", async () => {
  const err = await failureOf(streamed([text("partial"), frame({ error: { message: "Too many concurrent requests", code: 429 } })]));
  expect(err.status).toBe(429);
  expect(err.message).toContain("Too many concurrent requests");
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

test("content the usage bills as reasoning is the model's thinking, not its answer", async () => {
  // The shape measured on Synthetic's DeepSeek lane: 613 of 615 completion tokens billed as
  // reasoning, no reasoning text, and two thousand characters of `content`.
  const draft = "Electric\n=== user message ===\ngo\n\n".repeat(60);
  const err = await failureOf(streamed([
    text(draft),
    stop({ prompt_tokens: 300_000, completion_tokens: 615, completion_tokens_details: { reasoning_tokens: 613 } }),
  ]));
  expect(isMalformedReply(err)).toBe(true);
  expect(err.message).toBe("synthetic/deep-1 sent its reasoning as the answer");
});

test("a model whose reasoning stays hidden answers within what it billed", async () => {
  const reply = await streamed([
    text("Yes, the check passed and nothing else is needed."),
    stop({ prompt_tokens: 10, completion_tokens: 420, completion_tokens_details: { reasoning_tokens: 400 } }),
  ]);
  expect(reply.content).toBe("Yes, the check passed and nothing else is needed.");
  expect(reply.usage?.reasoningTokens).toBe(400);
});

test("reasoning that arrived on its own channel is never second-guessed", async () => {
  const reply = await streamed([
    frame({ choices: [{ delta: { reasoning_content: "thinking it through" } }] }),
    text("x".repeat(4000)),
    stop({ prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 19 } }),
  ]);
  expect(reply.reasoning).toBe("thinking it through");
});

test("the accounting rule, on its own", () => {
  const usage = (completionTokens: number, reasoningTokens: number) => ({ promptTokens: 1, completionTokens, totalTokens: 1, reasoningTokens });
  expect(reasoningSentAsAnswer("x".repeat(2000), "", usage(615, 613))).toBe(true);
  expect(reasoningSentAsAnswer("x".repeat(2000), "", usage(1200, 700))).toBe(false);
  expect(reasoningSentAsAnswer("x".repeat(2000), "seen", usage(615, 613))).toBe(false);
  expect(reasoningSentAsAnswer("x".repeat(2000), "", undefined)).toBe(false);
  expect(reasoningSentAsAnswer("Ok.", "", usage(14, 13))).toBe(false);
});

test("the buffered path holds the same contract", async () => {
  const body = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  let mock = mockFetch(async () => body({ error: { message: "Provider returned error", code: 503 } }) as never);
  try {
    const err = await failureOf(chatCompletion(llm, [{ role: "user", content: "hi" }]));
    expect(err.status).toBe(503);
  } finally {
    mock.restore();
  }
  mock = mockFetch(async () => body({
    choices: [{ message: { content: "y".repeat(3000) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 699 } },
  }) as never);
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
