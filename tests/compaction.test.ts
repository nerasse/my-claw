import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { compactSession, summaryBodyOf } from "../src/sessions/compaction.ts";
import { type LegacySessionData, type SessionMessage } from "../src/sessions/store.ts";
import { deleteSession } from "../src/sessions/store.ts";
import type { MyClawConfig } from "../src/core/config.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";
import { setupSessionLog, appendMessages, writeLegacySessionFile } from "./helpers/session-log.ts";
import type { SessionLog, CompactionEntry } from "../src/sessions/log.ts";
import { contextEntries } from "../src/sessions/projection.ts";
import { hooks } from "../src/hooks/index.ts";

const SESSION_ID = "test-compaction";

function makeMessages(count: number): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${i + 1}`,
    timestamp: new Date().toISOString(),
  } as const));
}

function sessionMeta(): LegacySessionData {
  return {
    id: SESSION_ID,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
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
    // The tail is a token budget now, and these fixtures are a dozen tiny messages: without a
    // small budget the whole conversation fits in the tail and there is nothing to summarise.
    context: { autoCompact: { tailTokens: 40 } },
    webSearch: { baseUrl: "", language: "fr" },
  };
}

let log: SessionLog;
let cleanupLog: () => void;
let session: LegacySessionData;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  session = sessionMeta();
  await writeLegacySessionFile(SESSION_ID, session);
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
});

test("compactSession refuses sessions with fewer than 10 entries", async () => {
  appendMessages(log, makeMessages(5));
  await log.flush();

  const result = await compactSession(makeConfig(), session);
  assert.equal(result.ok, false);
  assert.ok(result.reason?.includes("too short"));
  assert.equal(result.beforeCount, 5);
  assert.equal(result.afterCount, 5);
});

test("compactSession writes a compaction entry and shrinks the context", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

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
    // After compaction: compaction entry + tail entries
    assert.ok(result.afterCount < result.beforeCount);

    // Check the log has a compaction entry
    await log.flush();
    const entries = log.entries();
    const compactionEntry = entries.find((e): e is CompactionEntry => e.type === "compaction");
    assert.ok(compactionEntry, "compaction entry should exist");
    assert.ok(compactionEntry.summary.includes("Summary of earlier context"));
    assert.ok(compactionEntry.count > 0);

    // The context should now be smaller
    const context = contextEntries(entries, log.leaf());
    assert.equal(context.length, result.afterCount);
  } finally {
    fetchMock.restore();
  }
});

/**
 * The second compaction is the one the boundary can get wrong: re-reading from index 0 would
 * summarise the previous summary and re-bill turns no model can see any more.
 */
test("a second compaction summarizes only what is past the previous boundary", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

  const seen: string[] = [];
  const fetchMock = mockFetch(async (_url, init) => {
    const body = init?.body;
    seen.push(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: `Summary number ${seen.length}, long enough to clear the fifty character floor.` } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const first = await compactSession(makeConfig(), session);
    assert.equal(first.ok, true);

    // Add more entries to get back over the floor (alternating user/assistant)
    for (let i = 13; i <= 24; i++) {
      if (i % 2 === 1) {
        log.append({ type: "user", prompt: true, text: `Message ${i}` } as any);
      } else {
        log.append({ type: "phase", prompt: true, text: `Message ${i}`, runId: `run-${i}` } as any);
      }
    }
    await log.flush();

    const second = await compactSession(makeConfig(), session);
    assert.equal(second.ok, true);

    // The first 8 entries are behind the first compaction boundary: they must not appear in the second prompt
    const secondPrompt = seen[1]!;
    // Use word boundary patterns to avoid matching "Message 10" when looking for "Message 1"
    assert.ok(!secondPrompt.includes("User: Message 1\n"), "Message 1 should be behind the first boundary");
    assert.ok(!secondPrompt.includes("User: Message 3\n"), "Message 3 should be behind the first boundary");
    // But the tail from the first compaction should be there (Message 9-12)
    assert.ok(secondPrompt.includes("User: Message 9"), "Message 9 should be in second prompt");
  } finally {
    fetchMock.restore();
  }
});

test("compactSession passes instructions to the prompt", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

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

test("compactSession handles tool entries without splitting them", async () => {
  const messages: SessionMessage[] = makeMessages(12);
  // Replace some messages with tool pairs
  messages[3] = {
    role: "assistant",
    content: "Using tool...",
    timestamp: new Date().toISOString(),
    toolCalls: [{ id: "tc1", name: "bash", arguments: "{}" }],
  };
  messages[4] = {
    role: "tool",
    toolCallId: "tc1",
    content: "tool output",
    timestamp: new Date().toISOString(),
  };
  appendMessages(log, messages);
  await log.flush();

  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "Summary of the tool usage session covering main operations and their results in detail." } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const result = await compactSession(makeConfig(), session);
    assert.equal(result.ok, true);

    // The context should be valid (no orphaned tool entries at the start)
    const context = contextEntries(log.entries(), log.leaf());
    if (context[0]?.type === "tool") {
      throw new Error("Context starts with orphaned tool entry");
    }
  } finally {
    fetchMock.restore();
  }
});

test("compactSession handles LLM errors gracefully", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

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
    assert.equal(result.beforeCount, 12);
    assert.equal(result.afterCount, 12);
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
    context: { autoCompact: { tailTokens: 40 } },
  } as unknown as MyClawConfig;
}

async function summarizerHost(sessionId: string, sessionOver: Partial<LegacySessionData>): Promise<string[]> {
  await deleteSession(sessionId);
  const now = new Date().toISOString();
  const testSession: LegacySessionData = {
    id: sessionId,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: now,
    lastActiveAt: now,
    messages: [],
    ...sessionOver,
  };
  await writeLegacySessionFile(sessionId, testSession);

  const setup = await setupSessionLog(sessionId);
  const testLog = setup.log;
  // Add 20 entries
  for (let i = 0; i < 20; i++) {
    testLog.append({
      type: i % 2 === 0 ? "user" : "phase",
      prompt: true,
      ...(i % 2 === 0 ? { text: `turn ${i} `.repeat(20) } : { text: `turn ${i} `.repeat(20), runId: `run-${i}` }),
    } as any);
  }
  await testLog.flush();

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
    const result = await compactSession(agentScopedConfig(), testSession);
    assert.equal(result.ok, true, result.reason ?? "");
    return hosts;
  } finally {
    mock.restore();
    setup.cleanup();
  }
}

test("a sub-agent session is summarized by the sub-agent's own model", async () => {
  const hosts = await summarizerHost("subagent/general-1", {
    id: "subagent/general-1",
    meta: { displayName: "worker", type: "general", parentSessionId: "telegram/dm/u1", visibility: "private", createdAt: new Date().toISOString() },
  });
  assert.deepEqual(hosts, ["cheap.example.com"]);
});

test("a cron session is summarized by the cron agent's model", async () => {
  const hosts = await summarizerHost("cron/job-1/1", { id: "cron/job-1/1", platform: "cron" });
  assert.deepEqual(hosts, ["cheap.example.com"]);
});

test("a chat session still follows the orchestrator", async () => {
  const hosts = await summarizerHost("my-claw-app/dm/u1", { id: "my-claw-app/dm/u1" });
  assert.deepEqual(hosts, ["main.example.com"]);
});

/**
 * Something on screen says "compacting" for as long as the operation runs, and the only event
 * that can take it away is one that no exit path can skip. `end` and `error` cover two of the
 * five ways out: a session too short, a summarizer that answered nothing, and an abort that
 * rethrows all left the start unanswered -- and the bubble up until the next reload.
 */
async function settledEvents(run: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const onStart = (): void => void seen.push("start");
  const onSettled = (): void => void seen.push("settled");
  hooks.on("session:compact:start", onStart);
  hooks.on("session:compact:settled", onSettled);
  try {
    await run().catch(() => {});
  } finally {
    hooks.off("session:compact:start", onStart);
    hooks.off("session:compact:settled", onSettled);
  }
  return seen;
}

test("a compaction that cannot even start settles", async () => {
  appendMessages(log, makeMessages(5));
  await log.flush();

  assert.deepEqual(await settledEvents(() => compactSession(makeConfig(), session)), ["start", "settled"]);
});

test("a compaction the model fails settles", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

  const fetchMock = mockFetch(async () =>
    new Response(JSON.stringify({ error: { message: "model overloaded" } }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }) as never,
  );
  try {
    assert.deepEqual(await settledEvents(() => compactSession(makeConfig(), session)), ["start", "settled"]);
  } finally {
    fetchMock.restore();
  }
});

test("a compaction the owner aborts settles on its way out", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

  const controller = new AbortController();
  const fetchMock = mockFetch(async () => {
    controller.abort();
    throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  });
  try {
    const seen = await settledEvents(() => compactSession(makeConfig(), session, undefined, controller.signal));
    assert.deepEqual(seen, ["start", "settled"]);
  } finally {
    fetchMock.restore();
  }
});

test("a compaction that succeeds settles too", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "A summary long enough to be kept as one." } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );
  try {
    assert.deepEqual(await settledEvents(() => compactSession(makeConfig(), session)), ["start", "settled"]);
  } finally {
    fetchMock.restore();
  }
});
