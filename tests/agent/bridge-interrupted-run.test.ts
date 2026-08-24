import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { sessionChatMessages } from "../../src/agent/context-pruning.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
  memory: { enabled: false },
};

function createMessage(): UnifiedMessage {
  return { id: "m2", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "encore", attachments: [], isForwarded: false, raw: {} };
}

/**
 * The assistant turn is persisted before its tools run, and the autosave ticks every two seconds:
 * a process killed during a long tool leaves a request nothing will ever answer. Every later prompt
 * on that conversation is then refused by the provider, permanently.
 */
function interruptedSession(): SessionData {
  const ts = new Date().toISOString();
  return {
    id: "my-claw-app/dm/u1",
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: ts,
    lastActiveAt: ts,
    messages: [
      { role: "user", content: "lance le build", timestamp: ts },
      { role: "assistant", content: "", timestamp: ts, toolCalls: [{ id: "dead-1", name: "bash", arguments: "{}" }] },
    ],
  };
}

test("bridge: a run left unanswered by a killed process does not wedge the conversation", async () => {
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());

  let sent: { role: string; tool_calls?: unknown[]; tool_call_id?: string }[] = [];
  const fetchMock = mockFetch(async (_input, init) => {
    sent = JSON.parse(String((init as { body?: string }).body)).messages;
    return new Response(JSON.stringify({ choices: [{ message: { content: "reparti" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never;
  });

  try {
    const session = interruptedSession();
    await bridge.handleMessage(createMessage(), session);

    const sealed = session.messages.find((m) => m.role === "tool" && m.toolCallId === "dead-1") as { content: string } | undefined;
    assert.ok(sealed, "the abandoned call is answered");
    assert.match(sealed.content, /interrupted/i);

    // The result sits under the turn that asked for it, before the new question.
    assert.deepEqual(session.messages.map((m) => m.role), ["user", "assistant", "tool", "user", "assistant"]);

    // What the provider was actually handed: every tool_call has its answer.
    const requested = sent.flatMap((m) => (m.role === "assistant" && m.tool_calls ? (m.tool_calls as { id: string }[]).map((c) => c.id) : []));
    const answered = sent.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    assert.deepEqual(requested, ["dead-1"]);
    assert.deepEqual(answered, ["dead-1"]);
  } finally {
    fetchMock.restore();
  }
});

test("an unanswered call is what a provider refuses, which is why the seal exists", () => {
  const ts = new Date().toISOString();
  const chat = sessionChatMessages([
    { role: "user", content: "lance le build", timestamp: ts },
    { role: "assistant", content: "", timestamp: ts, toolCalls: [{ id: "dead-1", name: "bash", arguments: "{}" }] },
    { role: "user", content: "encore", timestamp: ts },
  ]);
  // Pinned as the shape to avoid: an assistant carrying tool_calls, then a user turn, and no tool
  // message between them. OpenAI-compatible endpoints reject the request outright.
  assert.deepEqual(chat.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(chat.filter((m) => m.role === "tool").length, 0);
});
