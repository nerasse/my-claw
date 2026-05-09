import test from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter } from "../src/channels/telegram/adapter.ts";
import type { TelegramChannelConfig } from "../src/core/config.ts";

function createBotMock() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const handlers = new Map<string, (ctx: unknown) => unknown>();

  return {
    calls,
    handlers,
    bot: {
      botInfo: { id: 99, username: "myclawbot" },
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
      command(name: string, handler: (ctx: unknown) => unknown) {
        handlers.set(`command:${name}`, handler);
      },
      hears(trigger: RegExp, handler: (ctx: unknown) => unknown) {
        handlers.set(`hears:${trigger.source}`, handler);
      },
      on(event: string, handler: (ctx: unknown) => unknown) {
        handlers.set(`on:${event}`, handler);
      },
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
    dm: {
      policy: "allowlist",
      allowFrom: ["u1"],
    },
    groupPolicy: "allowlist",
    groupAllowFrom: ["u1"],
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

test("TelegramAdapter streamer respects replyToMode off", async () => {
  const { bot, calls } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      replyToMode: "off",
    },
    new Set(["u1"]),
    bot as never,
  );

  const streamer = adapter.createStreamer({
    id: "42",
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

  const sendCall = calls.find((call) => call.method === "sendMessage");
  assert.equal(Boolean((sendCall?.args[2] as { reply_parameters?: unknown } | undefined)?.reply_parameters), false);
});

test("TelegramAdapter send honors replyToMode first across split chunks", async () => {
  const { bot, calls } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      replyToMode: "first",
    },
    new Set(["u1"]),
    bot as never,
  );

  await adapter.send("c1", { text: "a".repeat(5000), replyToId: "9" });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sendCalls.length, 2);
  assert.equal(Boolean((sendCalls[0]?.args[2] as { reply_parameters?: unknown }).reply_parameters), true);
  assert.equal(Boolean((sendCalls[1]?.args[2] as { reply_parameters?: unknown }).reply_parameters), false);
});

test("TelegramAdapter send honors replyToMode all across split chunks", async () => {
  const { bot, calls } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      replyToMode: "all",
    },
    new Set(["u1"]),
    bot as never,
  );

  await adapter.send("c1", { text: "a".repeat(5000), replyToId: "9" });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sendCalls.length, 2);
  assert.equal(Boolean((sendCalls[0]?.args[2] as { reply_parameters?: unknown }).reply_parameters), true);
  assert.equal(Boolean((sendCalls[1]?.args[2] as { reply_parameters?: unknown }).reply_parameters), true);
});

test("TelegramAdapter maps legacy threadReplies inbound to first reply behavior", async () => {
  const { bot, calls } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      threadReplies: "inbound",
    },
    new Set(["u1"]),
    bot as never,
  );

  await adapter.send("c1", { text: "a".repeat(5000), replyToId: "9" });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sendCalls.length, 2);
  assert.equal(Boolean((sendCalls[0]?.args[2] as { reply_parameters?: unknown }).reply_parameters), true);
  assert.equal(Boolean((sendCalls[1]?.args[2] as { reply_parameters?: unknown }).reply_parameters), false);
});

test("TelegramAdapter maps legacy threadReplies always to all reply behavior", async () => {
  const { bot, calls } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      threadReplies: "always",
    },
    new Set(["u1"]),
    bot as never,
  );

  await adapter.send("c1", { text: "a".repeat(5000), replyToId: "9" });

  const sendCalls = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sendCalls.length, 2);
  assert.equal(Boolean((sendCalls[0]?.args[2] as { reply_parameters?: unknown }).reply_parameters), true);
  assert.equal(Boolean((sendCalls[1]?.args[2] as { reply_parameters?: unknown }).reply_parameters), true);
});

