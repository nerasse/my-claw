import { test } from "bun:test";
import assert from "node:assert/strict";
import { MessageStreamer, type StreamTransport } from "../src/channels/telegram/stream.ts";

function createTransport() {
  let nextId = 1;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const transport: StreamTransport = {
    async sendPlain(chatId, text, opts) {
      calls.push({ method: "sendPlain", args: [chatId, text, opts] });
      return nextId++;
    },
    async editPlain(chatId, messageId, text) {
      calls.push({ method: "editPlain", args: [chatId, messageId, text] });
    },
    async sendFinal(chatId, html, plain, opts) {
      calls.push({ method: "sendFinal", args: [chatId, html, plain, opts] });
      return nextId++;
    },
    async editFinal(chatId, messageId, html, plain) {
      calls.push({ method: "editFinal", args: [chatId, messageId, html, plain] });
    },
    async deleteMessage(chatId, messageId) {
      calls.push({ method: "deleteMessage", args: [chatId, messageId] });
    },
  };
  return { transport, calls };
}

test("MessageStreamer waits for threshold before preview send", async () => {
  const { transport, calls } = createTransport();
  const streamer = new MessageStreamer({ chatId: "1", minCharsBeforeSend: 5, editThrottleMs: 0 }, transport);

  await streamer.push("hey");
  assert.equal(calls.length, 0);

  await streamer.push("!!");
  assert.equal(calls[0]?.method, "sendPlain");
});

test("MessageStreamer finalizes with html edit", async () => {
  const { transport, calls } = createTransport();
  const streamer = new MessageStreamer({ chatId: "1", minCharsBeforeSend: 1, editThrottleMs: 0 }, transport);

  await streamer.push("hello **world**");
  await streamer.finish();

  assert.equal(calls[0]?.method, "sendPlain");
  assert.equal(calls.at(-1)?.method, "editFinal");
  assert.match(String(calls.at(-1)?.args[2] ?? ""), /<b>world<\/b>/);
});

test("MessageStreamer overflows into a second message", async () => {
  const { transport, calls } = createTransport();
  const streamer = new MessageStreamer({ chatId: "1", minCharsBeforeSend: 1, editThrottleMs: 0, chunkLimit: 10 }, transport);

  await streamer.push("a".repeat(25));
  await streamer.finish();

  const sendCalls = calls.filter((call) => call.method === "sendPlain" || call.method === "sendFinal");
  assert.ok(sendCalls.length >= 2);
});

test("MessageStreamer appendToolUse adds inline tool call to existing lane", async () => {
  const { transport, calls } = createTransport();
  const streamer = new MessageStreamer({ chatId: "1", minCharsBeforeSend: 1, editThrottleMs: 0 }, transport);

  await streamer.push("hello");
  await streamer.appendToolUse([{ name: "bash", arguments: { command: "ls" }, durationMs: 10 }], true);
  await streamer.push("after tool");
  await streamer.finish();

  const finalEdit = calls.filter((call) => call.method === "editFinal").at(-1);
  assert.ok(finalEdit);
  const html = String(finalEdit.args[2] ?? "");
  assert.ok(html.includes("hello"));
  assert.ok(html.includes("bash"));
  assert.ok(html.includes("after tool"));
});

test("MessageStreamer abort deletes previews", async () => {
  const { transport, calls } = createTransport();
  const streamer = new MessageStreamer({ chatId: "1", minCharsBeforeSend: 1, editThrottleMs: 0 }, transport);

  await streamer.push("hello");
  await streamer.abort();

  assert.equal(calls.at(-1)?.method, "deleteMessage");
});
