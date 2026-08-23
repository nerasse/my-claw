import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatMessage, ProviderMeta } from "../../src/llm/provider.ts";

/**
 * The replay switch is read at module load, so each case has to import a fresh copy of the module
 * with the variable already set. `bun`'s registry is keyed by resolved path plus a query, which is
 * the cheapest way to get one.
 */
let modCount = 0;
async function loadAnthropic(replay: boolean): Promise<{ buildRequest: (m: ChatMessage[], self?: { backend: string; model: string }) => { turns: Array<{ role: string; content: Array<Record<string, unknown>> }> } }> {
  if (replay) process.env["ANTHROPIC_THINKING_REPLAY"] = "1";
  else delete process.env["ANTHROPIC_THINKING_REPLAY"];
  const mod = (await import(`../../src/llm/anthropic.ts?replay=${replay}-${modCount++}`)) as {
    __testing: { buildRequest: (m: ChatMessage[], self?: { backend: string; model: string }) => { turns: Array<{ role: string; content: Array<Record<string, unknown>> }> } };
  };
  return mod.__testing;
}

const SELF = { backend: "anthropic", model: "claude-opus-5" };

const META: ProviderMeta = {
  ...SELF,
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

const saved = process.env["ANTHROPIC_THINKING_REPLAY"];
beforeEach(() => {
  delete process.env["ANTHROPIC_THINKING_REPLAY"];
});
afterEach(() => {
  if (saved === undefined) delete process.env["ANTHROPIC_THINKING_REPLAY"];
  else process.env["ANTHROPIC_THINKING_REPLAY"] = saved;
});

describe("Anthropic thinking replay", () => {
  test("off by default: a signed block is not sent back", async () => {
    const { buildRequest } = await loadAnthropic(false);
    const body = JSON.stringify(buildRequest(turn(META), SELF));
    expect(body).not.toContain("SIG-1");
    expect(body).not.toContain("weighing it");
  });

  test("on: the block leads the assistant turn, ahead of text and tool_use", async () => {
    const { buildRequest } = await loadAnthropic(true);
    const { turns } = buildRequest(turn(META), SELF);
    const assistant = turns.find((t) => t.role === "assistant")!;
    // Position is load-bearing: Anthropic rejects a turn whose thinking does not come first.
    expect(assistant.content.map((b) => b["type"])).toEqual(["thinking", "text", "tool_use"]);
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "weighing it", signature: "SIG-1" });
  });

  test("on: a block from another model is dropped, since the signature is not portable", async () => {
    const { buildRequest } = await loadAnthropic(true);
    const foreign: ProviderMeta = { backend: "anthropic", model: "claude-something-else", thinking: META.thinking! };
    const body = JSON.stringify(buildRequest(turn(foreign), SELF));
    expect(body).not.toContain("SIG-1");
  });

  test("on: a redacted block is replayed as-is, opaque payload and all", async () => {
    const { buildRequest } = await loadAnthropic(true);
    const meta: ProviderMeta = { ...SELF, thinking: [{ type: "redacted_thinking", data: "OPAQUE" }] };
    const { turns } = buildRequest(turn(meta), SELF);
    const assistant = turns.find((t) => t.role === "assistant")!;
    expect(assistant.content[0]).toEqual({ type: "redacted_thinking", data: "OPAQUE" });
  });

  test("on: a turn with no metadata is unchanged", async () => {
    const { buildRequest } = await loadAnthropic(true);
    const { turns } = buildRequest(turn(), SELF);
    const assistant = turns.find((t) => t.role === "assistant")!;
    expect(assistant.content.map((b) => b["type"])).toEqual(["text", "tool_use"]);
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
    const { processStream } = (await import("../../src/llm/anthropic.ts")).__testing;
    const response = await processStream(
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
    expect(response.providerMeta).toEqual({ ...SELF, thinking: [{ type: "thinking", thinking: "weighing it", signature: "SIG" }] });
    // The signature must not be mistaken for thinking text on its way to the display sink.
    expect(response.reasoning).toBe("weighing it");
    expect(response.content).toBe("done");
  });

  test("blocks keep their index order", async () => {
    const { processStream } = (await import("../../src/llm/anthropic.ts")).__testing;
    const response = await processStream(
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
    const { processStream } = (await import("../../src/llm/anthropic.ts")).__testing;
    const response = await processStream(
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
