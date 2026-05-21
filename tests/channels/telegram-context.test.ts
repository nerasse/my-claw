import { describe, test, expect } from "bun:test";
import type { UnifiedMessage, Attachment } from "../../src/channels/types.ts";
import type { TelegramChannelConfig } from "../../src/core/config.ts";
import type {
  TelegramHistoryEntry,
  TelegramStoredMessageContext,
} from "../../src/channels/telegram/context.ts";
import {
  senderLabel,
  historyScopeKey,
  threadRootKey,
  messageContextKey,
  contextTextForMessage,
  contextTextFromRawMessage,
  pruneMessageContexts,
  pruneThreadRoots,
  rememberInboundContext,
  MAX_HISTORY_SCOPE_ENTRIES,
  MAX_MESSAGE_CONTEXT_ENTRIES,
  MAX_THREAD_ROOT_ENTRIES,
} from "../../src/channels/telegram/context.ts";

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: "1",
    platform: "telegram",
    userId: "100",
    chatId: "200",
    chatType: "group",
    text: "",
    attachments: [],
    isForwarded: false,
    raw: { from: { id: 1, is_bot: false, first_name: "Test" } },
    ...overrides,
  };
}

describe("senderLabel", () => {
  test("undefined from returns unknown", () => {
    expect(senderLabel(undefined)).toBe("unknown");
  });

  test("from with username returns @username", () => {
    expect(
      senderLabel({ id: 1, is_bot: false, first_name: "A", username: "testuser" }),
    ).toBe("@testuser");
  });

  test("from with first+last name, no username returns full name", () => {
    expect(
      senderLabel({ id: 1, is_bot: false, first_name: "John", last_name: "Doe" }),
    ).toBe("John Doe");
  });

  test("from with only id returns stringified id", () => {
    expect(
      senderLabel({ id: 42, is_bot: false, first_name: "" }),
    ).toBe("42");
  });

  test("from with whitespace-only username falls back to name", () => {
    expect(
      senderLabel({ id: 1, is_bot: false, first_name: "Alice", username: "   " }),
    ).toBe("Alice");
  });
});

describe("key generation", () => {
  test("historyScopeKey without thread", () => {
    expect(historyScopeKey("chat1")).toBe("chat1/room");
  });

  test("historyScopeKey with thread", () => {
    expect(historyScopeKey("chat1", "thread5")).toBe("chat1/thread/thread5");
  });

  test("threadRootKey", () => {
    expect(threadRootKey("chat1", "thread5")).toBe("chat1/thread-root/thread5");
  });

  test("messageContextKey", () => {
    expect(messageContextKey("chat1", "msg99")).toBe("chat1/msg99");
  });
});

describe("contextTextForMessage", () => {
  test("normal text returns text", () => {
    const msg = makeMessage({ text: "hello world" });
    expect(contextTextForMessage(msg)).toBe("hello world");
  });

  test("meta command returns undefined", () => {
    const msg = makeMessage({ text: "/help" });
    expect(contextTextForMessage(msg)).toBeUndefined();
  });

  test("empty text with attachments returns attachment summaries", () => {
    const attachments: Attachment[] = [
      { type: "image", summaryText: "a photo of a cat" },
      { type: "file", filename: "report.pdf" },
    ];
    const msg = makeMessage({ text: "", attachments });
    expect(contextTextForMessage(msg)).toBe("a photo of a cat [file: report.pdf]");
  });

  test("empty text with attachment without summary uses type bracket", () => {
    const attachments: Attachment[] = [{ type: "video" }];
    const msg = makeMessage({ text: "", attachments });
    expect(contextTextForMessage(msg)).toBe("[video]");
  });

  test("empty text no attachments returns undefined", () => {
    const msg = makeMessage({ text: "", attachments: [] });
    expect(contextTextForMessage(msg)).toBeUndefined();
  });
});

