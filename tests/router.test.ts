import test from "node:test";
import assert from "node:assert/strict";
import { MessageRouter } from "../src/router/router.ts";
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

test("MessageRouter blocks unauthorized users", async () => {
  const sessionManager = new SessionManager();
  const router = new MessageRouter(["u1"], sessionManager, {
    async handleMessage() {
      throw new Error("should not run");
    },
    async handleMessageStreaming() {
      throw new Error("should not run");
    },
  } as never);

  const response = await router.route(createMessage("u2"));
  assert.equal(response, undefined);
});

test("MessageRouter forwards streaming callbacks", async () => {
  const sessionManager = new SessionManager();
  const events: string[] = [];
  const router = new MessageRouter(["u1"], sessionManager, {
    async handleMessage() {
      return "plain";
    },
    async handleMessageStreaming(
      _message: UnifiedMessage,
      _session: SessionData,
      onToken: (token: string) => Promise<void>,
      onToolUse?: () => Promise<void>,
    ) {
      await onToken("a");
      await onToolUse?.();
      return "streamed";
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

  assert.equal(response, "streamed");
  assert.deepEqual(events, ["a", "tool"]);
});
