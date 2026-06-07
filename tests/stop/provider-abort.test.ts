import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { chatCompletion, type ChatMessage } from "../../src/llm/provider.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import type { ResolvedLlmConfig } from "../../src/core/config.ts";

const config: ResolvedLlmConfig = {
  provider: "x",
  baseUrl: "https://example.com",
  model: "m",
};

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

test("chatCompletion: already-aborted signal throws AbortedError before any fetch", async () => {
  let calls = 0;
  const fetchMock = mockFetch(async () => {
    calls++;
    return new Response("{}", { status: 200 }) as never;
  });
  const c = new AbortController();
  c.abort();
  try {
    await assert.rejects(() => chatCompletion(config, messages, undefined, c.signal), AbortedError);
    assert.equal(calls, 0);
  } finally {
    fetchMock.restore();
  }
});

test("chatCompletion: abort during request throws AbortedError and does NOT retry", async () => {
  let calls = 0;
  const fetchMock = mockFetch((_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      const sig = (init as RequestInit | undefined)?.signal;
      sig?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }) as never;
  });
  const c = new AbortController();
  try {
    const p = chatCompletion(config, messages, undefined, c.signal);
    setTimeout(() => c.abort(), 20);
    await assert.rejects(() => p, AbortedError);
    assert.equal(calls, 1); // no retry on user abort
  } finally {
    fetchMock.restore();
  }
});
