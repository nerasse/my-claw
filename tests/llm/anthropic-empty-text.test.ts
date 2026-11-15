/**
 * Anthropic refuses a request holding an empty text block ("messages: text content blocks must be
 * non-empty"), and a retry reposts the same prompt, so one such block costs the whole run. Whatever
 * produced it upstream, the transport does not put it on the wire.
 */

import { describe, test, expect } from "bun:test";
import { __testing } from "../../src/llm/anthropic.ts";
import type { ChatMessage } from "../../src/llm/provider.ts";

const { buildRequest } = __testing;

describe("anthropic transport and empty text", () => {
  test("a picture sent without a word is the picture alone", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ];
    const { turns } = buildRequest(messages);
    expect(turns.length).toBe(1);
    expect(turns[0]!.content.map((b) => b.type)).toEqual(["image"]);
  });

  test("a whitespace-only text part is dropped, the others stay", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "  \n" },
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ];
    const { turns } = buildRequest(messages);
    expect(turns[0]!.content.map((b) => b.type)).toEqual(["text", "image"]);
  });

  test("an empty user turn is not sent, and the assistant turns around it merge", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "first" },
      { role: "user", content: "" },
      { role: "assistant", content: "second" },
      { role: "user", content: "and then?" },
    ];
    const { turns } = buildRequest(messages);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[1]!.content.map((b) => (b.type === "text" ? b.text : b.type))).toEqual(["first", "second"]);
  });

  /**
   * A prompt that ends on the model's own turn is refused outright -- "This model does not support
   * assistant message prefill. The conversation must end with a user message" -- and a retry
   * reposts the same history, so nothing about retrying helps. It cost two runs on one thread on
   * 2026-11-15, both times because a run held a context array a second handle had moved past.
   */
  test("a prompt ending on the assistant's turn is given something to answer", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "an answer with no question after it" },
    ];
    const { turns } = buildRequest(messages);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    const tail = turns[2]!.content[0];
    expect(tail?.type).toBe("text");
    expect(tail && "text" in tail ? tail.text : "").toContain("cut off");
  });
});
