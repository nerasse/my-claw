import { test } from "bun:test";
import assert from "node:assert/strict";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

const config: MyClawConfig = {
  whitelist: ["u1"], blacklist: [], channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {},
};

const SESSION_ID = "telegram/dm/u1";
function message(id: string): UnifiedMessage {
  return { id, platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text: id, attachments: [], isForwarded: false, raw: {} };
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a message during an active run is injected, not run separately", async () => {
  runRegistry.clear();
  const drained: string[] = [];
  let runs = 0;
  const router = new MessageRouter(new SessionManager(), {
    async handleMessage(_m: UnifiedMessage, s: SessionData) {
      runs++;
      await delay(40);
      drained.push(...runRegistry.drainInjections(s.id).map((x) => x.id));
      return "done";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never, config);

  const p1 = router.route(message("m1"));
  await delay(15); // let run #1 start (isRunning -> true)
  const p2 = router.route(message("m2")); // injected into run #1
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1?.text, "done");
  assert.equal(r2, undefined); // injected -> no own delivery
  assert.equal(runs, 1); // a single run executed
  assert.deepEqual(drained, ["m2"]);
  runRegistry.clear();
});

test("aborting a run rejects a pending injected message", async () => {
  runRegistry.clear();
  const router = new MessageRouter(new SessionManager(), {
    async handleMessage(_m: UnifiedMessage, _s: SessionData, signal?: AbortSignal) {
      await new Promise<void>((_res, rej) => signal?.addEventListener("abort", () => rej(new AbortedError())));
      return "x";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never, config);

  const p1 = router.route(message("m1"));
  await delay(15);
  const p2 = router.route(message("m2")); // injected, pending (never drained)
  await delay(15);

  assert.equal(router.stop(SESSION_ID), true);
  assert.equal(await p1, undefined);
  await assert.rejects(p2, (e: unknown) => e instanceof AbortedError);
  runRegistry.clear();
});

test("with injection disabled, a second message runs as a separate queued run", async () => {
  runRegistry.clear();
  let runs = 0;
  const router = new MessageRouter(new SessionManager(), {
    async handleMessage() { runs++; await delay(20); return "done"; },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never, { ...config, injection: { enabled: false } });

  const p1 = router.route(message("m1"));
  await delay(10);
  const p2 = router.route(message("m2"));
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1?.text, "done");
  assert.equal(r2?.text, "done"); // separate run -> its own result
  assert.equal(runs, 2);
  runRegistry.clear();
});
