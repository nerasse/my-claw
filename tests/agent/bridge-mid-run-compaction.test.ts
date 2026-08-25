import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { saveSession, deleteSession, type SessionData } from "../../src/sessions/store.ts";
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
const UNCOMPACTED_ENTRIES = 26;

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
    context: { cap: 20_000, pruning: { enabled: false } },
  } as unknown as MyClawConfig;
}

function message(): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "go", attachments: [], isForwarded: false, raw: {} };
}

function session(id: string = SESSION_ID): SessionData {
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
  await saveSession(SESSION_ID, session());
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
async function run(opts: { summary: string | null }): Promise<{ sent: Sent[]; sess: SessionData; log: SessionLog }> {
  runRegistry.clear();
  const sess = session();
  const bridge = new AgentBridge(config(), registry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(sess.id);
  const sent: Sent[] = [];
  let rounds = 0;
  const mock = mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Sent["messages"] extends never ? never : { messages: Sent["messages"] };
    const system = String(body.messages[0]?.content ?? "");
    if (system.includes("context compaction agent")) {
      sent.push({ kind: "compaction", messages: body.messages });
      return llmResponse({ content: opts.summary ?? "" }, 100);
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

// The mark exists because nothing travels for a minute or two while the summarizer runs, in the
// middle of an answer the owner is already watching.
test("the bubble is marked while a mid-run compaction runs", async () => {
  const queued: string[] = [];
  const onQueued = ({ reason }: { reason: string }): void => {
    queued.push(reason);
  };
  hooks.on("message:queued", onQueued);
  try {
    await run({ summary: SUMMARY });
    assert.ok(queued.length >= 1);
    assert.ok(queued.every((reason) => reason === "compaction"));
  } finally {
    hooks.off("message:queued", onQueued);
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
  // Nothing was rewritten, so the run kept its history and the hard trim stayed in charge.
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
  const sess: SessionData = {
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
  await saveSession(subId, sess);
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
    if (String(body.messages[0]?.content ?? "").includes("context compaction agent")) {
      compactions += 1;
      return llmResponse({ content: SUMMARY }, promptTokens);
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
  const sess: SessionData = {
    id: cronId,
    platform: "cron",
    chatType: "dm",
    createdAt: now,
    lastActiveAt: now,
    messages: [],
  };
  await saveSession(cronId, sess);
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
    if (String(body.messages[0]?.content ?? "").includes("context compaction agent")) {
      compactions += 1;
      return llmResponse({ content: SUMMARY }, promptTokens);
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
