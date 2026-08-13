import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { SessionData } from "../../src/sessions/store.ts";
import { recordApiCall } from "../../src/analytics/usage-db.ts";
import { ModelPricing, CACHE_VERSION } from "../../src/llm/pricing.ts";
import { handleStatusCommand, statusReport } from "../../src/channels/status-command.ts";
import { chatModel } from "../../src/llm/chat-model.ts";

function pricing(): ModelPricing {
  mkdirSync(MY_CLAW_DIR, { recursive: true });
  writeFileSync(
    join(MY_CLAW_DIR, "model-pricing.json"),
    JSON.stringify({
      version: CACHE_VERSION,
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
  // Anchored on the total line itself: the word appears in prose elsewhere, and the claim being
  // made is about the absence of a charge, not about the absence of a string.
  expect(out).not.toMatch(/^ {2}billed\s/m);
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

test("measured, estimated and occupied are reported apart, because the estimate under-counts", () => {
  const sessionId = "matrix/room/!ctx:test";
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "claude-opus-5", baseUrl: "claude-sdk",
    streaming: true, caller: "orchestrator", promptTokens: 12_345, completionTokens: 1, totalTokens: 12346, toolCalls: 0, iteration: 1, durationMs: 5,
  });
  // No session.lastPrompt here, so this also covers the analytics fallback for older sessions.
  const out = handleStatusCommand({ config, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
  // Share of the *effective* window: claude-opus-5 resolves to 1M and the default cap lowers it to
  // 512k, so a percentage computed against the raw window would read half as much.
  expect(out).toMatch(/measured\s+12k on the last call - 2\.4% of the limit/);
  expect(out).toContain("estimated");
  // The gate reads the occupied line, not the estimate, and the label has to say so.
  expect(out).toMatch(/occupied\s+\S+ \(measured prompt plus the turns since, drives auto-compaction\)/);
  // The three must not be conflated: the estimate is tiny here while the measurement is not.
  expect(out).not.toMatch(/estimated\s+12k/);
});

test("the cap lowers the window and says what it lowered, so the number can be explained", () => {
  const sessionId = "matrix/room/!capped:test";
  const out = handleStatusCommand({ config, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
  expect(out).toMatch(/context limit\s+512k \(declared, capped from 1,000,000\)/);
});

test("a session that asked for the full window is not capped, and the override is named", () => {
  const sessionId = "matrix/room/!full:test";
  const out = handleStatusCommand({
    config,
    sessionId,
    session: session(sessionId, { contextOverride: "full" }),
    liveRuns: [],
    pricing: pricing(),
  });
  expect(out).toMatch(/context limit\s+1\.0M \(declared, session override: full\)/);
  expect(out).not.toContain("capped from");
  // The threshold has to follow the override, or the gate would still compact at the capped size.
  expect(out).toMatch(/threshold 80% = 800k/);
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

test("after a reset the previous call is not reported as filling the window", () => {
  const sessionId = "matrix/room/!reset:test";
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "claude-opus-5", baseUrl: "claude-sdk",
    streaming: true, caller: "orchestrator", promptTokens: 10_000, completionTokens: 1, totalTokens: 10001, toolCalls: 0, iteration: 1, durationMs: 5,
  });
  // Analytics keeps the call; the session history does not. Showing it as a share of the window
  // would contradict the occupied line on the very next row.
  const out = handleStatusCommand({
    config, sessionId, session: session(sessionId, { messages: [] }), liveRuns: [], pricing: pricing(),
  });
  expect(out).toContain("measured      no call recorded yet");
  expect(out).not.toMatch(/measured\s+10k/);
});

test("statusReport hands the payload over as `status`, the field the app channel reads", () => {
  // The app channel's command output types `status` as optional, so a rename here is assignable
  // and only shows up in production as "status unavailable". Pin the field name.
  const sessionId = "matrix/room/!report:test";
  const report = statusReport({ config, sessionId, session: session(sessionId), liveRuns: [] });

  expect(report.status.model.current).toBe("claude-opus-5");
  expect(report.text).toContain("claude-opus-5");
  expect("payload" in report).toBe(false);
});

test("the report text is the chat command's, character for character", () => {
  const sessionId = "matrix/room/!parity:test";
  const data = session(sessionId);
  const report = statusReport({ config, sessionId, session: data, liveRuns: [] });

  expect(report.text).toBe(handleStatusCommand({ config, sessionId, session: data, liveRuns: [] }));
});

test("a tag reference is resolved to the model it runs, with the tag named", () => {
  const tagged = {
    llm: {
      defaultModel: "claude-opus-5",
      models: [{ id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 } }],
      tags: { zsmart: { model: "claude-opus-5" } },
    },
  } as unknown as MyClawConfig;

  const sessionId = "matrix/room/!tagged:test";
  const withTag = session(sessionId, { modelOverride: "tag:zsmart" });
  const out = handleStatusCommand({ config: tagged, sessionId, session: withTag, liveRuns: [] });
  // The page shows the model the API receives; the tag stays named so the chain is explainable.
  expect(out).toMatch(/current\s+claude-opus-5 \(tag zsmart\) \(session override\)/);
  expect(out).not.toContain("tag:zsmart");

  const report = statusReport({ config: tagged, sessionId, session: withTag, liveRuns: [] });
  expect(report.status.model.current).toBe("claude-opus-5");
  expect(report.status.model.tag).toBe("zsmart");
});

// Criterion 8 of docs/model-resolution.md: the surfaces do not each keep their own idea of the
// current model. /status is the one that was already right; this pins it to the shared function so
// the two cannot drift apart again.
test("/status names the model the run would use, pin included, exactly like chatModel", () => {
  const pinned = {
    llm: {
      defaultModel: "claude-opus-5",
      models: [
        { id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 } },
        { id: "kimi-k26-turbo", label: "Kimi", limit: { context: 200_000 } },
      ],
    },
    agents: { orchestrator: { llm: { defaultModel: "kimi-k26-turbo" } } },
  } as unknown as MyClawConfig;

  const sessionId = "matrix/room/!pin:test";
  const out = handleStatusCommand({ config: pinned, sessionId, session: session(sessionId), liveRuns: [] });
  const expected = chatModel(pinned, undefined);
  expect(expected).toBe("kimi-k26-turbo");
  expect(out).toContain(expected);
  // The global default is not what runs, so the line must not name it.
  expect(out).not.toContain("claude-opus-5");

  // And a chat with its own pick reports that instead, on the same code path.
  const withPick = session(sessionId, { modelOverride: "claude-opus-5" });
  const picked = handleStatusCommand({ config: pinned, sessionId, session: withPick, liveRuns: [] });
  expect(picked).toContain(chatModel(pinned, "claude-opus-5"));
});
