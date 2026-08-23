import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { pruneOldToolResults, spillPath, spillToolOutput, sweepSpilledToolOutput } from "../../src/agent/context-pruning.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";

// ~2500 tokens per result at the 4-chars-per-token estimate, so a 5000-token budget protects two.
const BIG = "x".repeat(10_000);
const OPTS = { protectTokens: 5_000, headChars: 400 };

function turn(i: number, toolContent: string): ChatMessage[] {
  return [
    { role: "assistant", content: "", tool_calls: [{ id: `tc${i}`, type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `tc${i}`, content: toolContent },
  ];
}

function convo(turns: number, body = BIG): ChatMessage[] {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "do it" },
    ...Array.from({ length: turns }, (_, i) => turn(i, body)).flat(),
  ];
}

const tools = (m: ChatMessage[]) => m.filter((x) => x.role === "tool") as Array<{ content: string }>;

test("pruning: tool results beyond the protected token budget are stubbed, newest kept whole", () => {
  const out = tools(pruneOldToolResults(convo(4), OPTS));
  assert.equal(out.length, 4);
  assert.ok(out[0]!.content.includes("elided"), "oldest stubbed");
  assert.ok(out[1]!.content.includes("elided"), "second stubbed");
  assert.equal(out[2]!.content, BIG, "inside budget, kept");
  assert.equal(out[3]!.content, BIG, "newest kept");
});

test("pruning: the budget is a token count, not a turn count", () => {
  // Twenty small results fit in the budget that two big ones exhaust. A turn window cannot tell
  // these apart; that was the bug.
  const small = "y".repeat(1_000);
  const smallOut = tools(pruneOldToolResults(convo(16, small), OPTS));
  assert.ok(smallOut.every((t) => t.content === small), "sixteen small results fit inside the budget");

  const bigOut = tools(pruneOldToolResults(convo(16, BIG), OPTS));
  assert.equal(bigOut.filter((t) => t.content.includes("elided")).length, 14, "the same sixteen turns, big, spill past it");
});

test("pruning: the stub keeps a head and a tail, because the verdict is on the last line", () => {
  const body = "HEAD" + "z".repeat(5_000) + "VERDICT";
  const first = tools(pruneOldToolResults(convo(8, body), OPTS))[0]!;
  assert.ok(first.content.startsWith("HEAD"), "head preserved");
  assert.ok(first.content.endsWith("VERDICT"), "tail preserved");
  assert.ok(first.content.length < body.length, "and it is shorter than the original");
});

test("pruning: the marker names a readable file instead of asking for a re-run", () => {
  const first = tools(pruneOldToolResults(convo(4), OPTS))[0]!;
  assert.ok(first.content.includes(spillPath(BIG)), "path to the full output");
  assert.ok(first.content.includes("do not re-run the tool"), "re-running is what we are trying to stop");
  assert.ok(!first.content.includes("re-run the tool if"), "the old invitation is gone");
});

test("pruning: measuring does not write, sending does, and both produce the same string", () => {
  const path = spillPath(BIG);
  const measured = tools(pruneOldToolResults(convo(4), OPTS))[0]!.content;
  assert.equal(existsSync(path), false, "measuring path stays off the disk");

  const written: string[] = [];
  const sent = tools(pruneOldToolResults(convo(4), { ...OPTS, spill: (p, c) => { written.push(p); spillToolOutput(p, c); } }))[0]!.content;
  assert.equal(sent, measured, "the measured prompt is the sent prompt");
  assert.equal(readFileSync(path, "utf8"), BIG, "full output recoverable from the named path");
});

test("pruning: spilling is content-addressed, so the same output is written once", () => {
  const path = spillPath("recurring output");
  spillToolOutput(path, "recurring output");
  spillToolOutput(path, "recurring output");
  assert.equal(readFileSync(path, "utf8"), "recurring output");
});

test("pruning: nothing to prune leaves the array untouched (same reference)", () => {
  const messages = convo(1);
  assert.equal(pruneOldToolResults(messages, OPTS), messages);
});

test("pruning: short tool results are never stubbed (a stub would cost more than it saves)", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    ...turn(0, "short output"),
    ...turn(1, BIG),
    ...turn(2, BIG),
  ];
  assert.equal(tools(pruneOldToolResults(messages, OPTS))[0]!.content, "short output");
});

test("pruning: user, assistant, and system messages are never touched", () => {
  const messages = convo(5);
  const out = pruneOldToolResults(messages, OPTS);
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.role !== "tool") assert.equal(out[i], messages[i]);
  }
});

test("pruning: idempotent — a stub is not re-stubbed", () => {
  const once = pruneOldToolResults(convo(4), OPTS);
  assert.equal(pruneOldToolResults(once, OPTS), once);
});

test("pruning: input array is not mutated", () => {
  const messages = convo(4);
  pruneOldToolResults(messages, OPTS);
  assert.ok(tools(messages).every((t) => t.content === BIG), "original untouched");
});

test("spill sweep: keeps recent files, removes ones past the retention window", () => {
  const path = spillPath("sweepable");
  spillToolOutput(path, "sweepable");
  assert.equal(sweepSpilledToolOutput(), 0, "fresh spill survives");
  assert.ok(existsSync(path));
  assert.ok(sweepSpilledToolOutput(Date.now() + 8 * 86_400_000) >= 1, "aged spill is swept");
  assert.equal(existsSync(path), false);
});
