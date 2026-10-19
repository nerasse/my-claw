import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { sseResponse } from "../helpers/sse.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import { contextEntries } from "../../src/sessions/projection.ts";
import type { Entry, CompactionEntry } from "../../src/sessions/log.ts";
import type { SessionLog } from "../../src/sessions/log.ts";

/**
 * The gate inside a run, on the engine that owns its own prompt. Without it the only thing standing
 * between a long agentic run and the ceiling is `trimToContextWindow`, which keeps the prompt legal
 * by dropping the oldest turns for good instead of summarizing them. See docs/compaction.md.
 */

const FILLER = "z".repeat(6_000);
const SUMMARY = `Prior work: the agent ran the filler tool several times and gathered its output. ${"detail ".repeat(20)}`;
/** Entries a run of this shape keeps when no summary ever lands: the hard trim alone. */
const UNCOMPACTED_ENTRIES = 28;

function config(): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: {
      provider: "x",
      baseUrl: "https://example.com",
      defaultModel: "test-model",
      models: [{ id: "test-model", label: "Test" }],
    },
    agents: {},
    memory: { enabled: false },
    // The cap is what makes the window small here, rather than a declared limit: it applies to
    // every model, so the test does not depend on how a limit reaches the resolved config.
    // Pruning is off because it replaces old tool results in the prompt, which would hide the very
    // growth this gate exists to catch.
    context: { cap: 20_000, pruning: { enabled: false }, autoCompact: { tailTokens: 40 } },
  } as unknown as MyClawConfig;
}

function message(): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "go", attachments: [], isForwarded: false, raw: {} };
}

function session(id: string = SESSION_ID): LegacySessionData {
  const now = new Date().toISOString();
  return { id, platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "filler",
    description: "returns a lot of text",
    parameters: {},
    async execute() {
      return { success: true, output: FILLER };
    },
  });
  return tools;
}

function llmResponse(body: object, promptTokens: number): never {
  return new Response(
    JSON.stringify({ choices: [{ message: body }], usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ) as never;
}

interface Sent {
  kind: "run" | "compaction";
  messages: Array<{ role: string; content: unknown }>;
}

const SESSION_ID = "test-mid-run-compaction";
let log: SessionLog;
let cleanupLog: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, session());
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
  runRegistry.clear();
});

/**
 * Twelve tool rounds, each adding 6k characters to the history, on a 20k window: the measurement
 * crosses the threshold around the tenth, by which point the history has the turns compaction needs
 * (it keeps a head and a tail, so bulk alone is not enough). The summarizer is told apart by its
 * own system prompt.
 */
async function run(opts: { summary: string | null }): Promise<{ sent: Sent[]; sess: LegacySessionData; log: SessionLog }> {
  runRegistry.clear();
  const sess = session();
  const bridge = new AgentBridge(config(), registry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(sess.id);
  const sent: Sent[] = [];
  let rounds = 0;
  const mock = mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Sent["messages"] extends never ? never : { messages: Sent["messages"] };
    const last = String(body.messages[body.messages.length - 1]?.content ?? "");
    if (last.includes("You summarize a conversation")) {
      sent.push({ kind: "compaction", messages: body.messages });
      return sseResponse(opts.summary ?? "");
    }
    sent.push({ kind: "run", messages: body.messages });
    rounds += 1;
    // The billed prompt is the prompt that arrived, so a compaction is visible in the next
    // measurement exactly as a provider would report it.
    const promptTokens = Math.round(JSON.stringify(body.messages).length / 4);
    if (rounds <= 12) {
      return llmResponse({ content: "", tool_calls: [{ id: `c${rounds}`, type: "function", function: { name: "filler", arguments: "{}" } }] }, promptTokens);
    }
    return llmResponse({ content: "done" }, promptTokens);
  });
  try {
    await bridge.handleMessage(message(), sess, signal);
    await log.flush();
    return { sent, sess, log };
  } finally {
    mock.restore();
    end();
    runRegistry.clear();
  }
}

test("a run that fills the window mid-flight is compacted, not trimmed", async () => {
  const { sent, log: sessionLog } = await run({ summary: SUMMARY });

  const rounds = sent.filter((s) => s.kind === "run").length;
  const compactions = sent.filter((s) => s.kind === "compaction").length;
  assert.ok(compactions >= 1, "the run was compacted while it was running");
  assert.ok(compactions < rounds / 3, `summarization is rare, got ${compactions} for ${rounds} rounds`);

  // The prompt is rebuilt from the rewritten history: the request that follows the compaction
  // carries the summary and is a fraction of the one that preceded it.
  const at = sent.findIndex((s) => s.kind === "compaction");
  const before = JSON.stringify(sent[at - 1]!.messages);
  const after = JSON.stringify(sent[at + 1]!.messages);
  assert.ok(after.includes("Prior work:"), "the summary reached the prompt");
  assert.ok(after.length < before.length, `prompt shrank: ${before.length} -> ${after.length}`);
  // The system prompt is the floor, so the meaningful drop is in the tool results themselves.
  const fillersBefore = before.split(FILLER).length - 1;
  const fillersAfter = after.split(FILLER).length - 1;
  assert.ok(fillersAfter <= fillersBefore - 2, `tool results summarized away: ${fillersBefore} -> ${fillersAfter}`);

  // The context window moved, so the next run starts from the summary too.
  const entries = sessionLog.entries();
  const context = contextEntries(entries, sessionLog.leaf());
  assert.ok(context.length < UNCOMPACTED_ENTRIES, `context compacted, got ${context.length} entries`);
  assert.ok(entries.length >= UNCOMPACTED_ENTRIES, `history kept, got ${entries.length} entries`);
  const hasCompaction = context.some((e): e is CompactionEntry => e.type === "compaction");
  assert.ok(hasCompaction, "compaction entry present in context");
});

