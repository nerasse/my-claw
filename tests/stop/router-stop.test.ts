import { test } from "bun:test";
import assert from "node:assert/strict";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

function createMessage(userId: string): UnifiedMessage {
  return { id: "m1", platform: "telegram", userId, chatId: "c1", chatType: "dm", text: "hello", attachments: [], isForwarded: false, raw: {} };
}

test("router.stop aborts the in-flight run; route resolves to undefined (no delivery)", async () => {
  runRegistry.clear();
  const sessionManager = new SessionManager();
  const router = new MessageRouter(sessionManager, {
    async handleMessage(_m: UnifiedMessage, _s: unknown, signal?: AbortSignal) {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new AbortedError()));
      });
      return "unreachable";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  const sessionId = "telegram/dm/stop-user";
  const p = router.route(createMessage("stop-user"));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(router.stop(sessionId), true);
  const res = await p;
  assert.equal(res, undefined);

  // run cleared from registry -> second stop is a no-op
  assert.equal(router.stop(sessionId), false);
  runRegistry.clear();
});

test("router.stop on an idle session returns false", async () => {
  runRegistry.clear();
  const router = new MessageRouter(new SessionManager(), {
    async handleMessage() { return "ok"; },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);
  assert.equal(router.stop("telegram/dm/nobody"), false);
  runRegistry.clear();
});

test("router.stop targets only the requested session", async () => {
  runRegistry.clear();
  const sessionManager = new SessionManager();
  const finished: string[] = [];
  const router = new MessageRouter(sessionManager, {
    async handleMessage(m: UnifiedMessage, _s: unknown, signal?: AbortSignal) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { finished.push(m.userId); resolve(); }, 100);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(new AbortedError()); });
      });
      return "ok";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  const pA = router.route(createMessage("user-a"));
  const pB = router.route(createMessage("user-b"));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(router.stop("telegram/dm/user-a"), true);
  const [rA, rB] = await Promise.all([pA, pB]);
  assert.equal(rA, undefined);          // A aborted
  assert.equal(rB?.text, "ok");         // B untouched
  assert.deepEqual(finished, ["user-b"]);
  runRegistry.clear();
});
