import { test } from "bun:test";
import assert from "node:assert/strict";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

function createMessage(userId: string): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId, chatId: "c1", chatType: "dm", text: "hello", attachments: [], isForwarded: false, raw: {} };
}

test("router.stop aborts the in-flight run; route resolves to undefined (no delivery)", async () => {
  runRegistry.clear();
  const sessionManager = new SessionManager();
  // route() registers the run before the handler attaches its abort listener, so a stop() fired on a
  // fixed delay could abort in that gap: the listener would then never run and route() would hang.
  let listening!: () => void;
  const handlerListening = new Promise<void>((resolve) => { listening = resolve; });
  const router = new MessageRouter(sessionManager, {
    async handleMessage(_m: UnifiedMessage, _s: unknown, signal?: AbortSignal) {
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) { reject(new AbortedError()); return; }
        signal?.addEventListener("abort", () => reject(new AbortedError()));
        listening();
      });
      return "unreachable";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  const sessionId = "my-claw-app/dm/stop-user";
  const p = router.route(createMessage("stop-user"));
  await handlerListening;

  assert.equal(router.stop(sessionId), "stopped");
  const res = await p;
  assert.equal(res, undefined);

  // run cleared from registry -> second stop is a no-op
  assert.equal(router.stop(sessionId), "idle");
  runRegistry.clear();
});

test("router.stop on an idle session returns false", async () => {
  runRegistry.clear();
  const router = new MessageRouter(new SessionManager(), {
    async handleMessage() { return "ok"; },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);
  assert.equal(router.stop("my-claw-app/dm/nobody"), "idle");
  runRegistry.clear();
});

test("router.stop targets only the requested session", async () => {
  runRegistry.clear();
  const sessionManager = new SessionManager();
  const finished: string[] = [];
  // Both handlers must have their abort listener attached before stopping A, otherwise the stop
  // lands in the registration gap and A would run to completion instead of aborting.
  let listening!: () => void;
  let pending = 2;
  const bothListening = new Promise<void>((resolve) => { listening = () => { if (--pending === 0) resolve(); }; });
  const router = new MessageRouter(sessionManager, {
    async handleMessage(m: UnifiedMessage, _s: unknown, signal?: AbortSignal) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new AbortedError()); return; }
        const t = setTimeout(() => { finished.push(m.userId); resolve(); }, 100);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(new AbortedError()); });
        listening();
      });
      return "ok";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never);

  const pA = router.route(createMessage("user-a"));
  const pB = router.route(createMessage("user-b"));
  await bothListening;

  assert.equal(router.stop("my-claw-app/dm/user-a"), "stopped");
  // The abort of that cycle is in flight: the union is what the registry names, not a boolean,
  // and a second request says so without aborting anything a second time.
  assert.equal(router.stop("my-claw-app/dm/user-a"), "stopping");
  const [rA, rB] = await Promise.all([pA, pB]);
  assert.equal(rA, undefined);          // A aborted
  assert.equal(rB?.text, "ok");         // B untouched
  assert.deepEqual(finished, ["user-b"]);
  runRegistry.clear();
});
