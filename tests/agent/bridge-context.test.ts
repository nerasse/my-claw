import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData, SessionMessage } from "../../src/sessions/store.ts";

function baseConfig(): MyClawConfig {
  return {
    whitelist: ["u1"], blacklist: [], channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
    agents: {}, memory: { enabled: false },
  };
}
function msg(id: string, text: string): UnifiedMessage {
  return { id, platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}
function session(id: string, messages: SessionMessage[] = []): SessionData {
  const now = new Date().toISOString();
  return { id, platform: "telegram", chatType: "dm", createdAt: now, lastActiveAt: now, messages };
}
function llm(message: object): never {
  return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
}

const BIG = "y".repeat(5000);

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
  const bodies = await runAndCaptureRequest(baseConfig(), sess);
  const sent = bodies[0]!.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
  assert.equal(sent.length, 8);
  assert.ok(sent[0]!.content.includes("pruned"), "oldest tool result stubbed in the prompt");
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

test("bridge: auto-compaction triggers above the threshold and shrinks the session", async () => {
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
  assert.ok(sess.messages.length < before, `session shrank (${before} -> ${sess.messages.length})`);
  assert.ok(sess.messages.some((m) => m.role === "user" && m.content.includes("[Prior context summarized]")), "summary message present");
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