test("TelegramAdapter normalizes replies, thread context, mentions, and DM session scope", async () => {
  const { bot, handlers } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      dm: { sessionScope: "per-chat" },
      groups: { "*": { requireMention: false } },
      historyLimit: 3,
    },
    new Set(["u1"]),
    bot as never,
  );

  const seen: unknown[] = [];
  adapter.onMessage(async (message) => {
    seen.push(message);
  });

  await adapter.start();
  const handler = handlers.get("on:message");
  assert.equal(typeof handler, "function");

  const firstCtx = {
    update: { update_id: 10 },
    message: {
      message_id: 10,
      date: 100,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u1", is_bot: false, username: "u1" },
      text: "thread root",
      message_thread_id: 777,
    },
  };
  await handler?.(firstCtx);

  const secondCtx = {
    update: { update_id: 11 },
    message: {
      message_id: 11,
      date: 101,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u1", is_bot: false, username: "u1" },
      text: "@myclawbot follow-up",
      entities: [{ type: "mention", offset: 0, length: 10 }],
      message_thread_id: 777,
      reply_to_message: {
        message_id: 10,
        date: 100,
        chat: { id: -1001, type: "supergroup" },
        from: { id: "u1", is_bot: false, username: "u1" },
        text: "thread root",
        message_thread_id: 777,
      },
    },
  };
  await handler?.(secondCtx);

  const thirdCtx = {
    update: { update_id: 12 },
    message: {
      message_id: 12,
      date: 102,
      chat: { id: 123, type: "private" },
      from: { id: "u1", is_bot: false, username: "u1" },
      text: "dm message",
    },
  };
  await handler?.(thirdCtx);

  assert.equal(seen.length, 3);

  const threaded = seen[1] as {
    replyToId?: string;
    replyToText?: string;
    replyToSender?: string;
    threadId?: string;
    threadRootText?: string;
    roomContext?: string;
    mentionsBot?: boolean;
  };
  assert.equal(threaded.replyToId, "10");
  assert.equal(threaded.replyToText, "thread root");
  assert.equal(threaded.replyToSender, "@u1");
  assert.equal(threaded.threadId, "777");
  assert.equal(threaded.threadRootText, "thread root");
  assert.match(threaded.roomContext ?? "", /Recent Thread Context/);
  assert.equal(threaded.mentionsBot, true);

  const dm = seen[2] as { sessionScope?: string };
  assert.equal(dm.sessionScope, "per-chat");
});

test("TelegramAdapter blocks group traffic outside configured Telegram group policy", async () => {
  const { bot, handlers } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      groupPolicy: "allowlist",
      groupAllowFrom: ["u1"],
      groups: { "-1001": { requireMention: false } },
    },
    new Set(),
    bot as never,
  );

  const seen: unknown[] = [];
  adapter.onMessage(async (message) => {
    seen.push(message);
  });

  await adapter.start();
  const handler = handlers.get("on:message");

  await handler?.({
    update: { update_id: 21 },
    message: {
      message_id: 1,
      date: 100,
      chat: { id: -2002, type: "supergroup" },
      from: { id: "u1", is_bot: false, username: "u1" },
      text: "hello",
    },
  });

  assert.equal(seen.length, 0);
});

test("TelegramAdapter accepts wildcard group config without mention requirement", async () => {
  const { bot, handlers } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      groupPolicy: "allowlist",
      groupAllowFrom: ["u1"],
      groups: { "*": { requireMention: false } },
    },
    new Set(),
    bot as never,
  );

  const seen: string[] = [];
  adapter.onMessage(async (message) => {
    seen.push(message.text);
  });

  await adapter.start();
  const handler = handlers.get("on:message");

  await handler?.({
    update: { update_id: 31 },
    message: {
      message_id: 2,
      date: 100,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u1", is_bot: false, username: "u1" },
      text: "hello",
    },
  });

  assert.deepEqual(seen, ["hello"]);
});

test("TelegramAdapter requires explicit bot addressing in groups when configured", async () => {
  const { bot, handlers } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      groups: { "-1001": { requireMention: true } },
    },
    new Set(),
    bot as never,
  );

  const seen: string[] = [];
  adapter.onMessage(async (message) => {
    seen.push(message.text);
  });

  await adapter.start();
  const handler = handlers.get("on:message");

  await handler?.({
    update: { update_id: 41 },
    message: {
      message_id: 3,
      date: 100,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u1", is_bot: false, username: "u1" },
      text: "hello",
    },
  });
  await handler?.({
    update: { update_id: 42 },
    message: {
      message_id: 4,
      date: 101,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u1", is_bot: false, username: "u1" },
      text: "@myclawbot hello",
      entities: [{ type: "mention", offset: 0, length: 10 }],
    },
  });
  await handler?.({
    update: { update_id: 43 },
    message: {
      message_id: 5,
      date: 102,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u1", is_bot: false, username: "u1" },
      text: "/status@myclawbot",
      entities: [{ type: "bot_command", offset: 0, length: 17 }],
    },
  });

  assert.deepEqual(seen, ["@myclawbot hello", "/status@myclawbot"]);
});

test("TelegramAdapter blocks configured bot senders unless they mention the bot", async () => {
  const { bot, handlers } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      groupAllowFrom: ["helperbot"],
      botUserIds: ["helperbot"],
      allowBots: "mentions",
      groups: { "-1001": { requireMention: false } },
    },
    new Set(),
    bot as never,
  );

  const seen: string[] = [];
  adapter.onMessage(async (message) => {
    seen.push(message.text);
  });

  await adapter.start();
  const handler = handlers.get("on:message");

  await handler?.({
    update: { update_id: 51 },
    message: {
      message_id: 6,
      date: 100,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "helperbot", is_bot: true, username: "helperbot" },
      text: "hello",
    },
  });
  await handler?.({
    update: { update_id: 52 },
    message: {
      message_id: 7,
      date: 101,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "helperbot", is_bot: true, username: "helperbot" },
      text: "@myclawbot hello",
      entities: [{ type: "mention", offset: 0, length: 10 }],
    },
  });

  assert.deepEqual(seen, ["@myclawbot hello"]);
});

