import { describe, expect, test } from "bun:test";
import { __testing as anthropic } from "../../src/llm/anthropic.ts";
import type { ChatMessage, ProviderMeta } from "../../src/llm/provider.ts";

const SELF = { backend: "anthropic", model: "claude-opus-5", replay: true };
const NO_REPLAY = { ...SELF, replay: false };

const META: ProviderMeta = {
  backend: SELF.backend,
  model: SELF.model,
  thinking: [{ type: "thinking", thinking: "weighing it", signature: "SIG-1" }],
};

function turn(meta?: ProviderMeta): ChatMessage[] {
  return [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "on it",
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      ...(meta ? { providerMeta: meta } : {}),
    },
    { role: "tool", tool_call_id: "c1", content: "out" },
  ];
}

const assistantBlocks = (m: ChatMessage[], self = SELF): Array<Record<string, unknown>> =>
  anthropic.buildRequest(m, self).turns.find((t) => t.role === "assistant")!.content as unknown as Array<Record<string, unknown>>;

/**
 * Anthropic documents the replay as mandatory inside a tool-use turn, so the switch is the
 * provider's `reasoningReplay` and it defaults on -- there is no env var and no opt-in.
 */
describe("Anthropic thinking replay", () => {
  test("on by default: the block leads the assistant turn, ahead of text and tool_use", () => {
    const blocks = assistantBlocks(turn(META));
    // Position is load-bearing: Anthropic rejects a turn whose thinking does not come first.
    expect(blocks.map((b) => b["type"])).toEqual(["thinking", "text", "tool_use"]);
    expect(blocks[0]).toEqual({ type: "thinking", thinking: "weighing it", signature: "SIG-1" });
  });

  test("reasoningReplay=false takes it off the wire", () => {
    const body = JSON.stringify(anthropic.buildRequest(turn(META), NO_REPLAY));
    expect(body).not.toContain("SIG-1");
    expect(body).not.toContain("weighing it");
  });

  test("a block from another model is dropped, since the signature is not portable", () => {
    const foreign: ProviderMeta = { backend: "anthropic", model: "claude-something-else", thinking: META.thinking! };
    expect(JSON.stringify(anthropic.buildRequest(turn(foreign), SELF))).not.toContain("SIG-1");
  });

  test("a redacted block is replayed as-is, opaque payload and all", () => {
    // Filtering on type === "thinking" alone silently drops these and breaks the protocol.
    const meta: ProviderMeta = { backend: SELF.backend, model: SELF.model, thinking: [{ type: "redacted_thinking", data: "OPAQUE" }] };
    expect(assistantBlocks(turn(meta))[0]).toEqual({ type: "redacted_thinking", data: "OPAQUE" });
  });

  /**
   * Anthropic verifies the signature against the block and rejects an unsigned one, so a block
   * whose `signature_delta` never arrived (aborted stream) cannot go back as thinking. pi-mono
   * learned the same thing: "real Anthropic rejects empty thinking signatures".
   */
  test("a block with no signature degrades to text, it is not sent as thinking", () => {
    const meta: ProviderMeta = { backend: SELF.backend, model: SELF.model, thinking: [{ type: "thinking", thinking: "unsigned thought" }] };
    const blocks = assistantBlocks(turn(meta));
    expect(blocks.map((b) => b["type"])).toEqual(["text", "text", "tool_use"]);
    expect(blocks[0]).toEqual({ type: "text", text: "unsigned thought" });
  });

  test("an unsigned block with no text at all is dropped", () => {
    const meta: ProviderMeta = { backend: SELF.backend, model: SELF.model, thinking: [{ type: "thinking", thinking: "" }] };
    expect(assistantBlocks(turn(meta)).map((b) => b["type"])).toEqual(["text", "tool_use"]);
  });

  test("a redacted block with no payload is dropped: there is nothing to degrade to", () => {
    const meta: ProviderMeta = { backend: SELF.backend, model: SELF.model, thinking: [{ type: "redacted_thinking" }] };
    expect(assistantBlocks(turn(meta)).map((b) => b["type"])).toEqual(["text", "tool_use"]);
  });

  /**
   * Two assistant turns merge into one message, and appending the second signed sequence behind
   * the first one's text gives `thinking, text, thinking, text` -- rejected, because a message's
   * consecutive thinking blocks must be the ones it generated and must lead it. Claude Code ships
   * a 400 with this exact bug (its `ensureToolResultPairing` merges the same way).
   */
  test("merging two assistant turns never produces a second thinking sequence", () => {
    const meta = (n: string): ProviderMeta => ({
      backend: SELF.backend,
      model: SELF.model,
      thinking: [{ type: "thinking", thinking: `t${n}`, signature: `SIG${n}` }],
    });
    const merged: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "one", providerMeta: meta("1") },
      { role: "assistant", content: "two", providerMeta: meta("2") },
    ];
    const blocks = assistantBlocks(merged);
    expect(blocks.map((b) => b["type"])).toEqual(["thinking", "text", "text"]);
    expect(blocks.filter((b) => b["type"] === "thinking")).toHaveLength(1);
    expect(JSON.stringify(blocks)).not.toContain("SIG2");
  });

  test("a turn with no metadata is unchanged", () => {
    expect(assistantBlocks(turn()).map((b) => b["type"])).toEqual(["text", "tool_use"]);
  });
});

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(body));
      c.close();
    },
  });
}

describe("Anthropic thinking capture", () => {
  test("text and signature arrive on separate events and are stitched into one block", async () => {
    const response = await anthropic.processStream(
      sse([
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "weighing " } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "it" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ]),
      undefined,
      undefined,
      SELF,
    );
    expect(response.providerMeta).toEqual({ backend: SELF.backend, model: SELF.model, thinking: [{ type: "thinking", thinking: "weighing it", signature: "SIG" }] });
    // The signature must not be mistaken for thinking text on its way to the display sink.
    expect(response.reasoning).toBe("weighing it");
    expect(response.content).toBe("done");
  });

  test("blocks keep their index order", async () => {
    const response = await anthropic.processStream(
      sse([
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "A" } },
        { type: "content_block_start", index: 2, content_block: { type: "redacted_thinking", data: "OPAQUE" } },
        { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "B" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ]),
      undefined,
      undefined,
      SELF,
    );
    expect(response.providerMeta?.thinking?.map((t) => t.signature ?? t.data)).toEqual(["A", "B", "OPAQUE"]);
  });

  test("no thinking means no metadata at all, not an empty envelope", async () => {
    const response = await anthropic.processStream(
      sse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ]),
      undefined,
      undefined,
      SELF,
    );
    expect(response.providerMeta).toBeUndefined();
  });
});
