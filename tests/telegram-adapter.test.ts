import test from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter } from "../src/channels/telegram.ts";
import type { TelegramChannelConfig } from "../src/config.ts";

function createBotMock() {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  return {
    calls,
    bot: {
      api: {
        config: { use() {} },
        async sendMessage(...args: unknown[]) {
          calls.push({ method: "sendMessage", args });
          return { message_id: calls.length };
        },
        async editMessageText(...args: unknown[]) {
          calls.push({ method: "editMessageText", args });
          return true;
        },
        async deleteMessage(...args: unknown[]) {
          calls.push({ method: "deleteMessage", args });
          return true;
        },
        async sendChatAction(...args: unknown[]) {
          calls.push({ method: "sendChatAction", args });
          return true;
        },
        async setMessageReaction(...args: unknown[]) {
          calls.push({ method: "setMessageReaction", args });
          return true;
        },
        async setMyCommands(...args: unknown[]) {
          calls.push({ method: "setMyCommands", args });
          return true;
        },
      },
      catch() {},
      command() {},
      on() {},
      async init() {},
      start() {},
      async stop() {},
    },
  };
}

function createConfig(): TelegramChannelConfig {
  return {
    token: "test-token",
    linkPreview: false,
    streaming: { enabled: true, minChars: 1, throttleMs: 0 },
    reactions: { enabled: true },
    errorPolicy: "always",
  };
}

test("TelegramAdapter send splits long text and disables previews", async () => {
  const { bot, calls } = createBotMock();
  const adapter = new TelegramAdapter(createConfig(), new Set(["u1"]), bot as never);

  await adapter.send("c1", { text: "a".repeat(5000) });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sendCalls.length, 2);
  assert.deepEqual((sendCalls[0]?.args[2] as { link_preview_options?: unknown }).link_preview_options, {
    is_disabled: true,
  });
});

test("TelegramAdapter streamer uses bot edit/send helpers", async () => {
  const { bot, calls } = createBotMock();
  const adapter = new TelegramAdapter(createConfig(), new Set(["u1"]), bot as never);

  const streamer = adapter.createStreamer({
    id: "1",
    platform: "telegram",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
  });

  await streamer.push("hello");
  await streamer.finish();

  assert.equal(calls.some((call) => call.method === "sendMessage"), true);
  assert.equal(calls.some((call) => call.method === "editMessageText"), true);
});
