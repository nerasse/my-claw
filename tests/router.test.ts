import { test } from "bun:test";
import assert from "node:assert/strict";
import { MessageRouter } from "../src/core/router.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import type { UnifiedMessage } from "../src/channels/types.ts";
import type { SessionData } from "../src/sessions/store.ts";

function createMessage(userId = "u1"): UnifiedMessage {
  return {
    id: "m1",
    platform: "telegram",
    userId,
    chatId: "c1",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

test("MessageRouter does not enforce a second global auth gate", async () => {
  const sessionManager = new SessionManager();
  const router = new MessageRouter(sessionManager, {
    async handleMessage() {
      return "ok";
    },
    async handleMessageStreaming() {
      throw new Error("should not run");
    },
    getResponseAttachments() {
      return [];
    },
  } as never);

  const response = await router.route(createMessage("u2"));
  assert.equal(response?.text, "ok");
});

test("MessageRouter forwards streaming callbacks", async () => {
  const sessionManager = new SessionManager();
  const events: string[] = [];
  const router = new MessageRouter(sessionManager, {
    async handleMessage() {
      return "plain";
    },
    async handleMessageStreaming(
      _message: UnifiedMessage,
      _session: SessionData,
      onToken: (token: string) => Promise<void>,
      onToolUse?: (tools: Array<{ name: string; arguments: Record<string, unknown>; durationMs: number }>, verbose: boolean) => Promise<void>,
    ) {
      await onToken("a");
      await onToolUse?.([{ name: "bash", arguments: {}, durationMs: 10 }], true);
      return "streamed";
    },
    getResponseAttachments() {
      return [];
    },
  } as never);

  const response = await router.route(createMessage(), {
    onToken: async (token) => {
      events.push(token);
    },
    onToolUse: async () => {
      events.push("tool");
    },
  });

  assert.equal(response?.text, "streamed");
  assert.deepEqual(events, ["a", "tool"]);
});

test("MessageRouter uses room-scoped Matrix DM sessions when requested", async () => {
  const sessionManager = new SessionManager();
  let capturedSessionId = "";
  const router = new MessageRouter(sessionManager, {
    async handleMessage(_message: UnifiedMessage, session: SessionData) {
      capturedSessionId = session.id;
      session.modelOverride = "alt-model";
      return "ok";
    },
    async handleMessageStreaming() {
      throw new Error("should not run");
    },
    getResponseAttachments() {
      return [];
    },
  } as never);

  const response = await router.route({
    id: "$evt1",
    platform: "matrix",
    userId: "@u1:example.org",
    chatId: "!dm-room:test",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    sessionScope: "per-room",
    raw: {},
  });

  assert.equal(response?.text, "ok");
  assert.equal(capturedSessionId, "matrix/dm-room/!dm-room:test");
});

test("first 30 messages from one user all succeed", async () => {
  const sessionManager = new SessionManager();
  const router = new MessageRouter(sessionManager, {
    async handleMessage() { return "ok"; },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  for (let i = 0; i < 30; i++) {
    const result = await router.route(createMessage("rate-user"));
    assert.equal(result?.text, "ok");
  }
});

test("31st message within window returns rate limit text", async () => {
  const sessionManager = new SessionManager();
  const router = new MessageRouter(sessionManager, {
    async handleMessage() { return "ok"; },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  for (let i = 0; i < 30; i++) {
    await router.route(createMessage("rl-user"));
  }
  const result = await router.route(createMessage("rl-user"));
  assert.ok(result?.text.toLowerCase().includes("rate limit"));
});

test("different users have separate rate limits", async () => {
  const sessionManager = new SessionManager();
  const router = new MessageRouter(sessionManager, {
    async handleMessage() { return "ok"; },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  for (let i = 0; i < 30; i++) {
    await router.route(createMessage("user-a"));
  }
  const blockedResult = await router.route(createMessage("user-a"));
  assert.ok(blockedResult?.text.toLowerCase().includes("rate limit"));

  const otherResult = await router.route(createMessage("user-b"));
  assert.equal(otherResult?.text, "ok");
});

test("concurrent messages to same session are serialized", async () => {
  const sessionManager = new SessionManager();
  const order: string[] = [];

  let callIndex = 0;
  const router = new MessageRouter(sessionManager, {
    async handleMessage() {
      const idx = callIndex++;
      order.push(`start-${idx}`);
      await new Promise((r) => setTimeout(r, 50));
      order.push(`end-${idx}`);
      return `reply-${idx}`;
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  const msg = createMessage("serial-user");
  const [r1, r2] = await Promise.all([
    router.route(msg),
    router.route(msg),
  ]);

  assert.equal(r1?.text, "reply-0");
  assert.equal(r2?.text, "reply-1");
  assert.deepEqual(order, ["start-0", "end-0", "start-1", "end-1"]);
});

test("concurrent messages to different sessions run in parallel", async () => {
  const sessionManager = new SessionManager();
  const order: string[] = [];

  let callIndex = 0;
  const router = new MessageRouter(sessionManager, {
    async handleMessage() {
      const idx = callIndex++;
      order.push(`start-${idx}`);
      await new Promise((r) => setTimeout(r, 50));
      order.push(`end-${idx}`);
      return `reply-${idx}`;
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  const msgA: UnifiedMessage = { ...createMessage("par-user-a"), chatId: "chatA" };
  const msgB: UnifiedMessage = { ...createMessage("par-user-b"), chatId: "chatB" };

  await Promise.all([router.route(msgA), router.route(msgB)]);

  assert.equal(order[0], "start-0");
  assert.equal(order[1], "start-1");
});

test("agent error propagates and next message to same session still works", async () => {
  const sessionManager = new SessionManager();
  let shouldThrow = true;

  const router = new MessageRouter(sessionManager, {
    async handleMessage() {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("agent exploded");
      }
      return "recovered";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  const msg = createMessage("err-user");
  await assert.rejects(() => router.route(msg), { message: "agent exploded" });

  const result = await router.route(msg);
  assert.equal(result?.text, "recovered");
});

test("telegram DM session ID format", async () => {
  const sessionManager = new SessionManager();
  let capturedId = "";
  const router = new MessageRouter(sessionManager, {
    async handleMessage(_msg: UnifiedMessage, session: SessionData) {
      capturedId = session.id;
      return "ok";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  await router.route({
    id: "t1",
    platform: "telegram",
    userId: "tg-user-42",
    chatId: "tg-chat-42",
    chatType: "dm",
    text: "hi",
    attachments: [],
    isForwarded: false,
    raw: {},
  });

  assert.equal(capturedId, "telegram/dm/tg-user-42");
});

test("matrix DM with per-room scope session ID format", async () => {
  const sessionManager = new SessionManager();
  let capturedId = "";
  const router = new MessageRouter(sessionManager, {
    async handleMessage(_msg: UnifiedMessage, session: SessionData) {
      capturedId = session.id;
      return "ok";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  await router.route({
    id: "$evt2",
    platform: "matrix",
    userId: "@bob:example.org",
    chatId: "!room-abc:test",
    chatType: "dm",
    text: "hi",
    attachments: [],
    isForwarded: false,
    sessionScope: "per-room",
    raw: {},
  });

  assert.equal(capturedId, "matrix/dm-room/!room-abc:test");
});

test("matrix group session ID format", async () => {
  const sessionManager = new SessionManager();
  let capturedId = "";
  const router = new MessageRouter(sessionManager, {
    async handleMessage(_msg: UnifiedMessage, session: SessionData) {
      capturedId = session.id;
      return "ok";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  await router.route({
    id: "$evt3",
    platform: "matrix",
    userId: "@alice:example.org",
    chatId: "!group-xyz:test",
    chatType: "group",
    text: "hi",
    attachments: [],
    isForwarded: false,
    raw: {},
  });

  assert.equal(capturedId, "matrix/room/!group-xyz:test");
});
