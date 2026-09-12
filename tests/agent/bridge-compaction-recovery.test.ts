import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { sseResponse } from "../helpers/sse.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { pendingSpeculation, resetSpeculations } from "../../src/sessions/compaction-speculative.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import { contextEntries } from "../../src/sessions/projection.ts";
import type { SessionLog, UserEntry, PhaseEntry } from "../../src/sessions/log.ts";

/**
 * The two paths that were missing entirely -- docs/compaction.md.
 *
 * Recovery: the gate is an estimate, so it can be wrong in the direction that hurts. Until now the
 * only thing behind it was `trimToContextWindow`, which keeps the request legal by dropping the
 * oldest turns out of the prompt -- the conversation loses its beginning with nothing summarised.
 *
 * Speculation: the compaction happens while the owner reads the answer he already has, so the
 * crossing itself is an append.
 */

const SESSION_ID = "test-compaction-recovery";
const SUMMARY = `Prior work: the owner asked for a long report and the agent produced it. ${"detail ".repeat(20)}`;

function config(): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: {
      defaultProvider: "test",
      defaultModel: "test-model",
      providers: { test: { baseUrl: "https://test.example.com" } },
      models: [{ id: "test-model", label: "Test", provider: "test" }],
    },
    agents: {},
    memory: { enabled: false },
    // A 200k window puts the gate at 160000 and the speculation band at [140000, 160000). Wide on
    // purpose: these fixtures must only ever be compacted by the path under test, never by the
    // ordinary threshold gate.
    context: { cap: 200_000, autoCompact: { tailTokens: 6_000 } },
  } as unknown as MyClawConfig;
}

function message(id: string, text: string): UnifiedMessage {
  return { id, platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}

function session(): LegacySessionData {
  const now = new Date().toISOString();
  return { id: SESSION_ID, platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}

function reply(content: string, promptTokens: number): never {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ) as never;
}

function isSummarizer(body: string): boolean {
  return body.includes("You summarize a conversation");
}

let log: SessionLog;
let cleanup: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, session());
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanup = setup.cleanup;
});

afterEach(() => {
  resetSpeculations();
  cleanup();
  runRegistry.clear();
});

/** Enough conversation for a summary to have something to stand for. */
function history(turns: number, startAt = 1): void {
  for (let i = 0; i < turns; i++) {
    const n = startAt + i;
    log.append<UserEntry>({ type: "user", prompt: true, text: `Question ${n} ${"padding ".repeat(125)}` });
    log.append<PhaseEntry>({ type: "phase", prompt: true, runId: `r${n}`, text: `Answer ${n} ${"padding ".repeat(125)}` });
  }
}

