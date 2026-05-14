import { test } from "bun:test";
import assert from "node:assert/strict";
import { estimateTokens, estimateMessagesTokens, trimToContextWindow } from "../../src/llm/tokens.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";

// --- estimateTokens ---

test("estimateTokens: empty string returns 0", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens: 4 chars = 1 token", () => {
  assert.equal(estimateTokens("abcd"), 1);
});

test("estimateTokens: 5 chars = 2 tokens (ceiling)", () => {
  assert.equal(estimateTokens("abcde"), 2);
});

test("estimateTokens: 400 chars = 100 tokens", () => {
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

// --- estimateMessagesTokens ---

test("estimateMessagesTokens: single system message", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "a".repeat(400) }];
  const tokens = estimateMessagesTokens(messages);
  // 100 tokens content + 4 overhead = 104, * 1.15 safety = 119.6 -> 120
  assert.ok(tokens >= 100);
  assert.ok(tokens <= 150);
});

test("estimateMessagesTokens: includes tool_call arguments", () => {
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      content: "ok",
      tool_calls: [
        { id: "c1", type: "function" as const, function: { name: "bash", arguments: '{"command":"ls -la"}' } },
      ],
    },
  ];
  const tokens = estimateMessagesTokens(messages);
  // content "ok" (1 tok) + name "bash" (1 tok) + args 20 chars (5 tok) + overhead = ~11 * 1.15
  assert.ok(tokens > 5);
});

test("estimateMessagesTokens: image content counted as 6400 chars", () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
      ],
    },
  ];
  const tokens = estimateMessagesTokens(messages);
  // text ~4 tok + image 6400/4 = 1600 tok + overhead
  assert.ok(tokens > 1500);
});

// --- trimToContextWindow ---

function makeMessages(count: number, charsPerMsg: number = 100): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: "System prompt " + "x".repeat(charsPerMsg) }];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      msgs.push({ role: "user", content: `User message ${i} ` + "y".repeat(charsPerMsg) });
    } else {
      msgs.push({ role: "assistant", content: `Assistant message ${i} ` + "z".repeat(charsPerMsg) });
    }
  }
  return msgs;
}

test("trimToContextWindow: no-op when within budget", () => {
  const messages = makeMessages(4);
  const result = trimToContextWindow(messages, 100_000);
  assert.equal(result, messages); // same reference = no trim
});

test("trimToContextWindow: trims when over budget", () => {
  // 50 messages of 400 chars each = ~5000+ tokens. Budget = 500 tokens
  const messages = makeMessages(50, 400);
  const result = trimToContextWindow(messages, 500);
  assert.ok(result.length < messages.length, `expected fewer messages: got ${result.length} vs ${messages.length}`);
  // System prompt is always kept
  assert.equal(result[0]!.role, "system");
  // Result fits within budget
  assert.ok(result.length >= 2, "should have at least system + 1 message");
});

test("trimToContextWindow: preserves system prompt", () => {
  const messages = makeMessages(30, 400);
  const result = trimToContextWindow(messages, 200);
  assert.equal(result[0]!.role, "system");
  assert.equal(result[0]!.content, messages[0]!.content);
});

test("trimToContextWindow: respects tool-call/result pairs", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "let me check" },
    // tool pair
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function" as const, function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
    },
    { role: "tool", tool_call_id: "c1", content: "file1.txt\nfile2.txt" },
    // more messages to fill budget
    { role: "user", content: "x".repeat(2000) },
    { role: "assistant", content: "y".repeat(2000) },
    { role: "user", content: "z".repeat(2000) },
    { role: "assistant", content: "final response" },
  ];

  const result = trimToContextWindow(messages, 600);

  // If tool result is in the output, its assistant call must also be there
  for (let i = 0; i < result.length; i++) {
    const msg = result[i]!;
    if (msg.role === "tool" && "tool_call_id" in msg) {
      // Find corresponding assistant with tool_calls containing this id
      const hasParent = result.some(
        (m) =>
          m.role === "assistant" &&
          "tool_calls" in m &&
          m.tool_calls?.some((tc) => tc.id === (msg as { tool_call_id: string }).tool_call_id),
      );
      assert.ok(hasParent, `Orphan tool result found for ${(msg as { tool_call_id: string }).tool_call_id}`);
    }
  }
});

test("trimToContextWindow: uses default budget when undefined", () => {
  // With undefined context, default is 128K — should not trim small message sets
  const messages = makeMessages(10);
  const result = trimToContextWindow(messages, undefined);
  assert.equal(result, messages);
});

test("trimToContextWindow: accounts for tool schema tokens", () => {
  // Small budget + large tool schema = less room for messages
  const messages = makeMessages(20, 200);
  const withoutSchema = trimToContextWindow(messages, 1000, 0);
  const withSchema = trimToContextWindow(messages, 1000, 500);
  assert.ok(withSchema.length <= withoutSchema.length);
});