// A mid-run compaction must not mark the send. The mark says "this message is waiting for its run",
// and here the run is already going: nothing would ever lift it, and a run that only called tools
// left the bubble wearing it for hours. The operation is visible through `chat.compacting`, which
// outlives a reload. Observed on the owner's thread, 2026-09-11.
test("a mid-run compaction does not mark the send as queued", async () => {
  const queued: string[] = [];
  const onQueued = ({ reason }: { reason: string }): void => {
    queued.push(reason);
  };
  hooks.on("message:queued", onQueued);
  try {
    await run({ summary: SUMMARY });
    assert.equal(queued.length, 0);
  } finally {
    hooks.off("message:queued", onQueued);
  }
});

// It still has to be visible: the hook is gone, the compaction is not silent.
test("a mid-run compaction still announces itself while it runs", async () => {
  const starts: string[] = [];
  const settled: string[] = [];
  const onStart = ({ sessionId }: { sessionId: string }): void => {
    starts.push(sessionId);
  };
  const onSettled = ({ sessionId }: { sessionId: string }): void => {
    settled.push(sessionId);
  };
  hooks.on("session:compact:start", onStart);
  hooks.on("session:compact:settled", onSettled);
  try {
    await run({ summary: SUMMARY });
    assert.ok(starts.length >= 1, "the compaction announced its start");
    assert.equal(starts.length, settled.length, "every start is paired with a settled");
  } finally {
    hooks.off("session:compact:start", onStart);
    hooks.off("session:compact:settled", onSettled);
  }
});

/**
 * The boundary reaches the screen while the run is still going.
 *
 * `/compact` has always answered with a bubble of its own; an automatic pass announced nothing, so
 * the rule only appeared at the next history load and a thread compacted mid-run looked like it
 * had lost its middle for no stated reason. The id is the entry's, which is what makes the live
 * boundary and the replayed one the same object rather than two rules for one cut.
 */
test("an automatic compaction announces its boundary, keyed by the entry it wrote", async () => {
  const seen: Array<{ entryId: string; count: number; summary: string }> = [];
  const onBoundary = (e: { entryId: string; count: number; summary: string }): void => {
    seen.push({ entryId: e.entryId, count: e.count, summary: e.summary });
  };
  hooks.on("session:compact:boundary", onBoundary);
  try {
    const { log: sessionLog } = await run({ summary: SUMMARY });
    assert.ok(seen.length >= 1, "the boundary was announced");

    const written = sessionLog.entries().filter((e): e is CompactionEntry => e.type === "compaction");
    assert.equal(seen.length, written.length, "one announcement per boundary, no more");
    for (const [i, announced] of seen.entries()) {
      const entry = written[i]!;
      assert.equal(announced.entryId, entry.id, "the announcement names the entry the history replays");
      assert.equal(announced.count, entry.count, "the turns it stands for");
      assert.equal(announced.summary, entry.summary, "the same summary, not a second one");
    }
  } finally {
    hooks.off("session:compact:boundary", onBoundary);
  }
});

// A compaction is not an event the owner has to be told about, and an automatic one least of all:
// nothing publishes to the tray on any compaction path now. `session:compact:finished` stays the
// command's own end -- `/compact` is its only emitter -- and it moves the context gauge, nothing
// else. What the owner does see is the placeholder while it runs (`chat.compacting`).
test("an automatic compaction stays silent: no notification, no ring", async () => {
  const notified: string[] = [];
  const onFinished = ({ sessionId }: { sessionId: string }): void => {
    notified.push(sessionId);
  };
  hooks.on("session:compact:finished", onFinished);
  try {
    const { log: sessionLog } = await run({ summary: SUMMARY });
    const compacted = sessionLog.entries().some((e) => e.type === "compaction");
    assert.ok(compacted, "a compaction did happen");
    assert.deepEqual(notified, [], "nothing was published to the tray");
  } finally {
    hooks.off("session:compact:finished", onFinished);
  }
});

