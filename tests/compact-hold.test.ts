/**
 * The exclusion between a compaction and a run. The bug this covers, observed in production:
 * a /compact took 101 seconds, a message sent 30 seconds later opened a run that resumed the
 * pre-compaction transcript, and the finished compaction was written into a branch nobody read.
 */

import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { runRegistry } from "../src/core/run-registry.ts";
import { hooks } from "../src/hooks/index.ts";
import type { HookEventMap } from "../src/hooks/index.ts";
import { handleCompactCommand } from "../src/channels/compact-command.ts";
import type { MyClawConfig } from "../src/core/config.ts";
import type { SessionData } from "../src/sessions/store.ts";
import { MessageRouter } from "../src/core/router.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import type { UnifiedMessage } from "../src/channels/types.ts";

function makeConfig(): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: {
      defaultProvider: "test",
      defaultModel: "test-model",
      apiKey: "k",
      vision: false,
      limit: { context: 128000, output: 4096 },
      // A claude-sdk provider: /compact then goes to the SDK engine, the one that runs for
      // minutes and drives a CLI process on the session file.
      providers: { test: { type: "claude-sdk", baseUrl: "https://test.example.com", apiKeyEnv: "TEST_KEY" } },
      models: [{ id: "test-model", label: "Test", provider: "test" }],
    },
    agents: {},
    webSearch: { baseUrl: "", language: "en" },
  } as unknown as MyClawConfig;
}

function makeSession(id: string): SessionData {
  return {
    id,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
    modelOverride: "test-model",
  };
}

afterEach(() => {
  runRegistry.clear();
});

test("a run in flight refuses the hold, so no compaction starts under it", () => {
  const { end } = runRegistry.startRoot("s1");
  assert.equal(runRegistry.beginCompaction("s1"), null);
  end();
  assert.notEqual(runRegistry.beginCompaction("s1"), null);
});

test("a compaction in flight refuses a second one, and the hold is released after it", async () => {
  const config = makeConfig();
  const session = makeSession("s2");
  let release!: () => void;
  const inflight = new Promise<{ text: string }>((resolve) => {
    release = () => resolve({ text: "Context compacted (SDK session summarized)." });
  });

  const first = handleCompactCommand({
    config,
    session,
    sdkCompact: () => inflight,
    persist: async () => {},
  });

  // The engine is still working: the session is taken, and a second /compact says so instead of
  // driving a second CLI process onto the same session file.
  while (!runRegistry.isCompacting("s2")) await Promise.resolve();
  const second = await handleCompactCommand({
    config,
    session,
    sdkCompact: () => inflight,
    persist: async () => {},
  });
  assert.equal(second.text, "A compaction is already running on this session.");

  release();
  assert.deepEqual(await first, { text: "Context compacted (SDK session summarized)." });
  assert.equal(runRegistry.isCompacting("s2"), false);
});

test("the hold is released when the engine throws", async () => {
  await assert.rejects(
    handleCompactCommand({
      config: makeConfig(),
      session: makeSession("s3"),
      sdkCompact: () => Promise.reject(new Error("cli died")),
      persist: async () => {},
    }),
    /cli died/,
  );
  assert.equal(runRegistry.isCompacting("s3"), false);
});

test("a message waits for the compaction instead of resuming the history it is replacing", async () => {
  const held = runRegistry.beginCompaction("s4");
  assert.notEqual(held, null);

  let routed = false;
  const waiting = runRegistry.waitForCompaction("s4").then(() => {
    routed = true;
  });

  await Promise.resolve();
  assert.equal(routed, false, "the run must not start while the compaction holds the session");

  held!.release();
  await waiting;
  assert.equal(routed, true);
});

test("/stop reaches a compaction, and the engine is handed the signal that carries it", async () => {
  const session = makeSession("s5");
  let seen: AbortSignal | undefined;
  let aborted = false;

  const outcome = handleCompactCommand({
    config: makeConfig(),
    session,
    sdkCompact: (_s, stopSignal) => {
      seen = stopSignal;
      return new Promise<{ text: string }>((resolve) => {
        stopSignal?.addEventListener("abort", () => {
          aborted = true;
          resolve({ text: "Compaction stopped." });
        });
      });
    },
    persist: async () => {},
  });

  while (!runRegistry.isCompacting("s5")) await Promise.resolve();
  assert.equal(runRegistry.stop("s5"), true, "/stop must report that it stopped something");
  assert.equal((await outcome).text, "Compaction stopped.");
  assert.equal(aborted, true);
  assert.equal(seen?.aborted, true);
});

test("a compaction counts as work in flight for the app's activity probe", () => {
  assert.equal(runRegistry.hasAny(), false);
  const held = runRegistry.beginCompaction("s6");
  assert.equal(runRegistry.hasAny(), true);
  held!.release();
  assert.equal(runRegistry.hasAny(), false);
});

/**
 * The completion event the push wiring listens on. It has to fire for both engines and for
 * every end of the command: the notification exists precisely for the case where nobody is
 * looking at the thread, so an end that stays silent is an end nobody hears about.
 */
