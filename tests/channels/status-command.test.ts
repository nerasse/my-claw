import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { SessionData } from "../../src/sessions/store.ts";
import { recordApiCall } from "../../src/analytics/usage-db.ts";
import { ModelPricing } from "../../src/llm/pricing.ts";
import { handleStatusCommand } from "../../src/channels/status-command.ts";

function pricing(): ModelPricing {
  mkdirSync(MY_CLAW_DIR, { recursive: true });
  writeFileSync(
    join(MY_CLAW_DIR, "model-pricing.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      hosts: { "fireworks-ai": "https://api.fireworks.ai/inference/v1/" },
      models: {
        anthropic: { "claude-opus-5": { cost: { input: 5, output: 25, cacheRead: 0.5 }, id: "claude-opus-5" } },
        "fireworks-ai": { "kimi-k26-turbo": { cost: { input: 2, output: 8 }, id: "kimi-k2.6-turbo" } },
      },
    }),
  );
  return new ModelPricing(() => ({}), () => []);
}

const config = {
  llm: { defaultModel: "claude-opus-5", models: [{ id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 } }] },
} as unknown as MyClawConfig;

function session(id: string, over: Partial<SessionData> = {}): SessionData {
  return {
    id,
    platform: "matrix",
    chatType: "group",
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [{ role: "user", content: "hello", timestamp: new Date().toISOString() }],
    ...over,
  };
}

test("no session still reports the model and the live runs", () => {
  const out = handleStatusCommand({ config, sessionId: "matrix/room/!empty:test", session: null, liveRuns: [] });
  expect(out).toContain("Session: none active");
  expect(out).toContain("claude-opus-5");
});

test("both totals appear, labelled, because the same id carries two answers", () => {
  const sessionId = "matrix/room/!twototals:test";
  // Analytics keeps accumulating under the room-derived id; /new resets only the session counter.
  for (let i = 0; i < 4; i++) {
    recordApiCall({
      sessionId,
      parentSessionId: sessionId,
      platform: "matrix",
      model: "claude-opus-5",
      baseUrl: "claude-sdk",
      streaming: true,
      caller: "orchestrator",
      promptTokens: 1_000_000,
      completionTokens: 1000,
      cacheReadTokens: 0,
      totalTokens: 1001000, toolCalls: 0,
      iteration: 1,
      durationMs: 1000,
    });
  }
  const out = handleStatusCommand({
    config,
    sessionId,
    session: session(sessionId, { tokenUsage: { promptTokens: 500, completionTokens: 10, totalTokens: 510, apiCalls: 1 } }),
    liveRuns: [],
    pricing: pricing(),
  });
  expect(out).toContain("This conversation");
  expect(out).toContain("1 calls");
  expect(out).toContain("This session, 90 d");
  expect(out).toContain("4 calls");
  // A subscription figure must be marked as not-a-charge, never folded into the billed total.
  expect(out).toContain("reference");
  expect(out).not.toContain("billed");
});

test("a billed endpoint and a subscription are totalled separately", () => {
  const sessionId = "matrix/room/!mixed:test";
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "accounts/fireworks/routers/kimi-k2p6-turbo",
    baseUrl: "https://api.fireworks.ai/inference/v1", streaming: true, caller: "orchestrator",
    promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1000000, toolCalls: 0, iteration: 1, durationMs: 10,
  });
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "claude-opus-5",
    baseUrl: "claude-sdk", streaming: true, caller: "orchestrator",
    promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1000000, toolCalls: 0, iteration: 1, durationMs: 10,
  });
  const out = handleStatusCommand({ config, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
  expect(out).toContain("billed        $2.00");
  expect(out).toContain("reference    *$5.00");
});

test("work delegated to a sub-agent is reported under the session that drove it", () => {
  const parent = "matrix/room/!parent:test";
  recordApiCall({
    sessionId: "subagent/digger-aaaa", parentSessionId: parent, platform: "matrix", model: "claude-opus-5",
    baseUrl: "claude-sdk", streaming: true, caller: "subagent",
    promptTokens: 200_000, completionTokens: 100, totalTokens: 200100, toolCalls: 0, iteration: 1, durationMs: 10,
  });
  recordApiCall({
    sessionId: "browser-subagent", parentSessionId: parent, platform: "internal", model: "claude-opus-5",
    baseUrl: "claude-sdk", streaming: false, caller: "browser",
    promptTokens: 50_000, completionTokens: 50, totalTokens: 50050, toolCalls: 0, iteration: 1, durationMs: 10,
  });
  const out = handleStatusCommand({ config, sessionId: parent, session: session(parent), liveRuns: [], pricing: pricing() });
  expect(out).toContain("Delegated by this session");
  expect(out).toContain("2 calls");
  // The parent's own block must not absorb the children's calls.
  expect(out).not.toContain("This session, 90 d");
});

test("measured and estimated context are both shown, since only the estimate drives compaction", () => {
  const sessionId = "matrix/room/!ctx:test";
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "claude-opus-5", baseUrl: "claude-sdk",
    streaming: true, caller: "orchestrator", promptTokens: 12_345, completionTokens: 1, totalTokens: 12346, toolCalls: 0, iteration: 1, durationMs: 5,
  });
  const out = handleStatusCommand({ config, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
  // The provider's own number, not the character-count estimate, and its share of the window.
  expect(out).toMatch(/measured\s+12k on the last call - 1\.2% of the limit/);
  expect(out).toContain("estimated");
  expect(out).toContain("drives auto-compaction");
  // The two must not be conflated: the estimate is tiny here while the measurement is not.
  expect(out).not.toMatch(/estimated\s+12k/);
});

test("a sub-agent session reports its visibility and who spawned it", () => {
  const id = "subagent/digger-bbbb";
  const out = handleStatusCommand({
    config,
    sessionId: id,
    session: session(id, {
      meta: { displayName: "digger", type: "research", parentSessionId: "matrix/room/!boss:test", visibility: "private", createdAt: new Date().toISOString() },
    }),
    liveRuns: [],
    pricing: pricing(),
  });
  expect(out).toContain("private");
  expect(out).toContain("matrix/room/!boss:test");
});

test("an active run is named", () => {
  const id = "matrix/room/!running:test";
  const out = handleStatusCommand({
    config,
    sessionId: id,
    session: session(id),
    liveRuns: [{ label: "digger", depth: 1, startedAt: Date.now() }, { label: "main", depth: 0, startedAt: Date.now() }],
  });
  expect(out).toContain("digger[1]");
  expect(out).toContain("main");
});

test("without a price table the tokens are still reported", () => {
  const sessionId = "matrix/room/!noprice:test";
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "claude-opus-5", baseUrl: "claude-sdk",
    streaming: true, caller: "orchestrator", promptTokens: 1000, completionTokens: 10, totalTokens: 1010, toolCalls: 0, iteration: 1, durationMs: 5,
  });
  const out = handleStatusCommand({ config, sessionId, session: session(sessionId), liveRuns: [] });
  expect(out).toContain("1 calls");
  expect(out).toContain("unpriced");
});
