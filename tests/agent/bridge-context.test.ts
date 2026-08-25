import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, appendMessages } from "../helpers/session-log.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { contextEntries } from "../../src/sessions/projection.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { promptSideChat, sessionChatMessages } from "../../src/agent/context-pruning.ts";
import { estimateMessagesTokens } from "../../src/llm/tokens.ts";
import { saveSession, deleteSession, type SessionData, type SessionMessage } from "../../src/sessions/store.ts";
import type { SessionLog, CompactionEntry } from "../../src/sessions/log.ts";

const SESSION_ID = "test-context";

function baseConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
    agents: {}, memory: { enabled: false },
  };
}

function msg(id: string, text: string): UnifiedMessage {
  return { id, platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}

function sessionMeta(id: string = SESSION_ID): SessionData {
  const now = new Date().toISOString();
  return { id, platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}

function llm(message: object): never {
  return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
}

const BIG = "y".repeat(5000);

function prunedConfig(protectTokens: number): MyClawConfig {
  const config = baseConfig();
  config.context = { pruning: { protectTokens } };
  return config;
}

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
  await saveSession(SESSION_ID, sessionMeta());
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

test("bridge: old tool results are pruned from the prompt, session keeps full content", async () => {
  const priorMessages = history(8);
  const bodies = await runAndCaptureRequest(prunedConfig(3_000), priorMessages);
  const sent = bodies[0]!.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
  assert.equal(sent.length, 8);
  assert.ok(sent[0]!.content.includes("elided"), "oldest tool result stubbed in the prompt");
  assert.ok(sent[7]!.content === BIG, "recent tool result intact in the prompt");
  // Check log entries - tool outputs are stored unmodified
  await log.flush();
  const entries = log.entries();
  const toolEntries = entries.filter((e) => e.type === "tool");
  assert.ok(toolEntries.every((e) => e.type === "tool" && e.output === BIG), "log stores full tool output");
});

test("bridge: context.pruning.enabled=false sends full history", async () => {
  const config = baseConfig();
  config.context = { pruning: { enabled: false } };
  const bodies = await runAndCaptureRequest(config, history(8));
  const sent = bodies[0]!.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
  assert.ok(sent.every((m) => m.content === BIG), "nothing stubbed when disabled");
});

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
    if (typeof body.messages[0]?.content === "string" && body.messages[0].content.includes("compaction agent")) {
      sawCompactionCall = true;
      return llm({ content: "Summary of the prior work: steps 0-9 executed bash and completed successfully." });
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

test("bridge: the gate measures the pruned prompt, not the history behind it", async () => {
  const config = prunedConfig(2_000);
  config.llm.limit = { context: 16_000 };
  const priorMessages = history(10);

  appendMessages(log, priorMessages);
  await log.flush();

  runRegistry.clear();
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(SESSION_ID);
  let compactionCalls = 0;
  const mock = mockFetch(async (_u, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
    if (typeof body.messages[0]?.content === "string" && body.messages[0].content.includes("compaction agent")) {
      compactionCalls += 1;
      return llm({ content: "Summary that should never have been asked for on this conversation." });
    }
    return llm({ content: "final answer" });
  });
  try {
    await bridge.handleMessage(msg("m1", "continue"), sessionMeta(), signal);
  } finally {
    mock.restore(); end(); runRegistry.clear();
  }
  assert.equal(compactionCalls, 0, "the pruned prompt is under the threshold, nothing to summarize");
});

/** Anthropic never prunes -- its cache is a prefix -- so measuring it as pruned would under-read. */
test("bridge: the anthropic backend is measured whole, since its prompt is sent whole", () => {
  const config = prunedConfig(2_000);
  const raw = estimateMessagesTokens(sessionChatMessages(history(10)));
  const pruned = estimateMessagesTokens(promptSideChat(history(10), config));
  const anthropic = estimateMessagesTokens(promptSideChat(history(10), config, "anthropic"));
  assert.ok(pruned < raw / 2, `pruning is what the prompt does: ${raw} -> ${pruned}`);
  assert.equal(anthropic, raw, "nothing is pruned for a backend that sends the whole prompt");
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
  // +2: the new user entry and the final assistant phase entry
  assert.equal(entriesAfter, entriesBefore + 2);
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