describe("contextTextFromRawMessage", () => {
  const identity = (msg: { text?: string }) => msg.text;

  test("message with text returns text", () => {
    const msg = { message_id: 1, date: 0, chat: { id: 1, type: "private" as const }, text: "hello" };
    expect(contextTextFromRawMessage(msg as never, identity as never)).toBe("hello");
  });

  test("message with photo returns [image]", () => {
    const msg = { message_id: 1, date: 0, chat: { id: 1, type: "private" as const }, photo: [{ file_id: "x", file_unique_id: "x", width: 1, height: 1 }] };
    expect(contextTextFromRawMessage(msg as never, (() => undefined) as never)).toBe("[image]");
  });

  test("message with video returns [video]", () => {
    const msg = { message_id: 1, date: 0, chat: { id: 1, type: "private" as const }, video: { file_id: "x", file_unique_id: "x", width: 1, height: 1, duration: 10 } };
    expect(contextTextFromRawMessage(msg as never, (() => undefined) as never)).toBe("[video]");
  });

  test("message with voice returns [voice message]", () => {
    const msg = { message_id: 1, date: 0, chat: { id: 1, type: "private" as const }, voice: { file_id: "x", file_unique_id: "x", duration: 5 } };
    expect(contextTextFromRawMessage(msg as never, (() => undefined) as never)).toBe("[voice message]");
  });

  test("message with document with filename returns [file: name]", () => {
    const msg = { message_id: 1, date: 0, chat: { id: 1, type: "private" as const }, document: { file_id: "x", file_unique_id: "x", file_name: "report.pdf" } };
    expect(contextTextFromRawMessage(msg as never, (() => undefined) as never)).toBe("[file: report.pdf]");
  });

  test("message with document without filename returns [file]", () => {
    const msg = { message_id: 1, date: 0, chat: { id: 1, type: "private" as const }, document: { file_id: "x", file_unique_id: "x" } };
    expect(contextTextFromRawMessage(msg as never, (() => undefined) as never)).toBe("[file]");
  });

  test("message with sticker returns [sticker]", () => {
    const msg = { message_id: 1, date: 0, chat: { id: 1, type: "private" as const }, sticker: { file_id: "x", file_unique_id: "x", type: "regular" as const, width: 1, height: 1, is_animated: false, is_video: false } };
    expect(contextTextFromRawMessage(msg as never, (() => undefined) as never)).toBe("[sticker]");
  });
});

describe("pruneMessageContexts", () => {
  test("under limit does not prune", () => {
    const map = new Map<string, TelegramStoredMessageContext>();
    for (let i = 0; i < 10; i++) {
      map.set(`key-${i}`, { messageId: String(i), senderId: "1", senderLabel: "x", text: "t", scopeKey: "s" });
    }
    pruneMessageContexts(map);
    expect(map.size).toBe(10);
  });

  test("over limit prunes oldest entries to exactly the limit", () => {
    const map = new Map<string, TelegramStoredMessageContext>();
    const total = MAX_MESSAGE_CONTEXT_ENTRIES + 50;
    for (let i = 0; i < total; i++) {
      map.set(`key-${i}`, { messageId: String(i), senderId: "1", senderLabel: "x", text: "t", scopeKey: "s" });
    }
    pruneMessageContexts(map);
    expect(map.size).toBe(MAX_MESSAGE_CONTEXT_ENTRIES);
    expect(map.has("key-0")).toBe(false);
    expect(map.has("key-49")).toBe(false);
    expect(map.has("key-50")).toBe(true);
  });
});

describe("pruneThreadRoots", () => {
  test("over limit prunes oldest entries to exactly the limit", () => {
    const map = new Map<string, TelegramHistoryEntry>();
    const total = MAX_THREAD_ROOT_ENTRIES + 30;
    for (let i = 0; i < total; i++) {
      map.set(`key-${i}`, { messageId: String(i), senderId: "1", senderLabel: "x", text: "t" });
    }
    pruneThreadRoots(map);
    expect(map.size).toBe(MAX_THREAD_ROOT_ENTRIES);
    expect(map.has("key-0")).toBe(false);
    expect(map.has("key-29")).toBe(false);
    expect(map.has("key-30")).toBe(true);
  });
});

