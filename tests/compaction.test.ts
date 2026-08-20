import { test } from "bun:test";
import assert from "node:assert/strict";
import { compactSession } from "../src/sessions/compaction.ts";
import type { SessionData } from "../src/sessions/store.ts";
import type { MyClawConfig } from "../src/core/config.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";

function makeSession(messagesCount: number): SessionData {
  const messages = Array.from({ length: messagesCount }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${i + 1}`,
    timestamp: new Date().toISOString(),
  } as const));

  return {
    id: "test-session",
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: messages.map((m) => ({ ...m })),
  };
}

function makeConfig(): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: { "my-claw-app": { enabled: true, port: 8080 } },
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
  assert.ok(result.reason?.includes("too short"));
  assert.equal(result.beforeCount, 5);
  assert.equal(result.afterCount, 5);
  assert.equal(session.messages.length, 5);
});

test("compactSession summarizes middle and keeps head + tail", async () => {
  const session = makeSession(12);
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "Summary of earlier context. The user was working on a multi-step task involving code changes." } }] }),
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
    assert.equal(session.messages[0]!.content, "Message 1");
    assert.equal(session.messages[1]!.content, "Message 2");
    assert.equal(session.messages[2]!.content, "Message 3");

    // Summary inserted
    assert.ok(session.messages[3]!.content.includes("Summary of earlier context."));
    assert.ok(session.messages[3]!.content.includes("Prior context summarized"));
    assert.equal(session.messages[3]!.role, "user");

    // Tail preserved
    assert.equal(session.messages[4]!.content, "Message 9");
    assert.equal(session.messages[5]!.content, "Message 10");
    assert.equal(session.messages[6]!.content, "Message 11");
    assert.equal(session.messages[7]!.content, "Message 12");
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
      capturedBody = new TextDecoder().decode(body as Uint8Array);
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Focused summary of the conversation covering the main task and key decisions made." } }] }),
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
      JSON.stringify({ choices: [{ message: { content: "Summary of the tool usage session covering main operations and their results in detail." } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const result = await compactSession(makeConfig(), session);
    assert.equal(result.ok, true);

    // The tool pair should either be fully in head, fully in middle, or fully in tail
    // Since head is 3 and tail is 4, the pair at indices 3-4 is in the middle
    // But the tail boundary alignment should ensure nothing is split
    const summaryIdx = session.messages.findIndex((m) => m.content.includes("Summary of the tool usage"));
    assert.ok(summaryIdx > 0);

    // Messages before summary should not have orphaned tool results
    for (let i = 0; i < summaryIdx; i++) {
      const cur = session.messages[i]!;
      if (cur.role === "tool") {
        const prev = session.messages[i - 1];
        assert.ok(prev?.role === "assistant" && prev.toolCalls?.some((tc) => tc.id === cur.toolCallId));
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
    assert.ok(result.reason?.includes("Compaction error"));
    assert.equal(session.messages.length, 12); // untouched
  } finally {
    fetchMock.restore();
  }
});

/**
 * The summarizer follows the session's own agent. Reading it as the orchestrator's is how a
 * sub-agent pinned to a cheap provider came to be summarized by the expensive default, and a cron
 * job by whatever the chat happened to run.
 */
function agentScopedConfig(): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: {
      providers: { main: { baseUrl: "https://main.example.com" }, cheap: { baseUrl: "https://cheap.example.com" } },
      defaultProvider: "main",
      defaultModel: "main-model",
      models: [
        { id: "main-model", label: "Main", provider: "main" },
        { id: "cheap-model", label: "Cheap", provider: "cheap" },
      ],
    },
    agents: { general: { llm: { defaultModel: "cheap-model" } }, cron: { llm: { defaultModel: "cheap-model" } } },
  } as unknown as MyClawConfig;
}

function longSession(over: Partial<SessionData>): SessionData {
  const now = new Date().toISOString();
  return {
    id: "s",
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: now,
    lastActiveAt: now,
    messages: Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i} `.repeat(20),
      timestamp: now,
    })),
    ...over,
  };
}

async function summarizerHost(session: SessionData): Promise<string[]> {
  const hosts: string[] = [];
  const mock = mockFetch(async (url) => {
    hosts.push(new URL(String(url)).host);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Prior work: a summary long enough to clear the fifty character floor imposed on it." } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });
  try {
    const result = await compactSession(agentScopedConfig(), session);
    assert.equal(result.ok, true, result.reason ?? "");
    return hosts;
  } finally {
    mock.restore();
  }
}

test("a sub-agent session is summarized by the sub-agent's own model", async () => {
  const session = longSession({
    id: "subagent/general-1",
    meta: { displayName: "worker", type: "general", parentSessionId: "telegram/dm/u1", visibility: "private", createdAt: new Date().toISOString() },
  });
  assert.deepEqual(await summarizerHost(session), ["cheap.example.com"]);
});

test("a cron session is summarized by the cron agent's model", async () => {
  assert.deepEqual(await summarizerHost(longSession({ id: "cron/job-1/1", platform: "cron" })), ["cheap.example.com"]);
});

test("a chat session still follows the orchestrator", async () => {
  assert.deepEqual(await summarizerHost(longSession({ id: "my-claw-app/dm/u1" })), ["main.example.com"]);
});