// A refused or empty summary must not be retried on every single iteration: the run would pay for
// one summarization per tool round and never get anywhere.
test("a summarization that produced nothing is not retried on the next iteration", async () => {
  const { sent, log: sessionLog } = await run({ summary: null });

  const rounds = sent.filter((s) => s.kind === "run").length;
  const attempts = sent.filter((s) => s.kind === "compaction").length;
  const entries = sessionLog.entries();
  // Every iteration is over the threshold from now on, and each one could have paid for a summary.
  assert.ok(attempts >= 1);
  assert.ok(attempts <= Math.ceil((entries.length + 1) / 10), `backed off, got ${attempts} attempts over ${rounds} rounds`);
  // Nothing was rewritten, so the run kept its history and the hard trim stayed in charge. The two
  // run markers ride along as bookkeeping (docs/run-grouping.md), which is why the constant is 28.
  assert.equal(entries.length, UNCOMPACTED_ENTRIES, `history untouched, got ${entries.length} entries`);
});

/**
 * Every agent, not the orchestrator alone. A research sub-agent reading documents is the profile
 * that fills a window fastest, and it had nothing but the hard trim: its beginning was dropped
 * rather than summarized.
 */
test("a sub-agent run is compacted mid-flight", async () => {
  const subId = "subagent/general-a1";
  await deleteSession(subId);
  const now = new Date().toISOString();
  const sess: LegacySessionData = {
    id: subId,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: now,
    lastActiveAt: now,
    messages: [],
    // A general sub-agent, because the point is the depth: a research one is scoped to a read-only
    // toolset, which the filler tool is not part of.
    meta: { displayName: "worker", type: "general", parentSessionId: "telegram/dm/u1", visibility: "private", createdAt: now },
  };
  await writeLegacySessionFile(subId, sess);
  const subSetup = await setupSessionLog(subId);
  const subLog = subSetup.log;

  runRegistry.clear();
  const bridge = new AgentBridge(config(), registry(), new SkillRegistry(), undefined, undefined, 1, undefined, "general");
  const { signal, end } = runRegistry.startRoot(sess.id);
  let compactions = 0;
  let rounds = 0;
  const mock = mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: unknown }> };
    const promptTokens = Math.round(JSON.stringify(body.messages).length / 4);
    if (String(body.messages[body.messages.length - 1]?.content ?? "").includes("You summarize a conversation")) {
      compactions += 1;
      return sseResponse(SUMMARY);
    }
    rounds += 1;
    if (rounds <= 12) {
      return llmResponse({ content: "", tool_calls: [{ id: `c${rounds}`, type: "function", function: { name: "filler", arguments: "{}" } }] }, promptTokens);
    }
    return llmResponse({ content: "done" }, promptTokens);
  });
  try {
    await bridge.handleMessage(message(), sess, signal);
    await subLog.flush();
  } finally {
    mock.restore();
    end();
    runRegistry.clear();
    subSetup.cleanup();
  }

  assert.ok(compactions >= 1, "the sub-agent was compacted");
  const context = contextEntries(subLog.entries(), subLog.leaf());
  const hasCompaction = context.some((e): e is CompactionEntry => e.type === "compaction");
  assert.ok(hasCompaction, "compaction entry present in sub-agent context");
});

// A cron run is a fresh session every time, so the run-start gate has nothing to do there: what
// fills the window is the run itself, and that is exactly what the mid-run gate covers.
test("a cron run is compacted mid-flight too", async () => {
  const cronId = "cron/job-1/1700000000000";
  await deleteSession(cronId);
  const now = new Date().toISOString();
  const sess: LegacySessionData = {
    id: cronId,
    platform: "cron",
    chatType: "dm",
    createdAt: now,
    lastActiveAt: now,
    messages: [],
  };
  await writeLegacySessionFile(cronId, sess);
  const cronSetup = await setupSessionLog(cronId);
  const cronLog = cronSetup.log;

  runRegistry.clear();
  const bridge = new AgentBridge(config(), registry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(sess.id);
  let compactions = 0;
  let rounds = 0;
  const mock = mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: unknown }> };
    const promptTokens = Math.round(JSON.stringify(body.messages).length / 4);
    if (String(body.messages[body.messages.length - 1]?.content ?? "").includes("You summarize a conversation")) {
      compactions += 1;
      return sseResponse(SUMMARY);
    }
    rounds += 1;
    if (rounds <= 12) {
      return llmResponse({ content: "", tool_calls: [{ id: `k${rounds}`, type: "function", function: { name: "filler", arguments: "{}" } }] }, promptTokens);
    }
    return llmResponse({ content: "done" }, promptTokens);
  });
  try {
    await bridge.handleMessage({ ...message(), platform: "cron" }, sess, signal);
    await cronLog.flush();
  } finally {
    mock.restore();
    end();
    runRegistry.clear();
    cronSetup.cleanup();
  }

  assert.ok(compactions >= 1, "the cron run was compacted");
});
