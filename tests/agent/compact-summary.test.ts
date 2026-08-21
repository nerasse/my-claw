/**
 * The summary a compaction produces. There is one engine now, so the summary is the local
 * summarizer's own output rather than something read back out of an engine-owned transcript: it is
 * returned to the caller *and* left in the history as the message the next run resumes from.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { compactSession } from "../../src/sessions/compaction.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { SessionData } from "../../src/sessions/store.ts";

function config(): MyClawConfig {
  return {
    whitelist: [], blacklist: [], channels: {},
    llm: {
      defaultProvider: "test",
      defaultModel: "test-model",
      providers: { test: { baseUrl: "https://test.example.com", apiKeyEnv: "TEST_KEY" } },
      models: [{ id: "test-model", label: "Test", provider: "test" }],
    },
    agents: {},
  } as unknown as MyClawConfig;
}

/** Long enough for the summarizer to have a middle to replace between head and tail. */
function session(): SessionData {
  const now = new Date().toISOString();
  return {
    id: "my-claw-app/thread/neras/compact",
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: now,
    lastActiveAt: now,
    modelOverride: "test-model",
    messages: Array.from({ length: 14 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn ${i} ${"filler ".repeat(20)}`,
      timestamp: now,
    })),
  };
}

function reply(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: {} }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const SUMMARY = `1. What the owner asked 2. What was built ${"and the rest of it ".repeat(5)}`;

test("the summary is returned and left in the history as the message the next run resumes from", async () => {
  const mock = mockFetch(async () => reply(SUMMARY));
  try {
    const s = session();
    const before = s.messages.length;
    const result = await compactSession(config(), s);
    assert.equal(result.ok, true);
    assert.equal(result.summary, SUMMARY.trim());
    assert.equal(result.beforeCount, before);
    assert.ok(result.afterCount < before);
    // The summary is in the history, wrapped so the model reads it as prior context.
    const kept = s.messages.find((m) => m.content.includes(SUMMARY.trim()));
    assert.ok(kept, "the summary must survive in the session it compacted");
    assert.match(kept!.content, /Prior context summarized/);
  } finally {
    mock.restore();
  }
});

test("extra instructions ride along in the summarizer's prompt", async () => {
  let sent = "";
  const mock = mockFetch(async (_url, init) => {
    sent = String((init as RequestInit | undefined)?.body ?? "");
    return reply(SUMMARY);
  });
  try {
    await compactSession(config(), session(), "keep every file path");
    assert.match(sent, /keep every file path/);
  } finally {
    mock.restore();
  }
});

test("an empty or too-short summary is refused rather than written over the history", async () => {
  for (const content of ["", "too short"]) {
    const mock = mockFetch(async () => reply(content));
    try {
      const s = session();
      const before = [...s.messages];
      const result = await compactSession(config(), s);
      assert.equal(result.ok, false);
      assert.equal(result.afterCount, before.length);
      assert.deepEqual(s.messages, before, "a refused compaction must leave the history untouched");
    } finally {
      mock.restore();
    }
  }
});

test("a refusal is detected as one instead of being stored as the context", async () => {
  const mock = mockFetch(async () => reply(`I cannot summarize this conversation ${"for you ".repeat(10)}`));
  try {
    const s = session();
    const result = await compactSession(config(), s);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /refused/);
  } finally {
    mock.restore();
  }
});

test("a session too short to compact says so before reaching the wire", async () => {
  const mock = mockFetch(async () => {
    throw new Error("the summarizer must not be called");
  });
  try {
    const s = { ...session(), messages: [] };
    const result = await compactSession(config(), s);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /too short/);
  } finally {
    mock.restore();
  }
});
