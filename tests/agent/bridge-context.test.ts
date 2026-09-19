import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { sseResponse } from "../helpers/sse.ts";
import { setupSessionLog, appendMessages, writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { contextEntries } from "../../src/sessions/projection.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData, type SessionMessage } from "../../src/sessions/store.ts";
import type { SessionLog, CompactionEntry } from "../../src/sessions/log.ts";

const SESSION_ID = "test-context";

function baseConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
    agents: {}, memory: { enabled: false },
    // The verbatim tail is a token budget: left at its 20k default these fixtures would fit in it
    // whole, and a compaction with nothing to summarise is correctly refused.
    context: { autoCompact: { tailTokens: 40 } },
  };
}

function msg(id: string, text: string): UnifiedMessage {
  return { id, platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}

function sessionMeta(id: string = SESSION_ID): LegacySessionData {
  const now = new Date().toISOString();
  return { id, platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}

function llm(message: object): never {
  return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
}

const BIG = "y".repeat(5000);

// History with `turns` past tool exchanges (user + assistant tool_call + tool result + assistant text).
function history(turns: number): SessionMessage[] {
  const now = new Date().toISOString();
  const out: SessionMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "user", content: `step ${i}`, timestamp: now });
    out.push({ role: "assistant", content: "", timestamp: now, toolCalls: [{ id: `h${i}`, name: "bash", arguments: "{}" }] });
    out.push({ role: "tool", toolCallId: `h${i}`, content: BIG, timestamp: now });
    out.push({ role: "assistant", content: `done ${i}`, timestamp: now });
  }
  return out;
}

let log: SessionLog;
let cleanupLog: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, sessionMeta());
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
  runRegistry.clear();
});

async function runAndCaptureRequest(config: MyClawConfig, priorMessages: SessionMessage[]): Promise<{ messages: Array<{ role: string; content: unknown }> }[]> {
  // Append prior messages to log
  if (priorMessages.length > 0) {
    appendMessages(log, priorMessages);
    await log.flush();
  }

  runRegistry.clear();
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const mock = mockFetch(async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return llm({ content: "final answer" });
  });
  try {
    await bridge.handleMessage(msg("m1", "continue"), sessionMeta(), signal);
    return bodies;
  } finally {
    mock.restore(); end(); runRegistry.clear();
  }
}

test("bridge: auto-compaction triggers above the threshold and shrinks the prompt, not the history", async () => {
  const config = baseConfig();
  config.llm.limit = { context: 2000 };
  const priorMessages = history(10);
  
  // Append prior history to log
  appendMessages(log, priorMessages);
  await log.flush();
  const entriesBefore = log.entries().length;

  runRegistry.clear();
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  let sawCompactionCall = false;
  const mock = mockFetch(async (_u, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
    if (typeof body.messages[0]?.content === "string" && body.messages[0].content.includes("You summarize a conversation")) {
      sawCompactionCall = true;
      return sseResponse("Summary of the prior work: steps 0-9 executed bash and completed successfully.");
    }
    return llm({ content: "final answer" });
  });
  try {
    await bridge.handleMessage(msg("m1", "continue"), sessionMeta(), signal);
  } finally {
    mock.restore(); end(); runRegistry.clear();
  }
  assert.ok(sawCompactionCall, "compaction LLM call happened");
  
  // Check log - should have a compaction entry
  await log.flush();
  const entriesAfter = log.entries();
  assert.ok(entriesAfter.length > entriesBefore, "new entries were added");
  
  // The context should be smaller due to compaction
  const context = contextEntries(entriesAfter, log.leaf());
  const compactionEntry = context.find((e): e is CompactionEntry => e.type === "compaction");
  assert.ok(compactionEntry, "compaction entry present");
  assert.ok(context.length < entriesBefore, `context shrank (${entriesBefore} entries -> ${context.length} in context)`);
});