test("the end of a /compact is announced once, whatever the engine answered", async () => {
  const seen: HookEventMap["session:compact:finished"][] = [];
  const collect = (payload: HookEventMap["session:compact:finished"]): void => {
    seen.push(payload);
  };
  hooks.on("session:compact:finished", collect);

  await handleCompactCommand({
    config: makeConfig(),
    session: makeSession("s7"),
    sdkCompact: async () => ({ text: "Context compacted (SDK session summarized).", summary: "kept", ok: true }),
    persist: async () => {},
    threadId: "thread-7",
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.engine, "sdk");
  assert.equal(seen[0]?.ok, true);
  assert.equal(seen[0]?.threadId, "thread-7");
  assert.equal(seen[0]?.sessionId, "s7");
  assert.equal(typeof seen[0]?.durationMs, "number");

  // An engine that ran and rewrote nothing is not a compaction: the notification must say so
  // rather than announce a context that was never freed.
  await handleCompactCommand({
    config: makeConfig(),
    session: makeSession("s8"),
    sdkCompact: async () => ({ text: "Nothing to compact yet on this session.", ok: false }),
    persist: async () => {},
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.ok, false);
  assert.equal(seen[1]?.threadId, undefined);

  await assert.rejects(
    handleCompactCommand({
      config: makeConfig(),
      session: makeSession("s9"),
      sdkCompact: () => Promise.reject(new Error("cli died")),
      persist: async () => {},
    }),
    /cli died/,
  );
  assert.equal(seen.length, 3);
  assert.equal(seen[2]?.ok, false);
  assert.equal(seen[2]?.text, "cli died");

  // A session already busy never starts an engine, so it must not announce a compaction that
  // did not happen.
  const held = runRegistry.beginCompaction("s10");
  await handleCompactCommand({
    config: makeConfig(),
    session: makeSession("s10"),
    sdkCompact: async () => ({ text: "unreachable", ok: true }),
    persist: async () => {},
  });
  assert.equal(seen.length, 3);
  held!.release();
  hooks.off("session:compact:finished", collect);
});

/**
 * The silence this covers, observed in production on 2026-08-15: a /compact ran for 110s, a
 * message sent 62s in was held to its end, and the app showed nothing at all for either. The
 * result frame is not the problem; the message parked behind it with no feedback is.
 */
test("a message parked behind a compaction is announced once, before the wait", async () => {
  runRegistry.clear();
  const seen: HookEventMap["message:queued"][] = [];
  const collect = (p: HookEventMap["message:queued"]): void => {
    seen.push(p);
  };
  hooks.on("message:queued", collect);

  const sessionId = "my-claw-app/dm/u-queued";
  const config: MyClawConfig = {
    whitelist: ["u-queued"], blacklist: [], channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
    agents: {},
  } as unknown as MyClawConfig;
  const router = new MessageRouter(new SessionManager(), {
    async handleMessage() {
      return "answered";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never, config);

  const held = runRegistry.beginCompaction(sessionId);
  assert.notEqual(held, null);

  const message: UnifiedMessage = {
    id: "m-queued", platform: "my-claw-app", userId: "u-queued", chatId: "c1", chatType: "dm",
    text: "hello", attachments: [], isForwarded: false, raw: {},
  };
  const routed = router.route(message);

  // Announced while the hold stands, not once it is over: the point is to fill the wait.
  const deadline = Date.now() + 5_000;
  while (seen.length === 0) {
    if (Date.now() > deadline) throw new Error("timed out waiting for message:queued");
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.reason, "compaction");
  assert.equal(seen[0]?.sessionId, sessionId);
  assert.equal(seen[0]?.message.id, "m-queued");
  assert.equal(runRegistry.isRunning(sessionId), false, "the run must not have started yet");

  held!.release();
  assert.equal((await routed)?.text, "answered");
  assert.equal(seen.length, 1, "one message, one announcement");

  hooks.off("message:queued", collect);
  runRegistry.clear();
});

/** A clear path stays quiet: nothing to wait for, nothing to say. */
test("a message on a free session is not announced as parked", async () => {
  runRegistry.clear();
  const seen: HookEventMap["message:queued"][] = [];
  const collect = (p: HookEventMap["message:queued"]): void => {
    seen.push(p);
  };
  hooks.on("message:queued", collect);

  const config: MyClawConfig = {
    whitelist: ["u-free"], blacklist: [], channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
    agents: {},
  } as unknown as MyClawConfig;
  const router = new MessageRouter(new SessionManager(), {
    async handleMessage() {
      return "answered";
    },
    async handleMessageStreaming() { throw new Error("unused"); },
    getResponseAttachments() { return []; },
  } as never, config);

  const answered = await router.route({
    id: "m-free", platform: "my-claw-app", userId: "u-free", chatId: "c2", chatType: "dm",
    text: "hello", attachments: [], isForwarded: false, raw: {},
  });
  assert.equal(answered?.text, "answered");
  assert.equal(seen.length, 0);

  hooks.off("message:queued", collect);
  runRegistry.clear();
});
