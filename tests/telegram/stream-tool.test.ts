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

test("Telegram appendToolUse verbose mode shows args and timing", async () => {
  const transport = createMockTransport();
  const streamer = new MessageStreamer(
    { chatId: "123", minCharsBeforeSend: 1, editThrottleMs: 0 },
    transport,
  );

  await streamer.push("Hello");
  await streamer.appendToolUse([{ name: "bash", arguments: { command: "ls" }, durationMs: 120 }], true);

  expect(transport.sent.length).toBe(1);
  const lastEdit = transport.edits[transport.edits.length - 1];
  expect(lastEdit?.text ?? "").toContain("bash({\"command\":\"ls\"}) [120ms]");
});

test("Telegram appendToolUse compact mode shows names only", async () => {
  const transport = createMockTransport();
  const streamer = new MessageStreamer(
    { chatId: "123", minCharsBeforeSend: 1, editThrottleMs: 0 },
    transport,
  );

  await streamer.push("Hello");
  await streamer.appendToolUse([
    { name: "bash", arguments: { command: "ls" }, durationMs: 100 },
    { name: "read", arguments: { path: "/tmp" }, durationMs: 50 },
  ], false);

  const lastEdit = transport.edits[transport.edits.length - 1];
  expect(lastEdit?.text ?? "").toContain("> bash, read");
  expect(lastEdit?.text ?? "").not.toContain("command");
});
