import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { compactSession, planCompaction, summaryBodyOf, retainedBudgetFor } from "../src/sessions/compaction.ts";
import { type LegacySessionData, type SessionMessage } from "../src/sessions/store.ts";
import { deleteSession } from "../src/sessions/store.ts";
import type { MyClawConfig } from "../src/core/config.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";
import { sseFromCompletion } from "./helpers/sse.ts";
import { setupSessionLog, appendMessages, writeLegacySessionFile } from "./helpers/session-log.ts";
import type { SessionLog, CompactionEntry, CompactionStoppedEntry } from "../src/sessions/log.ts";
import { contextEntries, promptOf } from "../src/sessions/projection.ts";
import { hooks } from "../src/hooks/index.ts";
import { sessionAffinityHeaders } from "../src/llm/session-headers.ts";

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
    sseFromCompletion({ choices: [{ message: { content: "Summary of earlier context. The user was working on a multi-step task involving code changes." } }] }) as never,
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

// The summarizer prompt is the conversation's own prefix, so it belongs on the backend already
// holding that cache -- and a gateway that routes on the header refuses a call without one
// (docs/session-affinity.md).
test("the summarizer call names the conversation it is compacting", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

  const seen: Headers[] = [];
  const fetchMock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return sseFromCompletion({ choices: [{ message: { content: "Summary of earlier context, long enough to pass the guard on a summary that says nothing." } }] }) as never;
  });

  try {
    await compactSession(makeConfig(), session);
    const expected = sessionAffinityHeaders("https://test.example.com", SESSION_ID, "ua");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.get("x-session-affinity"), expected["x-session-affinity"]);
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
    return sseFromCompletion({ choices: [{ message: { content: `Summary number ${seen.length}, long enough to clear the fifty character floor.` } }] }) as never;
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
    return sseFromCompletion({ choices: [{ message: { content: "Focused summary of the conversation covering the main task and key decisions made." } }] }) as never;
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
    sseFromCompletion({ choices: [{ message: { content: "Summary of the tool usage session covering main operations and their results in detail." } }] }) as never,
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
    return sseFromCompletion({
      choices: [{ message: { content: "Prior work: a summary long enough to clear the fifty character floor imposed on it." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }) as never;
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
    sseFromCompletion({ choices: [{ message: { content: "A summary long enough to be kept as one." } }] }) as never,
  );
  try {
    assert.deepEqual(await settledEvents(() => compactSession(makeConfig(), session)), ["start", "settled"]);
  } finally {
    fetchMock.restore();
  }
});

/**
 * The duration of a compaction, written on the boundary (2026-09-12).
 *
 * Same reason the thinking span is measured at the stream: it is a fact about the turn, and a
 * thread reopened an hour later cannot re-measure it. The clock is injected so the assertion is a
 * value and not a range.
 */
test("the boundary keeps how long the summary took, and replays it", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

  const fetchMock = mockFetch(async () =>
    sseFromCompletion({ choices: [{ message: { content: "Summary of earlier context. The user was working on a multi-step task involving code changes." } }] }) as never,
  );

  try {
    // First read is the start, every later read is the end: 4 250 ms of summary.
    let clock = 1_000;
    const now = (): number => {
      const value = clock;
      clock += 4_250;
      return value;
    };
    const result = await compactSession(makeConfig(), session, undefined, undefined, now);
    assert.equal(result.ok, true);
    assert.equal(result.boundary?.compactionMs, 4_250);

    await log.flush();
    const entry = log.entries().find((candidate): candidate is CompactionEntry => candidate.type === "compaction");
    assert.equal(entry?.compactionMs, 4_250);
  } finally {
    // A fetch mock left standing is shared by every other test file in the run: it answered the
    // adapter's own requests with a stream and took 21 of them down.
    fetchMock.restore();
  }
});

test("a zero span is written as a zero, not dropped", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

  const fetchMock = mockFetch(async () =>
    sseFromCompletion({ choices: [{ message: { content: "Summary of earlier context. The user was working on a multi-step task involving code changes." } }] }) as never,
  );

  try {
    // A clock that never advances is a zero span, which is written rather than dropped here: only the
    // thinking path drops a zero, because there a zero means nothing was ever streamed.
    await compactSession(makeConfig(), session, undefined, undefined, () => 7);
    await log.flush();
    const entry = log.entries().find((candidate): candidate is CompactionEntry => candidate.type === "compaction");
    assert.equal(entry?.compactionMs, 0);
  } finally {
    fetchMock.restore();
  }
});

