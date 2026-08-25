import { describe, expect, test } from "bun:test";
import { __testing as anthropic } from "../../src/llm/anthropic.ts";
import { promptOf } from "../../src/sessions/projection.ts";
import { setupSessionLog, appendMessages } from "../helpers/session-log.ts";
import { deleteSession } from "../../src/sessions/store.ts";
import type { ChatMessage, ProviderMeta } from "../../src/llm/provider.ts";
import { estimateMessagesTokens } from "../../src/llm/tokens.ts";
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

  test("replaying a session into a prompt cannot produce it", async () => {
    // The live replay: entries in, prompt out. `promptOf` is the only thing that builds one.
    const setup = await setupSessionLog("meta/containment");
    try {
      appendMessages(setup.log, [
        { role: "user", content: "go", timestamp: "t" },
        { role: "assistant", content: "answer", timestamp: "t", reasoning: "thought", toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] },
        { role: "tool", toolCallId: "c1", content: "out", timestamp: "t" },
      ]);
      const out = promptOf(setup.log.entries(), setup.log.leaf());
      expect(JSON.stringify(out)).not.toContain("providerMeta");
      // The display-only reasoning text must not leak either; same fence, older rule.
      expect(JSON.stringify(out)).not.toContain("thought");
    } finally {
      setup.cleanup();
      await deleteSession("meta/containment");
    }
  });

  test("the Anthropic transport drops it: that protocol has no such item", () => {
    const body = JSON.stringify(anthropic.buildRequest(TURN));
    expect(body).not.toContain("SECRET-BLOB");
    expect(body).not.toContain("providerMeta");
  });
});

describe("provider metadata is weighed, not just carried", () => {
  /**
   * It is prompt content the model is billed for. Uncounted, every occupancy reader sees a prompt
   * smaller than the one being sent -- the 0.4.42 over-read inverted, and the inverted form walks
   * into a hard context rejection instead of an unnecessary compaction.
   */
  test("an encrypted reasoning item adds to the estimate", () => {
    const bare: ChatMessage[] = [{ role: "assistant", content: "hi" }];
    const withMeta: ChatMessage[] = [
      { role: "assistant", content: "hi", providerMeta: { backend: "codex", model: "m", reasoning: [{ id: "rs_1", encrypted: "x".repeat(4000) }] } },
    ];
    const delta = estimateMessagesTokens(withMeta) - estimateMessagesTokens(bare);
    expect(delta).toBeGreaterThan(900);
  });

  test("a thinking block and its signature both count", () => {
    const bare: ChatMessage[] = [{ role: "assistant", content: "hi" }];
    const withMeta: ChatMessage[] = [
      { role: "assistant", content: "hi", providerMeta: { backend: "anthropic", model: "m", thinking: [{ type: "thinking", thinking: "t".repeat(2000), signature: "s".repeat(2000) }] } },
    ];
    expect(estimateMessagesTokens(withMeta) - estimateMessagesTokens(bare)).toBeGreaterThan(900);
  });

  test("replayed chat reasoning counts in both shapes", () => {
    const bare: ChatMessage[] = [{ role: "assistant", content: "hi" }];
    const text: ChatMessage[] = [
      { role: "assistant", content: "hi", providerMeta: { backend: "openai", model: "m", chat: { field: "reasoning_content", text: "y".repeat(4000) } } },
    ];
    const details: ChatMessage[] = [
      { role: "assistant", content: "hi", providerMeta: { backend: "openai", model: "m", chat: { field: "reasoning_details", details: [{ blob: "z".repeat(4000) }] } } },
    ];
    expect(estimateMessagesTokens(text) - estimateMessagesTokens(bare)).toBeGreaterThan(900);
    expect(estimateMessagesTokens(details) - estimateMessagesTokens(bare)).toBeGreaterThan(900);
  });

  test("no metadata weighs nothing extra", () => {
    const bare: ChatMessage[] = [{ role: "assistant", content: "hi" }];
    expect(estimateMessagesTokens(bare)).toBe(estimateMessagesTokens([{ role: "assistant", content: "hi" }]));
  });
});