describe("rememberInboundContext", () => {
  const config: TelegramChannelConfig = { token: "test" };
  const whitelist = new Set<string>();

  function freshMaps() {
    return {
      historyByScope: new Map<string, TelegramHistoryEntry[]>(),
      messageContexts: new Map<string, TelegramStoredMessageContext>(),
      threadRoots: new Map<string, TelegramHistoryEntry>(),
    };
  }

  test("adds entry to history and message contexts", () => {
    const { historyByScope, messageContexts, threadRoots } = freshMaps();
    const msg = makeMessage({
      id: "10",
      text: "hello",
      chatId: "c1",
      userId: "u1",
      raw: { from: { id: 1, is_bot: false, first_name: "Test", username: "testuser" } },
    });

    rememberInboundContext(config, whitelist, historyByScope, messageContexts, threadRoots, msg);

    const scopeKey = historyScopeKey("c1");
    const history = historyByScope.get(scopeKey);
    expect(history).toBeDefined();
    expect(history!.length).toBe(1);
    expect(history![0].text).toBe("hello");
    expect(history![0].senderLabel).toBe("@testuser");

    const ctxKey = messageContextKey("c1", "10");
    expect(messageContexts.has(ctxKey)).toBe(true);
    expect(messageContexts.get(ctxKey)!.scopeKey).toBe(scopeKey);
  });

  test("history capped at MAX_HISTORY_SCOPE_ENTRIES", () => {
    const { historyByScope, messageContexts, threadRoots } = freshMaps();

    for (let i = 0; i < MAX_HISTORY_SCOPE_ENTRIES + 10; i++) {
      const msg = makeMessage({
        id: String(i),
        text: `msg-${i}`,
        chatId: "c1",
        userId: "u1",
        raw: { from: { id: 1, is_bot: false, first_name: "Test" } },
      });
      rememberInboundContext(config, whitelist, historyByScope, messageContexts, threadRoots, msg);
    }

    const history = historyByScope.get(historyScopeKey("c1"))!;
    expect(history.length).toBe(MAX_HISTORY_SCOPE_ENTRIES);
    expect(history[0].text).toBe("msg-10");
  });

  test("thread root stored only for first message in thread", () => {
    const { historyByScope, messageContexts, threadRoots } = freshMaps();

    const msg1 = makeMessage({
      id: "1",
      text: "first",
      chatId: "c1",
      threadId: "t1",
      userId: "u1",
      raw: { from: { id: 1, is_bot: false, first_name: "Test" } },
    });
    const msg2 = makeMessage({
      id: "2",
      text: "second",
      chatId: "c1",
      threadId: "t1",
      userId: "u1",
      raw: { from: { id: 1, is_bot: false, first_name: "Test" } },
    });

    rememberInboundContext(config, whitelist, historyByScope, messageContexts, threadRoots, msg1);
    rememberInboundContext(config, whitelist, historyByScope, messageContexts, threadRoots, msg2);

    const rootEntry = threadRoots.get(threadRootKey("c1", "t1"));
    expect(rootEntry).toBeDefined();
    expect(rootEntry!.text).toBe("first");
  });

  test("meta command message is not stored", () => {
    const { historyByScope, messageContexts, threadRoots } = freshMaps();
    const msg = makeMessage({
      id: "99",
      text: "/help",
      chatId: "c1",
      userId: "u1",
      raw: { from: { id: 1, is_bot: false, first_name: "Test" } },
    });

    rememberInboundContext(config, whitelist, historyByScope, messageContexts, threadRoots, msg);

    expect(historyByScope.size).toBe(0);
    expect(messageContexts.size).toBe(0);
  });
});