/**
 * The compaction thinks before it writes, and that thinking is the wait.
 *
 * 2026-09-14: with `reasoning_effort: max` inherited from the session, a summarizer can spend a
 * minute reasoning before the first word of the summary. That reasoning was received and dropped
 * on the floor -- no sink was passed -- so the only thing on screen was a rule with a counter, and
 * a thinking model looked exactly like a dead one. It streams now, like any other turn.
 */
function sseWithReasoning(reasoning: string[], content: string): Response {
  const frames = [
    ...reasoning.map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: piece } }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(frames.join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("a compaction streams what it is thinking, not only what it writes", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

  const thoughts: string[] = [];
  const onReasoning = ({ text }: { text: string }): void => void thoughts.push(text);
  hooks.on("session:compact:reasoning", onReasoning);

  const fetchMock = mockFetch(async () =>
    sseWithReasoning(
      ["Looking at what the user ", "was doing across these turns"],
      "Summary of earlier context. The user was working on a multi-step task involving code changes.",
    ) as never,
  );
  try {
    await compactSession(makeConfig(), session);
    assert.equal(thoughts.join(""), "Looking at what the user was doing across these turns");
  } finally {
    fetchMock.restore();
    hooks.off("session:compact:reasoning", onReasoning);
  }
});

test("a compaction that thinks nothing says nothing", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

  let fired = 0;
  const onReasoning = (): void => void (fired += 1);
  hooks.on("session:compact:reasoning", onReasoning);

  const fetchMock = mockFetch(async () =>
    sseFromCompletion({ choices: [{ message: { content: "Summary of earlier context. The user was working on a multi-step task involving code changes." } }] }) as never,
  );
  try {
    await compactSession(makeConfig(), session);
    assert.equal(fired, 0);
  } finally {
    fetchMock.restore();
    hooks.off("session:compact:reasoning", onReasoning);
  }
});

/**
 * A stopped compaction leaves a trace -- docs/stop.md.
 *
 * A boundary speaks only for a summary that landed, so a pass the owner aborted left nothing at
 * all: minutes of work, no mark, and a thread reopened elsewhere could not tell the operation had
 * been interrupted. The trace is written where the pass stopped, carrying the count a boundary
 * would have carried for the same plan -- every one of those entries still on the branch.
 */
test("a stopped compaction leaves its trace, and no boundary", async () => {
  appendMessages(log, makeMessages(30));
  await log.flush();

  // The plan the pass will be holding when it is aborted: same log, so same middle.
  const planned = planCompaction(log, retainedBudgetFor(makeConfig(), session));
  assert.equal(planned.ok, true);
  const expectedKept = planned.ok ? planned.plan.middle.length : -1;

  const controller = new AbortController();
  const fetchMock = mockFetch(async () => {
    controller.abort();
    throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  });
  try {
    let clock = 1_000;
    const now = (): number => {
      const value = clock;
      clock += 4_250;
      return value;
    };
    await assert.rejects(() => compactSession(makeConfig(), session, undefined, controller.signal, now));
    await log.flush();

    const entries = log.entries();
    const trace = entries.find((candidate): candidate is CompactionStoppedEntry => candidate.type === "compaction_stopped");
    assert.ok(trace, "the stopped pass must leave a trace");
    assert.equal(trace.kept, expectedKept);
    assert.equal(trace.prompt, false);
    assert.equal(trace.compactionMs, 8_500);
    assert.equal(entries.some((candidate) => candidate.type === "compaction"), false, "nothing folded, so no boundary");
  } finally {
    fetchMock.restore();
  }
});

test("a failing compaction writes no trace: it is still running, and it failed", async () => {
  appendMessages(log, makeMessages(12));
  await log.flush();

  const fetchMock = mockFetch(async () =>
    new Response(JSON.stringify({ error: { message: "model overloaded" } }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }) as never,
  );
  try {
    const result = await compactSession(makeConfig(), session);
    assert.equal(result.ok, false);
    await log.flush();
    assert.equal(log.entries().some((candidate) => candidate.type === "compaction_stopped"), false);
  } finally {
    fetchMock.restore();
  }
});

