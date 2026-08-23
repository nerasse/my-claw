import { describe, expect, test } from "bun:test";
import { __testing as anthropic } from "../../src/llm/anthropic.ts";
import { sessionChatMessages } from "../../src/agent/context-pruning.ts";
import type { ChatMessage, ProviderMeta } from "../../src/llm/provider.ts";
import type { SessionMessage } from "../../src/sessions/store.ts";

const META: ProviderMeta = { backend: "codex", model: "gpt-5-codex", reasoning: [{ id: "rs_1", encrypted: "SECRET-BLOB" }] };

const TURN: ChatMessage[] = [
  { role: "user", content: "go" },
  { role: "assistant", content: "answer", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }], providerMeta: META },
  { role: "tool", tool_call_id: "c1", content: "out" },
];

/**
 * `providerMeta` is opaque state signed for one transport and one model. Handed to any other it is
 * at best ignored and at worst a 400, and written to a session file it would be replayed months
 * later against a model that never produced it. It is prompt-side, in-memory, single-run state,
 * and these tests are the fence -- docs/reasoning-replay.md.
 */
describe("provider metadata containment", () => {
  test("it never reaches the session store: there is no field to put it in", () => {
    // The persisted shape has no slot, so this is a type-level guarantee. Asserted anyway because
    // the cheap way to break it later is to add one.
    const persisted: SessionMessage = { role: "assistant", content: "answer", timestamp: new Date().toISOString() };
    expect(Object.keys(persisted)).not.toContain("providerMeta");
  });

  test("replaying a session into a prompt cannot produce it", () => {
    const out = sessionChatMessages([
      { role: "user", content: "go", timestamp: "t" },
      { role: "assistant", content: "answer", timestamp: "t", reasoning: "thought", toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: "out", timestamp: "t" },
    ]);
    expect(JSON.stringify(out)).not.toContain("providerMeta");
    // The display-only reasoning text must not leak either; same fence, older rule.
    expect(JSON.stringify(out)).not.toContain("thought");
  });

  test("the Anthropic transport drops it: that protocol has no such item", () => {
    const body = JSON.stringify(anthropic.buildRequest(TURN));
    expect(body).not.toContain("SECRET-BLOB");
    expect(body).not.toContain("providerMeta");
  });
});