test("TelegramAdapter keeps explicit reply quote when contextVisibility is allowlist_quote", async () => {
  const { bot, handlers } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      contextVisibility: "allowlist_quote",
      groupAllowFrom: ["u1"],
      groups: { "-1001": { requireMention: false } },
      historyLimit: 3,
    },
    new Set(),
    bot as never,
  );

  const seen: Array<{ replyToText?: string; replyToSender?: string; roomContext?: string; threadRootText?: string }> = [];
  adapter.onMessage(async (message) => {
    seen.push({
      replyToText: message.replyToText,
      replyToSender: message.replyToSender,
      roomContext: message.roomContext,
      threadRootText: message.threadRootText,
    });
  });

  await adapter.start();
  const handler = handlers.get("on:message");

  await handler?.({
    update: { update_id: 61 },
    message: {
      message_id: 20,
      date: 100,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u2", is_bot: false, username: "u2" },
      text: "blocked root",
      message_thread_id: 777,
    },
  });
  await handler?.({
    update: { update_id: 62 },
    message: {
      message_id: 21,
      date: 101,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u1", is_bot: false, username: "u1" },
      text: "quoted allowed only",
      message_thread_id: 777,
      reply_to_message: {
        message_id: 20,
        date: 100,
        chat: { id: -1001, type: "supergroup" },
        from: { id: "u2", is_bot: false, username: "u2" },
        text: "blocked root",
        message_thread_id: 777,
      },
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.replyToText, "blocked root");
  assert.equal(seen[0]?.replyToSender, "@u2");
  assert.equal(seen[0]?.roomContext, undefined);
  assert.equal(seen[0]?.threadRootText, undefined);
});

test("TelegramAdapter omits blocked supplemental context when contextVisibility is allowlist", async () => {
  const { bot, handlers } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      contextVisibility: "allowlist",
      groupAllowFrom: ["u1"],
      groups: { "-1001": { requireMention: false } },
      historyLimit: 3,
    },
    new Set(),
    bot as never,
  );

  const seen: Array<{ replyToText?: string; roomContext?: string; threadRootText?: string }> = [];
  adapter.onMessage(async (message) => {
    seen.push({
      replyToText: message.replyToText,
      roomContext: message.roomContext,
      threadRootText: message.threadRootText,
    });
  });

  await adapter.start();
  const handler = handlers.get("on:message");

  await handler?.({
    update: { update_id: 71 },
    message: {
      message_id: 30,
      date: 100,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u2", is_bot: false, username: "u2" },
      text: "blocked root",
      message_thread_id: 888,
    },
  });
  await handler?.({
    update: { update_id: 72 },
    message: {
      message_id: 31,
      date: 101,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u1", is_bot: false, username: "u1" },
      text: "allowed message",
      message_thread_id: 888,
      reply_to_message: {
        message_id: 30,
        date: 100,
        chat: { id: -1001, type: "supergroup" },
        from: { id: "u2", is_bot: false, username: "u2" },
        text: "blocked root",
        message_thread_id: 888,
      },
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.replyToText, undefined);
  assert.equal(seen[0]?.threadRootText, undefined);
  assert.equal(seen[0]?.roomContext, undefined);
});

test("TelegramAdapter normalizes poll messages into text", async () => {
  const { bot, handlers } = createBotMock();
  const adapter = new TelegramAdapter(
    {
      ...createConfig(),
      groups: { "-1001": { requireMention: false } },
      historyLimit: 2,
    },
    new Set(["u1"]),
    bot as never,
  );

  const seen: Array<{ text: string; roomContext?: string }> = [];
  adapter.onMessage(async (message) => {
    seen.push({ text: message.text, roomContext: message.roomContext });
  });

  await adapter.start();
  const handler = handlers.get("on:message");

  await handler?.({
    update: { update_id: 81 },
    message: {
      message_id: 40,
      date: 100,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u1", is_bot: false, username: "u1" },
      poll: {
        question: "Lunch?",
        options: [
          { text: "Pizza", voter_count: 1 },
          { text: "Salad", voter_count: 0 },
        ],
        total_voter_count: 1,
      },
    },
  });
  await handler?.({
    update: { update_id: 82 },
    message: {
      message_id: 41,
      date: 101,
      chat: { id: -1001, type: "supergroup" },
      from: { id: "u1", is_bot: false, username: "u1" },
      text: "hello",
    },
  });

  assert.match(seen[0]?.text ?? "", /\[Poll\]/);
  assert.match(seen[0]?.text ?? "", /Lunch\?/);
  assert.match(seen[0]?.text ?? "", /Pizza \(1 vote\)/);
  assert.match(seen[1]?.roomContext ?? "", /\[Poll\]/);
});
