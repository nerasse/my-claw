import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../provider.ts";
import { estimateMessagesTokens, trimToContextWindow } from "../tokens.ts";

function toolMessage(id: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content: "result ".repeat(2_000) };
}

describe("trimToContextWindow", () => {
  test("keeps every result of a multi-tool turn when the head crosses the turn", () => {
    const ids = ["call-a", "call-b", "call-c", "call-d"];
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "summary" },
      {
        role: "assistant",
        content: "",
        tool_calls: ids.map((id) => ({
          id,
          type: "function" as const,
          function: { name: "read", arguments: "{}" },
        })),
      },
      ...ids.map(toolMessage),
      { role: "user", content: "recent context ".repeat(12_000) },
    ];

    expect(estimateMessagesTokens(messages)).toBeGreaterThan(18_000);
    const trimmed = trimToContextWindow(messages, 18_000);
    const calls = trimmed
      .filter((message): message is Extract<ChatMessage, { role: "assistant" }> => message.role === "assistant")
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.id);
    const results = new Set(trimmed.filter((message) => message.role === "tool").map((message) => message.tool_call_id));

    expect(calls).toEqual(ids);
    expect(ids.every((id) => results.has(id))).toBe(true);
  });
});
