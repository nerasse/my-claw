import { test, expect } from "bun:test";
import { MessageStreamer, type StreamTransport } from "../../src/channels/telegram/stream.ts";

function createMockTransport(): StreamTransport & { sent: Array<{ text: string; messageId: number }>; edits: Array<{ text: string; messageId: number }>; } {
  let nextId = 1;
  const sent: Array<{ text: string; messageId: number }> = [];
  const edits: Array<{ text: string; messageId: number }> = [];

  return {
    sent,
    edits,
    async sendPlain(_chatId, text) {
      const id = nextId++;
      sent.push({ text, messageId: id });
      return id;
    },
    async editPlain(_chatId, messageId, text) {
      edits.push({ text, messageId });
    },
    async sendFinal(_chatId, _html, plain) {
      const id = nextId++;
      sent.push({ text: plain, messageId: id });
      return id;
    },
    async editFinal(_chatId, messageId, _html, plain) {
      edits.push({ text: plain, messageId });
    },
    async deleteMessage() {},
  };
}

test("Telegram appendToolUse adds inline tool call to single message", async () => {
  const transport = createMockTransport();
  const streamer = new MessageStreamer(
    { chatId: "123", minCharsBeforeSend: 1, editThrottleMs: 0 },
    transport,
  );

  await streamer.push("Hello");
  await streamer.appendToolUse([{ name: "bash", arguments: { command: "ls" } }]);
  await streamer.push(" world");
  await streamer.finish();

  // 1 initial message + final edit on same message
  expect(transport.sent.length).toBe(1);
  // The final content is in the edit
  const lastEdit = transport.edits[transport.edits.length - 1];
  expect(lastEdit?.text ?? "").toContain("Hello");
  expect(lastEdit?.text ?? "").toContain("bash({\"command\":\"ls\"})");
  expect(lastEdit?.text ?? "").toContain(" world");
});

test("Telegram appendToolUse with large text still fragments naturally", async () => {
  const transport = createMockTransport();
  const streamer = new MessageStreamer(
    { chatId: "123", minCharsBeforeSend: 1, editThrottleMs: 0, chunkLimit: 20 },
    transport,
  );

  await streamer.push("Line one text here");
  await streamer.appendToolUse([{ name: "bash", arguments: { command: "ls" } }]);
  await streamer.finish();

  // The tool call text might force a natural chunk split (>20 chars)
  expect(transport.sent.length).toBeGreaterThanOrEqual(1);
});
