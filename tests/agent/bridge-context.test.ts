import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { promptMessages } from "../../src/sessions/store.ts";
import { promptSideChat, sessionChatMessages } from "../../src/agent/context-pruning.ts";
import { estimateMessagesTokens } from "../../src/llm/tokens.ts";
import type { SessionData, SessionMessage } from "../../src/sessions/store.ts";

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
function session(id: string, messages: SessionMessage[] = []): SessionData {
  const now = new Date().toISOString();
  return { id, platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages };
}
function llm(message: object): never {
  return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
}

const BIG = "y".repeat(5000);

/**
 * Pruning is budgeted in tokens, and the default budget (40k) is deliberately wider than any
 * fixture here: ten of these turns are about 12k tokens, which is a conversation the default is
 * meant to leave alone. A test that wants to see a stub has to say how tight the budget is.
 */
function prunedConfig(protectTokens: number): MyClawConfig {
  const config = baseConfig();
  config.context = { pruning: { protectTokens } };
  return config;
}

// History with `turns` past tool exchanges (assistant tool_call + big tool result + assistant text).
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

async function runAndCaptureRequest(config: MyClawConfig, sess: SessionData): Promise<{ messages: Array<{ role: string; content: unknown }> }[]> {
  runRegistry.clear();
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(sess.id);
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const mock = mockFetch(async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return llm({ content: "final answer" });
  });
  try {
    await bridge.handleMessage(msg("m1", "continue"), sess, signal);
    return bodies;
  } finally {
    mock.restore(); end(); runRegistry.clear();
  }
}

test("bridge: old tool results are pruned from the prompt, session keeps full content", async () => {
  const sess = session("telegram/dm/u1", history(8));
  const bodies = await runAndCaptureRequest(prunedConfig(3_000), sess);
  const sent = bodies[0]!.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
  assert.equal(sent.length, 8);
  assert.ok(sent[0]!.content.includes("elided"), "oldest tool result stubbed in the prompt");
  assert.ok(sent[7]!.content === BIG, "recent tool result intact in the prompt");
  const persisted = sess.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
  assert.ok(persisted.every((m) => m.content === BIG), "session on disk never mutated");
});

test("bridge: context.pruning.enabled=false sends full history", async () => {
  const config = baseConfig();
  config.context = { pruning: { enabled: false } };
  const bodies = await runAndCaptureRequest(config, session("telegram/dm/u1", history(8)));
  const sent = bodies[0]!.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
  assert.ok(sent.every((m) => m.content === BIG), "nothing stubbed when disabled");
});

test("bridge: auto-compaction triggers above the threshold and shrinks the prompt, not the history", async () => {
  const config = baseConfig();
  config.llm.limit = { context: 2000 };
  const sess = session("telegram/dm/u1", history(10));

  runRegistry.clear();
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(sess.id);
  const before = sess.messages.length;
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
    await bridge.handleMessage(msg("m1", "continue"), sess, signal);
  } finally {
    mock.restore(); end(); runRegistry.clear();
  }
  assert.ok(sawCompactionCall, "compaction LLM call happened");
  // The prompt window is what a compaction shrinks. `messages` only grows: the turns the summary
  // stands for stay in the thread, which is the whole point of the boundary.
  const prompt = promptMessages(sess);
  assert.ok(prompt.length < before, `prompt shrank (${before} -> ${prompt.length})`);
  assert.ok(sess.messages.length > before, `history kept every turn (${before} -> ${sess.messages.length})`);
  assert.ok(prompt.some((m) => m.role === "user" && m.content.includes("[Prior context summarized]")), "summary message present");
  assert.ok(prompt.some((m) => m.role === "user" && m.summaryOf !== undefined), "summary marked as a boundary");
});

/**
 * The thirty-compaction bug, as a gate reading. The loop prunes old tool results out of the prompt
 * before every call, but the gate estimated the untouched history: 410k against 47k actually
 * billed, an 8.7x over-read that fired thirty summarizations on a session using nine percent of its
 * window -- and each one deleted history, back when compaction cut instead of marking a boundary.
 *
 * The window here is picked so the two readings straddle the threshold: the raw history is over it
 * and the pruned prompt is well under. A compaction firing means the gate is measuring the wrong
 * array again.
 *
 * It has to leave room for the fixed cost of a run, now that the gate counts it: the system prompt
 * alone measures ~5.2k here, so on the 10k window this used to use it was two thirds of the budget
 * before a single message of history and both readings sat above the threshold. That would have
 * made this test pass or fail on the size of the system prompt rather than on which array the gate
 * measures, which is the only thing it is here to check.
 */
test("bridge: the gate measures the pruned prompt, not the history behind it", async () => {
  const config = prunedConfig(2_000);
  config.llm.limit = { context: 16_000 };
  const sess = session("my-claw-app/thread/u1/t1", history(10));

  runRegistry.clear();
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(sess.id);
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
    await bridge.handleMessage(msg("m1", "continue"), sess, signal);
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
  const sess = session("telegram/dm/u1", history(10));
  const before = sess.messages.length;
  const bodies = await runAndCaptureRequest(config, sess);
  assert.equal(bodies.length, 1, "single LLM call, no compaction");
  // +2: the new user message and the final assistant reply of this run
  assert.equal(sess.messages.length, before + 2);
});

test("bridge: context.autoCompact.enabled=false never compacts", async () => {
  const config = baseConfig();
  config.llm.limit = { context: 2000 };
  config.context = { autoCompact: { enabled: false } };
  const sess = session("telegram/dm/u1", history(10));
  const bodies = await runAndCaptureRequest(config, sess);
  assert.equal(bodies.length, 1, "no compaction call");
  assert.ok(!sess.messages.some((m) => m.role === "user" && m.content.includes("[Prior context summarized]")));
});
