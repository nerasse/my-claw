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
import type { LegacySessionData } from "../src/sessions/store.ts";
import { MessageRouter } from "../src/core/router.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import type { UnifiedMessage } from "../src/channels/types.ts";
import { commandTailBudget, planCompaction, tailBudgetFor } from "../src/sessions/compaction.ts";
import { resolveFullContextWindow } from "../src/llm/context-window.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";
import { sseFromCompletion } from "./helpers/sse.ts";
import { setupSessionLog, type SessionLogSetup } from "./helpers/session-log.ts";

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
      providers: { test: { baseUrl: "https://test.example.com", apiKeyEnv: "TEST_KEY" } },
      models: [{ id: "test-model", label: "Test", provider: "test" }],
    },
    agents: {},
    // The tail is a token budget now, and these fixtures are a dozen tiny messages: without a
    // small budget the whole conversation fits in the tail and there is nothing to summarise.
    context: { autoCompact: { tailTokens: 40 } },
    webSearch: { baseUrl: "", language: "en" },
  } as unknown as MyClawConfig;
}

function makeSession(id: string): LegacySessionData {
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

/**
 * Creates a session with log entries. Long enough for the summarizer to have
 * something to compact: below `MIN_MESSAGES_TO_COMPACT` it refuses.
 */
async function makeSessionWithLog(id: string): Promise<{ session: LegacySessionData; setup: SessionLogSetup }> {
  const session = makeSession(id);
  const setup = await setupSessionLog(id);
  // Write 14 turns (7 user + 7 assistant)
  for (let i = 0; i < 7; i++) {
    setup.log.append({
      type: "user",
      prompt: true,
      text: `turn ${i * 2} ${"filler ".repeat(20)}`,
    });
    setup.log.append({
      type: "phase",
      prompt: true,
      text: `turn ${i * 2 + 1} ${"filler ".repeat(20)}`,
      runId: `run-${i}`,
    });
  }
  await setup.log.flush();
  return { session, setup };
}

/** A summary long enough to clear the summarizer's own floor. */
const SUMMARY = `The conversation covered ${"a lot of ground ".repeat(8)}and ended there.`;

function summaryResponse(content: string): Response {
  return sseFromCompletion({ choices: [{ message: { content } }], usage: {} });
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
  const { session, setup } = await makeSessionWithLog("s2");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = mockFetch(async () => {
    await gate;
    return summaryResponse(SUMMARY);
  });

  try {
    const first = handleCompactCommand({ config, session, persist: async () => {} });

    // The summarizer is still working: the session is taken, and a second /compact says so
    // instead of rewriting the same history twice.
    while (!runRegistry.isCompacting("s2")) await Promise.resolve();
    const second = await handleCompactCommand({ config, session, persist: async () => {} });
    assert.equal(second.text, "A compaction is already running on this session.");

    release();
    const outcome = await first;
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /Context compacted/);
    assert.equal(runRegistry.isCompacting("s2"), false);
  } finally {
    mock.restore();
    await setup.cleanup();
  }
});