test("a context overflow the gate never saw is compacted and retried, not dropped by the hard trim", async () => {
  history(20);
  await log.flush();

  const sess = session();
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(sess.id);
  const calls: string[] = [];
  let runCalls = 0;

  const mock = mockFetch(async (_url, init) => {
    const body = String(init?.body ?? "{}");
    if (isSummarizer(body)) {
      calls.push("summarizer");
      return sseResponse(SUMMARY);
    }
    calls.push("run");
    runCalls += 1;
    // The provider refuses the first prompt on length grounds, the way every one of them does.
    if (runCalls === 1) {
      return new Response(
        JSON.stringify({ error: { message: "This model's maximum context length is 200000 tokens, however you requested 210000", code: "context_length_exceeded" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return reply("done", 900);
  });

  try {
    const answer = await bridge.handleMessage(message("m1", "go"), sess, signal);
    await log.flush();
    assert.equal(answer, "done", "the run finished instead of surfacing the rejection");
    assert.deepEqual(calls, ["run", "summarizer", "run"], "one refusal, one summary, one retry");
    // The recovery is a compaction, so the beginning of the conversation was summarised rather
    // than dropped: the boundary is on the branch and the history is still whole.
    const context = contextEntries(log.entries(), log.leaf());
    assert.ok(context.some((e) => e.type === "compaction"), "a boundary was appended");
    assert.ok(log.entries().length > context.length, "and nothing was deleted to get there");
  } finally {
    mock.restore();
    end();
  }
});

test("a provider that answers past its own window without complaining is treated as the overflow it is", async () => {
  history(20);
  await log.flush();

  const sess = session();
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(sess.id);
  const calls: string[] = [];
  let runCalls = 0;

  const mock = mockFetch(async (_url, init) => {
    const body = String(init?.body ?? "{}");
    if (isSummarizer(body)) {
      calls.push("summarizer");
      return sseResponse(SUMMARY);
    }
    calls.push("run");
    runCalls += 1;
    // HTTP 200, a normal stop, and an input that does not fit the window it advertises.
    return runCalls === 1 ? reply("here you go", 250_000) : reply("done", 900);
  });

  try {
    const answer = await bridge.handleMessage(message("m2", "go"), sess, signal);
    assert.equal(answer, "done");
    assert.deepEqual(calls, ["run", "summarizer", "run"]);
  } finally {
    mock.restore();
    end();
  }
});

test("only one recovery per run, so a wrong window cannot loop", async () => {
  history(20);
  await log.flush();

  const sess = session();
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(sess.id);
  let summarizers = 0;
  let runs = 0;

  const mock = mockFetch(async (_url, init) => {
    const body = String(init?.body ?? "{}");
    if (isSummarizer(body)) {
      summarizers += 1;
      return sseResponse(SUMMARY);
    }
    runs += 1;
    // Always over the window: the belief is simply wrong.
    return reply("here you go", 250_000);
  });

  try {
    await bridge.handleMessage(message("m3", "go"), sess, signal);
    assert.equal(summarizers, 1, "the summarizer is not called once per iteration");
    assert.ok(runs <= 3, `the loop did not spin, got ${runs} calls`);
  } finally {
    mock.restore();
    end();
  }
});

/**
 * The point of speculating: the summary is computed at the end of a run that is already under the
 * threshold, and the crossing on the next turn costs an append instead of a minute.
 */
test("a run ending inside the band arms a summary, and the next crossing spends no summarizer call", async () => {
  history(20);
  await log.flush();

  const sess = session();
  const bridge = new AgentBridge(config(), new ToolRegistry(), new SkillRegistry());
  const calls: string[] = [];
  let armedSummary = 0;

  const mock = mockFetch(async (_url, init) => {
    const body = String(init?.body ?? "{}");
    if (isSummarizer(body)) {
      calls.push("summarizer");
      armedSummary += 1;
      return sseResponse(SUMMARY);
    }
    calls.push("run");
    // Just under the 160000 gate and inside the band, so the run ends by arming one.
    return reply("first answer", 159_500);
  });

  const first = runRegistry.startRoot(sess.id);
  try {
    await bridge.handleMessage(message("m4", "go"), sess, first.signal);
    // Deterministic instead of a sleep: the background pass hands out its own promise. Awaited
    // before the mock comes down, because the summarizer call it makes is still on the wire.
    await pendingSpeculation(sess.id);
  } finally {
    first.end();
    mock.restore();
  }
  assert.equal(armedSummary, 1, "the summary was computed in the background");
  assert.equal(contextEntries(log.entries(), log.leaf()).some((e) => e.type === "compaction"), false, "nothing was committed yet");

  const second = mockFetch(async (_url, init) => {
    const body = String(init?.body ?? "{}");
    if (isSummarizer(body)) {
      calls.push("summarizer");
      return reply("a second summary nobody should have needed", 100);
    }
    calls.push("run");
    return reply("second answer", 900);
  });
  const next = runRegistry.startRoot(sess.id);
  try {
    // The measurement stands at 159500, and this turn is what carries the gate past 160000.
    const answer = await bridge.handleMessage(message("m5", `${"more ".repeat(800)}`), sess, next.signal);
    await log.flush();
    assert.equal(answer, "second answer");
  } finally {
    next.end();
    second.restore();
  }

  assert.deepEqual(calls, ["run", "summarizer", "run"], "the crossing claimed the armed summary instead of computing one");
  const context = contextEntries(log.entries(), log.leaf());
  assert.ok(context.some((e) => e.type === "compaction"), "the armed summary was committed at the crossing");
  assert.ok(log.entries().length > context.length, "and the history it stands for is still there");
});
