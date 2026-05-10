import { test } from "bun:test";
import assert from "node:assert/strict";
import { compactSession } from "../src/sessions/compaction.ts";
import type { SessionData } from "../src/sessions/store.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";

function makeSession(messagesCount: number): SessionData {
  const messages = Array.from({ length: messagesCount }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${i + 1}`,
    timestamp: new Date().toISOString(),
  } as const));

  return {
    id: "test-session",
    platform: "telegram",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: messages.map((m) => ({ ...m })),
  };
}

function makeConfig() {
  return {
    whitelist: [],
    blacklist: [],
    channels: {
      telegram: {
        enabled: true,
        token: "",
        mode: "polling",
        dm: { enabled: true, policy: "allowlist", allowFrom: [], sessionScope: "per-user" },
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        allowBots: false,
        groups: { "*": { enabled: true, autoReply: true } },
        contextVisibility: "allowlist_quote",
        streaming: { enabled: true, minChars: 30, throttleMs: 1000 },
        reactions: {
          enabled: true,
          received: "r",
          thinking: "t",
          toolUse: "u",
          done: "d",
          error: "e",
        },
        errorPolicy: "always",
      },
      matrix: {
        enabled: false,
        homeserver: "",
        accessToken: "",
        encryption: false,
        userId: "",
        password: "",
        deviceId: "",
        displayName: "",
        autoJoin: "allowlist",
        dm: { enabled: true, policy: "allowlist", allowFrom: [], sessionScope: "per-user", threadReplies: "inbound", historyLimit: 10 },
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        allowBots: false,
        groups: { "*": { enabled: true, autoReply: true } },
        threadReplies: "inbound",
        replyToMode: "first",
        historyLimit: 10,
        textChunkLimit: 4000,
        chunkMode: "newline",
        contextVisibility: "allowlist_quote",
        streaming: { enabled: true, mode: "partial", minChars: 30, throttleMs: 1000 },
        reactions: {
          enabled: true,
          received: "r",
          thinking: "t",
          toolUse: "u",
          done: "d",
          error: "e",
        },
        errorPolicy: "always",
        mediaMaxMb: 25,
      },
    },
    llm: {
      defaultProvider: "test",
      defaultModel: "test-model",
      apiKey: "test-key",
      vision: true,
      limit: { context: 128000, output: 4096 },
      providers: {
        test: { baseUrl: "https://test.example.com", apiKeyEnv: "TEST_KEY" },
      },
      models: [
        { id: "test-model", label: "Test Model", provider: "test" },
      ],
    },
    agents: {
      general: { llm: { defaultModel: "test-model" } },
      research: { llm: { defaultModel: "test-model" } },
    },
    webSearch: { baseUrl: "", language: "fr" },
  };
}

test("compactSession refuses sessions with fewer than 10 messages", async () => {
  const session = makeSession(5);
  const result = await compactSession(makeConfig(), session);
  assert.equal(result.ok, false);
  assert.ok(result.reason?.includes("trop courte"));
  assert.equal(result.beforeCount, 5);
  assert.equal(result.afterCount, 5);
  assert.equal(session.messages.length, 5);
});

test("compactSession summarizes middle and keeps head + tail", async () => {
  const session = makeSession(12);
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "Summary of earlier context." } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const result = await compactSession(makeConfig(), session);
    assert.equal(result.ok, true);
    assert.equal(result.beforeCount, 12);
    assert.equal(result.afterCount, 8); // 3 head + 1 summary + 4 tail
    assert.equal(session.messages.length, 8);

    // Head preserved
    assert.equal(session.messages[0].content, "Message 1");
    assert.equal(session.messages[1].content, "Message 2");
    assert.equal(session.messages[2].content, "Message 3");

    // Summary inserted
    assert.ok(session.messages[3].content.includes("Summary of earlier context."));
    assert.ok(session.messages[3].content.includes("Contexte anterieur resume"));
    assert.equal(session.messages[3].role, "user");

    // Tail preserved
    assert.equal(session.messages[4].content, "Message 9");
    assert.equal(session.messages[5].content, "Message 10");
    assert.equal(session.messages[6].content, "Message 11");
    assert.equal(session.messages[7].content, "Message 12");
  } finally {
    fetchMock.restore();
  }
});

test("compactSession passes instructions to the prompt", async () => {
  const session = makeSession(12);
  let capturedBody = "";

  const fetchMock = mockFetch(async (_url, init) => {
    const body = init?.body;
    if (typeof body === "string") {
      capturedBody = body;
    } else if (body && typeof (body as ArrayBufferView).byteLength === "number") {
      capturedBody = new TextDecoder().decode(body as ArrayBufferView);
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Focused summary." } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    await compactSession(makeConfig(), session, "focus on API design");
    assert.ok(capturedBody.includes("focus on API design"));
  } finally {
    fetchMock.restore();
  }
});

test("compactSession handles tool pairs without splitting them", async () => {
  const session = makeSession(12);
  // Replace some messages with tool pairs
  session.messages[3] = {
    role: "assistant",
    content: "Using tool...",
    timestamp: new Date().toISOString(),
    toolCalls: [{ id: "tc1", name: "bash", arguments: "{}" }],
  };
  session.messages[4] = {
    role: "tool",
    toolCallId: "tc1",
    content: "tool output",
    timestamp: new Date().toISOString(),
  };

  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "Summary." } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const result = await compactSession(makeConfig(), session);
    assert.equal(result.ok, true);

    // The tool pair should either be fully in head, fully in middle, or fully in tail
    // Since head is 3 and tail is 4, the pair at indices 3-4 is in the middle
    // But the tail boundary alignment should ensure nothing is split
    const summaryIdx = session.messages.findIndex((m) => m.content.includes("Summary."));
    assert.ok(summaryIdx > 0);

    // Messages before summary should not have orphaned tool results
    for (let i = 0; i < summaryIdx; i++) {
      if (session.messages[i].role === "tool") {
        const prev = session.messages[i - 1];
        assert.ok(prev?.role === "assistant" && prev.toolCalls?.some((tc) => tc.id === session.messages[i].toolCallId));
      }
    }
  } finally {
    fetchMock.restore();
  }
});

test("compactSession handles LLM errors gracefully", async () => {
  const session = makeSession(12);
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({ error: { message: "model overloaded" } }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const result = await compactSession(makeConfig(), session);
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("Erreur"));
    assert.equal(session.messages.length, 12); // untouched
  } finally {
    fetchMock.restore();
  }
});