test("the hold is released when the summarizer fails", async () => {
  // A failed summary is an outcome, not a throw: what matters here is that the session is free
  // again, because a hold left standing parks every later message forever.
  const { session, setup } = await makeSessionWithLog("s3");
  const mock = mockFetch(async () => summaryResponse(""));
  try {
    const outcome = await handleCompactCommand({
      config: makeConfig(),
      session,
      persist: async () => {},
    });
    assert.equal(outcome.ok, false);
  } finally {
    mock.restore();
    await setup.cleanup();
  }
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

test("/stop reaches a compaction and aborts the signal its hold carries", async () => {
  // /stop must find the compaction, not report "nothing to stop" because only runs are indexed.
  const held = runRegistry.beginCompaction("s5");
  assert.notEqual(held, null);
  assert.equal(held!.signal.aborted, false);

  assert.equal(runRegistry.stop("s5"), "stopped", "/stop must report that it stopped something");
  assert.equal(held!.signal.aborted, true);

  held!.release();
  assert.equal(runRegistry.isCompacting("s5"), false);
});

test("/stop during a /compact stops the summarizer, and the command answers that it was stopped", async () => {
  // The registry aborted the hold's signal, but the command never handed that signal to the
  // summarizer: /stop answered "Stopped." and the compaction ran to its end regardless. The
  // summarizer's request must carry the hold's signal, and an abort is an answer, not an error.
  const { session, setup } = await makeSessionWithLog("s5b");
  let requestSignal: AbortSignal | undefined;
  const mock = mockFetch(
    (_input?: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        requestSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  const settled: string[] = [];
  const onSettled = (payload: HookEventMap["session:compact:settled"]): void => {
    settled.push(payload.sessionId);
  };
  hooks.on("session:compact:settled", onSettled);
  try {
    const pending = handleCompactCommand({ config: makeConfig(), session, persist: async () => {} });
    while (requestSignal === undefined) await new Promise((r) => setTimeout(r, 1));
    assert.equal(requestSignal.aborted, false);

    assert.equal(runRegistry.stop("s5b"), "stopped");
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.text, "Compaction stopped.");
    assert.deepEqual(settled, ["s5b"]);
  } finally {
    hooks.off("session:compact:settled", onSettled);
    mock.restore();
    await setup.cleanup();
  }
  assert.equal(runRegistry.isCompacting("s5b"), false);
});

test("a compaction counts as work in flight for the app's activity probe", () => {
  assert.equal(runRegistry.hasAny(), false);
  const held = runRegistry.beginCompaction("s6");
  assert.equal(runRegistry.hasAny(), true);
  held!.release();
  assert.equal(runRegistry.hasAny(), false);
});

/**
 * The event the header's context figure is refreshed on: a compaction moves the boundary with no
 * turn behind it, so nothing else would move the gauge until the next run. It has to fire for
 * both engines and for every end of the command, including the ones that summarized nothing --
 * the gauge is wrong either way. It no longer publishes anything to the tray: a compaction is not
 * an event the owner has to be told about, whoever started it (docs/notifications.md).
 */
test("the end of a /compact is announced once, whatever the summarizer answered", async () => {
  const seen: HookEventMap["session:compact:finished"][] = [];
  const collect = (payload: HookEventMap["session:compact:finished"]): void => {
    seen.push(payload);
  };
  hooks.on("session:compact:finished", collect);

  const { session: s7, setup: setup7 } = await makeSessionWithLog("s7");
  const { session: s8, setup: setup8 } = await makeSessionWithLog("s8");
  let mock = mockFetch(async () => summaryResponse(SUMMARY));
  try {
    await handleCompactCommand({
      config: makeConfig(),
      session: s7,
      persist: async () => {},
      threadId: "thread-7",
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.engine, "local");
    assert.equal(seen[0]?.ok, true);
    assert.equal(seen[0]?.threadId, "thread-7");
    assert.equal(seen[0]?.sessionId, "s7");
    assert.equal(typeof seen[0]?.durationMs, "number");

    // A summarizer that ran and rewrote nothing is not a compaction: the notification must say so
    // rather than announce a context that was never freed.
    mock.restore();
    mock = mockFetch(async () => summaryResponse("too short"));
    await handleCompactCommand({
      config: makeConfig(),
      session: s8,
      persist: async () => {},
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.ok, false);
    assert.equal(seen[1]?.threadId, undefined);

    // A session too short to compact never reaches the wire, and still announces its end.
    const short = makeSession("s9");
    await handleCompactCommand({ config: makeConfig(), session: short, persist: async () => {} });
    assert.equal(seen.length, 3);
    assert.equal(seen[2]?.ok, false);

    // A session already busy never starts a summarizer, so it must not announce a compaction that
    // did not happen.
    const held = runRegistry.beginCompaction("s10");
    await handleCompactCommand({
      config: makeConfig(),
      session: makeSession("s10"),
      persist: async () => {},
    });
    assert.equal(seen.length, 3);
    held!.release();
  } finally {
    mock.restore();
    hooks.off("session:compact:finished", collect);
    await setup7.cleanup();
    await setup8.cleanup();
  }
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

/**
 * A `/compact` the owner typed draws the same boundary an automatic pass draws.
 *
 * It did not, and that was the whole defect: the manual path answered with a bubble carrying the
 * summary, the automatic one emitted this hook, and the two never met. Live, a typed compaction
 * showed no rule at all; after a reload the stored boundary drew one anyway, next to the bubble,
 * so the same summary appeared twice. The hook is what makes live and reload agree.
 */
test("a /compact the owner typed announces its boundary, like an automatic pass", async () => {
  const config = makeConfig();
  const { session, setup } = await makeSessionWithLog("s-boundary");
  const seen: Array<HookEventMap["session:compact:boundary"]> = [];
  const collect = (payload: HookEventMap["session:compact:boundary"]): void => void seen.push(payload);
  hooks.on("session:compact:boundary", collect);
  const mock = mockFetch(async () => summaryResponse(SUMMARY));

  try {
    const outcome = await handleCompactCommand({ config, session, persist: async () => {} });
    assert.equal(outcome.ok, true);
    assert.equal(seen.length, 1);
    // Addressed by session id: the channel that owns the thread picks it out, and a cron or
    // sub-agent session it does not own is skipped instead of drawn in someone else's window.
    assert.equal(seen[0]!.sessionId, "s-boundary");
    assert.equal(seen[0]!.summary, SUMMARY);
    assert.ok(seen[0]!.count > 0);
    assert.ok(seen[0]!.entryId.length > 0);
  } finally {
    hooks.off("session:compact:boundary", collect);
    mock.restore();
    await setup.cleanup();
  }
});

test("a compaction that never rewrote anything announces no boundary", async () => {
  const config = makeConfig();
  // Nothing to compact: below the floor the summarizer refuses, and a rule over an untouched
  // history would claim a cut that did not happen.
  const session = makeSession("s-nothing");
  const seen: string[] = [];
  const collect = ({ entryId }: HookEventMap["session:compact:boundary"]): void => void seen.push(entryId);
  hooks.on("session:compact:boundary", collect);

  try {
    const outcome = await handleCompactCommand({ config, session, persist: async () => {} });
    assert.equal(outcome.ok, false);
    assert.deepEqual(seen, []);
  } finally {
    hooks.off("session:compact:boundary", collect);
  }
});

/**
 * The window `/compact` resolves -- docs/compaction.md.
 *
 * The command is an explicit order, and the owner freed it from every ceiling: the session's
 * Context choice, a tag's cap, the standing cap. Those exist to brake automatic runs, whose
 * threshold is computed on the window the session actually runs under; a split made from a
 * capped window folds turns the model could have kept. The two readings are one line apart
 * (`commandTailBudget` vs `tailBudgetFor`), and this block pins the command's side.
 */
function fullWindowConfig(over?: Partial<MyClawConfig>): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: {
      defaultProvider: "test",
      defaultModel: "big-model",
      apiKey: "k",
      vision: false,
      // The global fallback sits below the model's own declaration, so "which window was read"
      // shows up in both the window and the tail.
      limit: { context: 200_000, output: 4096 },
      providers: { test: { baseUrl: "https://test.example.com", apiKeyEnv: "TEST_KEY" } },
      models: [
        { id: "big-model", label: "Big", provider: "test", limit: { context: 1_000_000 } },
        { id: "bare-model", label: "Bare", provider: "test" },
      ],
    },
    agents: {},
    webSearch: { baseUrl: "", language: "en" },
    ...over,
  } as unknown as MyClawConfig;
}

test("the /compact tail ignores the session's context override", () => {
  const config = fullWindowConfig();
  const session = makeSession("s-window-override");
  session.modelOverride = "big-model";
  session.contextOverride = 200_000;

  // 0.12 x 0.8 x 1 000 000 = 96000, over the 64 000 ceiling. In the automatic policy's hands the
  // 200 000 override caps the window to the 20 000 floor -- the reading being refused here.
  assert.equal(commandTailBudget(config, session), 64_000);

  session.contextOverride = "full";
  assert.equal(commandTailBudget(config, session), 64_000);
});

test("the /compact tail ignores a tag's contextCap", () => {
  const config = fullWindowConfig({ tags: { cheap: { model: "big-model", contextCap: 200_000 } } });
  const session = makeSession("s-window-tag-cap");
  session.modelOverride = "tag:cheap";

  assert.equal(commandTailBudget(config, session), 64_000);
});

test("the /compact window is the one the model declares, whole", () => {
  const config = fullWindowConfig();
  const window = resolveFullContextWindow(config, "big-model");
  assert.equal(window.rawSource, "declared");
  // The 512k standing cap has nothing to lower here, and the 200k global fallback is not read.
  assert.equal(window.effective, 1_000_000);
});

test("the /compact window falls to llm.limit.context when the model declares none", () => {
  const config = fullWindowConfig();
  const window = resolveFullContextWindow(config, "bare-model");
  // A last resort, never a ceiling: the global declaration is the only window this model has.
  assert.equal(window.effective, 200_000);
});

test("the /compact tail ignores the standing context cap", () => {
  const config = fullWindowConfig({ context: { cap: 200_000 } });
  const session = makeSession("s-window-cap");
  session.modelOverride = "big-model";

  assert.equal(commandTailBudget(config, session), 64_000);
});

test("a /compact runs its pass on the full window, not the session's capped one", async () => {
  const config = fullWindowConfig();
  const session = makeSession("s-window-pass");
  session.modelOverride = "big-model";
  session.contextOverride = 200_000;
  const setup = await setupSessionLog("s-window-pass");
  // ~36k tokens: over the 20 000 floor a capped window keeps, under the 64 000 the declared one
  // keeps -- so the capped reading has a middle to summarise and the full one does not.
  for (let i = 0; i < 15; i++) {
    setup.log.append({ type: "user", prompt: true, text: `turn ${i * 2} ${"filler ".repeat(600)}` });
    setup.log.append({ type: "phase", prompt: true, text: `turn ${i * 2 + 1} ${"filler ".repeat(600)}`, runId: `run-${i}` });
  }
  await setup.log.flush();

  // What the capped window would have folded, had the command inherited it: the fixture is known
  // to tell the two policies apart only if this plan has a middle at all.
  const capped = planCompaction(setup.log, tailBudgetFor(config, session));
  assert.equal(capped.ok, true, "the fixture must discriminate: the capped window has a middle");

  const mock = mockFetch(async () => summaryResponse(SUMMARY));
  try {
    const outcome = await handleCompactCommand({ config, session, persist: async () => {} });
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /Nothing to compact/);
  } finally {
    mock.restore();
    await setup.cleanup();
  }
});