test("bridge: no auto-compaction below the threshold", async () => {
  const config = baseConfig();
  config.llm.limit = { context: 500_000 };
  const priorMessages = history(10);
  
  appendMessages(log, priorMessages);
  await log.flush();
  const entriesBefore = log.entries().length;
  
  const bodies = await runAndCaptureRequest(config, []);  // Messages already in log
  assert.equal(bodies.length, 1, "single LLM call, no compaction");
  
  await log.flush();
  const entriesAfter = log.entries().length;
  // +4: the new user entry, its run markers (one each side of the work) and the final phase
  assert.equal(entriesAfter, entriesBefore + 4);
});

test("bridge: context.autoCompact.enabled=false never compacts", async () => {
  const config = baseConfig();
  config.llm.limit = { context: 2000 };
  config.context = { autoCompact: { enabled: false } };
  const priorMessages = history(10);

  appendMessages(log, priorMessages);
  await log.flush();

  const bodies = await runAndCaptureRequest(config, []);
  assert.equal(bodies.length, 1, "no compaction call");
  
  await log.flush();
  const entries = log.entries();
  const compactionEntry = entries.find((e) => e.type === "compaction");
  assert.equal(compactionEntry, undefined, "no compaction entry when disabled");
});

/**
 * What the tail ignores, the gate obeys -- docs/compaction.md.
 *
 * A session's ceilings (its Context choice, a tag route's contextCap) are the gate's brakes: they
 * decide when a run compacts. They must keep braking now that the split no longer reads them, so
 * this block pins the gate's side -- `tests/compaction.test.ts` pins the split's.
 *
 * `history(10)` weighs about 14.6k tokens estimated: over the ~3.6k threshold a 20k window opens
 * at, under the 80k the declared 100k window opens at.
 */
async function runAndCountCompactions(
  config: MyClawConfig,
  session: LegacySessionData,
): Promise<{ compactionCalls: number; llmCalls: number }> {
  runRegistry.clear();
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(session.id);
  let compactionCalls = 0;
  let llmCalls = 0;
  const mock = mockFetch(async (_u, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
    if (typeof body.messages[0]?.content === "string" && body.messages[0].content.includes("You summarize a conversation")) {
      compactionCalls += 1;
      return sseResponse("Summary of the prior work: steps 0-9 executed bash and completed successfully.");
    }
    llmCalls += 1;
    return llm({ content: "final answer" });
  });
  try {
    await bridge.handleMessage(msg("m1", "continue"), session, signal);
  } finally {
    mock.restore(); end(); runRegistry.clear();
  }
  return { compactionCalls, llmCalls };
}

test("bridge: the gate compacts on the session's context override", async () => {
  const config = baseConfig();
  config.llm.limit = { context: 100_000 };
  appendMessages(log, history(10));
  await log.flush();

  const session = sessionMeta();
  session.contextOverride = 20_000;
  const { compactionCalls, llmCalls } = await runAndCountCompactions(config, session);
  assert.equal(compactionCalls, 1);
  assert.equal(llmCalls, 1);
});

test("bridge: the same history stays under the declared window's threshold", async () => {
  const config = baseConfig();
  config.llm.limit = { context: 100_000 };
  appendMessages(log, history(10));
  await log.flush();

  const { compactionCalls, llmCalls } = await runAndCountCompactions(config, sessionMeta());
  assert.equal(compactionCalls, 0, "the fixture must stay under the declared window's own threshold");
  assert.equal(llmCalls, 1);
});

test("bridge: the gate compacts on a tag's contextCap", async () => {
  const config = baseConfig();
  config.llm.limit = { context: 100_000 };
  config.tags = { cheap: { route: [{ model: "test-model", contextCap: 20_000 }] } };
  appendMessages(log, history(10));
  await log.flush();

  const session = sessionMeta();
  session.modelOverride = "tag:cheap";
  const { compactionCalls } = await runAndCountCompactions(config, session);
  assert.equal(compactionCalls, 1);
});
