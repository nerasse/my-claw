import { test } from "bun:test";
import assert from "node:assert/strict";
import { pruneOldToolResults } from "../../src/agent/context-pruning.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";

const OPTS = { keepLastAssistantTurns: 2, headChars: 50 };
const BIG = "x".repeat(2000);

function turn(i: number, toolContent: string): ChatMessage[] {
  return [
    { role: "assistant", content: "", tool_calls: [{ id: `tc${i}`, type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `tc${i}`, content: toolContent },
  ];
}

function convo(turns: number): ChatMessage[] {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "do it" },
    ...Array.from({ length: turns }, (_, i) => turn(i, BIG)).flat(),
  ];
}

test("pruning: tool results older than the window are stubbed, recent ones kept", () => {
  const messages = convo(4);
  const out = pruneOldToolResults(messages, OPTS);
  const tools = out.filter((m) => m.role === "tool") as Array<{ content: string }>;
  assert.equal(tools.length, 4);
  assert.ok(tools[0]!.content.includes("pruned"), "oldest stubbed");
  assert.ok(tools[1]!.content.includes("pruned"), "second stubbed");
  assert.equal(tools[2]!.content, BIG, "window turn kept");
  assert.equal(tools[3]!.content, BIG, "latest kept");
});

test("pruning: stub keeps the head and states the pruned size", () => {
  const messages = convo(4);
  const out = pruneOldToolResults(messages, OPTS);
  const first = out.find((m) => m.role === "tool") as { content: string };
  assert.ok(first.content.startsWith("x".repeat(50)), "head preserved");
  assert.ok(first.content.includes(`${2000 - 50} chars`), "pruned size stated");
  assert.ok(first.content.includes("re-run the tool"), "recovery hint present");
});

test("pruning: fewer assistant turns than the window is a no-op (same reference)", () => {
  const messages = convo(2);
  assert.equal(pruneOldToolResults(messages, OPTS), messages);
});

test("pruning: short tool results are never stubbed (would not save anything)", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    ...turn(0, "short output"),
    ...turn(1, BIG),
    ...turn(2, BIG),
  ];
  const out = pruneOldToolResults(messages, OPTS);
  const first = out.find((m) => m.role === "tool") as { content: string };
  assert.equal(first.content, "short output");
});

test("pruning: user, assistant, and system messages are never touched", () => {
  const messages = convo(5);
  const out = pruneOldToolResults(messages, OPTS);
  assert.equal(out[0], messages[0]);
  assert.equal(out[1], messages[1]);
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.role !== "tool") assert.equal(out[i], messages[i]);
  }
});

test("pruning: idempotent — a stub is not re-stubbed", () => {
  const once = pruneOldToolResults(convo(4), OPTS);
  const twice = pruneOldToolResults(once, OPTS);
  assert.equal(twice, once);
});

test("pruning: input array is not mutated", () => {
  const messages = convo(4);
  pruneOldToolResults(messages, OPTS);
  const tools = messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
  assert.ok(tools.every((t) => t.content === BIG), "original untouched");
});