test("a stopped pass never moves the boundary: the prompt is exactly what it was", async () => {
  // A first compaction lands, so there is a floor to protect, then the log grows past it.
  appendMessages(log, makeMessages(12));
  await log.flush();
  const okMock = mockFetch(async () =>
    sseFromCompletion({ choices: [{ message: { content: "Summary of earlier context. The user was working on a multi-step task involving code changes." } }] }) as never,
  );
  let boundaryId = "";
  try {
    const result = await compactSession(makeConfig(), session);
    if (!result.ok) assert.fail(`the first compaction must land: ${result.reason}`);
    boundaryId = result.boundary?.entryId ?? "";
  } finally {
    okMock.restore();
  }
  appendMessages(log, makeMessages(20).map((message) => ({ ...message, content: `${message.content} again` })));
  await log.flush();

  const planned = planCompaction(log, retainedBudgetFor(makeConfig(), session));
  assert.equal(planned.ok, true, "the second pass has something to fold");
  const promptBefore = promptOf(log.entries(), log.leaf());

  const controller = new AbortController();
  const abortMock = mockFetch(async () => {
    controller.abort();
    throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  });
  try {
    await assert.rejects(() => compactSession(makeConfig(), session, undefined, controller.signal));
    await log.flush();
  } finally {
    abortMock.restore();
  }

  const entries = log.entries();
  assert.ok(entries.some((candidate) => candidate.type === "compaction_stopped"), "the trace is there");

  // The trace is not a ceiling: the floor is still the boundary, entry for entry.
  const context = contextEntries(entries, log.leaf());
  assert.equal(context[0]?.type, "compaction");
  assert.equal(context[0]?.id, boundaryId);
  assert.equal(context.some((candidate) => candidate.type === "compaction_stopped"), false);
  // And the prompt the model would get is unchanged, message for message.
  assert.deepEqual(promptOf(entries, log.leaf()), promptBefore);
});

/**
 * The split ignores what the gate obeys -- docs/compaction.md.
 *
 * A session's ceilings -- its Context choice, a tag route's cap -- are the gate's brakes: they
 * decide *when* a run compacts. They never decide how much verbatim survives one: this automatic
 * pass sizes its tail on the model's declared window, whole, exactly as `/compact` does. One
 * policy, one function (`retainedBudgetFor`); the command's file pins the same side, the gate's is
 * pinned by `tests/agent/bridge-context.test.ts`.
 */
function declaredWindowConfig(over?: Partial<MyClawConfig>): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: {
      defaultProvider: "test",
      defaultModel: "big-model",
      apiKey: "k",
      vision: false,
      // The global fallback sits below the model's own declaration, so a reader that fell back
      // to it would show up in the tail.
      limit: { context: 200_000, output: 4096 },
      providers: { test: { baseUrl: "https://test.example.com", apiKeyEnv: "TEST_KEY" } },
      models: [{ id: "big-model", label: "Big", provider: "test", limit: { context: 1_000_000 } }],
    },
    agents: {},
    webSearch: { baseUrl: "", language: "en" },
    ...over,
  } as unknown as MyClawConfig;
}

test("the automatic tail ignores the session's context override", () => {
  const config = declaredWindowConfig();
  const session = sessionMeta();
  session.modelOverride = "big-model";
  session.contextOverride = 30_000;

  // The declared 1M window leaves the full 20 000 budget; a capped reading would halve a 30 000
  // window's threshold, under 12 000.
  assert.equal(retainedBudgetFor(config, session), 20_000);

  session.contextOverride = "full";
  assert.equal(retainedBudgetFor(config, session), 20_000);
});

test("the automatic tail ignores a tag's contextCap", () => {
  const config = declaredWindowConfig({ tags: { cheap: { model: "big-model", contextCap: 30_000 } } });
  const session = sessionMeta();
  session.modelOverride = "tag:cheap";

  assert.equal(retainedBudgetFor(config, session), 20_000);
});
