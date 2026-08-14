/**
 * The exclusion between a compaction and a run. The bug this covers, observed in production:
 * a /compact took 101 seconds, a message sent 30 seconds later opened a run that resumed the
 * pre-compaction transcript, and the finished compaction was written into a branch nobody read.
 */

import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { runRegistry } from "../src/core/run-registry.ts";
import { handleCompactCommand } from "../src/channels/compact-command.ts";
import type { MyClawConfig } from "../src/core/config.ts";
import type { SessionData } from "../src/sessions/store.ts";

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
