import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { LegacySessionData } from "../../src/sessions/store.ts";
import { recordApiCall } from "../../src/analytics/usage-db.ts";
import { ModelPricing, CACHE_VERSION } from "../../src/llm/pricing.ts";
import { handleStatusCommand, statusReport } from "../../src/channels/status-command.ts";
import { chatModel } from "../../src/llm/chat-model.ts";
import { saveSessionWithLog } from "../helpers/session-log.ts";

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

function session(id: string, over: Partial<LegacySessionData> = {}): LegacySessionData {
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

test("no session still reports the model and the live runs", async () => {
  const out = await handleStatusCommand({ config, sessionId: "matrix/room/!empty:test", session: null, liveRuns: [] });
  expect(out).toContain("Session: none active");
  expect(out).toContain("claude-opus-5");
});

test("both totals appear, labelled, because the same id carries two answers", async () => {
  const sessionId = "matrix/room/!twototals:test";
  // Analytics keeps accumulating under the room-derived id; /new resets only the session counter.
  for (let i = 0; i < 4; i++) {
    recordApiCall({
      sessionId,
      parentSessionId: sessionId,
      platform: "matrix",
      model: "claude-opus-5",
      baseUrl: "https://api.anthropic.com",
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
  const out = await handleStatusCommand({
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

test("a billed endpoint and a subscription are totalled separately", async () => {
  const sessionId = "matrix/room/!mixed:test";
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "accounts/fireworks/routers/kimi-k2p6-turbo",
    baseUrl: "https://api.fireworks.ai/inference/v1", streaming: true, caller: "orchestrator",
    promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1000000, toolCalls: 0, iteration: 1, durationMs: 10,
  });
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "claude-opus-5",
    baseUrl: "https://api.anthropic.com", streaming: true, caller: "orchestrator",
    promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1000000, toolCalls: 0, iteration: 1, durationMs: 10,
  });
  const out = await handleStatusCommand({ config, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
  expect(out).toContain("billed        $2.00");
  expect(out).toContain("reference    *$5.00");
});

test("work delegated to a sub-agent is reported under the session that drove it", async () => {
  const parent = "matrix/room/!parent:test";
  recordApiCall({
    sessionId: "subagent/digger-aaaa", parentSessionId: parent, platform: "matrix", model: "claude-opus-5",
    baseUrl: "https://api.anthropic.com", streaming: true, caller: "subagent",
    promptTokens: 200_000, completionTokens: 100, totalTokens: 200100, toolCalls: 0, iteration: 1, durationMs: 10,
  });
  recordApiCall({
    sessionId: "browser-subagent", parentSessionId: parent, platform: "internal", model: "claude-opus-5",
    baseUrl: "https://api.anthropic.com", streaming: false, caller: "browser",
    promptTokens: 50_000, completionTokens: 50, totalTokens: 50050, toolCalls: 0, iteration: 1, durationMs: 10,
  });
  const out = await handleStatusCommand({ config, sessionId: parent, session: session(parent), liveRuns: [], pricing: pricing() });
  expect(out).toContain("Delegated by this session");
  expect(out).toContain("2 calls");
  // The parent's own block must not absorb the children's calls.
  expect(out).not.toContain("This session, 90 d");
});

test("measured, estimated and occupied are reported apart, because the estimate under-counts", async () => {
  const sessionId = "matrix/room/!ctx:test";
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "claude-opus-5", baseUrl: "https://api.anthropic.com",
    streaming: true, caller: "orchestrator", promptTokens: 12_345, completionTokens: 1, totalTokens: 12346, toolCalls: 0, iteration: 1, durationMs: 5,
  });
  // The session needs lastPrompt since there is no log to derive measurements from.
  const sess = session(sessionId, { lastPrompt: { tokens: 12_345, messageCount: 1 } });
  await saveSessionWithLog(sessionId, sess);
  const out = await handleStatusCommand({ config, sessionId, session: sess, liveRuns: [], pricing: pricing() });
  // Share of the *effective* window: claude-opus-5 resolves to 1M and the default cap lowers it to
  // 512k, so a percentage computed against the raw window would read half as much.
  expect(out).toMatch(/measured\s+12k on the last call - 2\.4% of the limit/);
  expect(out).toContain("estimated");
  // The gate reads the occupied line, not the estimate, and the label has to say so.
  expect(out).toMatch(/occupied\s+\S+ \(measured prompt plus the turns since, drives auto-compaction\)/);
  // The three must not be conflated: the estimate is tiny here while the measurement is not.
  expect(out).not.toMatch(/estimated\s+12k/);
});

test("the cap lowers the window and says what it lowered, so the number can be explained", async () => {
  const sessionId = "matrix/room/!capped:test";
  const out = await handleStatusCommand({ config, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
  expect(out).toMatch(/context limit\s+512k \(declared, capped from 1,000,000\)/);
});

test("a session that asked for the full window is not capped, and the override is named", async () => {
  const sessionId = "matrix/room/!full:test";
  const out = await handleStatusCommand({
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

test("the request wall is reported with where the number comes from", async () => {
  // A run that died on a timeout has to be traceable to the declaration that set it: a number
  // without its provenance sends the owner editing the wrong one.
  const sessionId = "matrix/room/!wall:test";
  const plain = await handleStatusCommand({ config, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
  expect(plain).toMatch(/request wall\s+120s \(default\)/);

  // Declared providers on purpose: a model row is a new-format notion, and the legacy branch of
  // the resolver reads none of the catalogue's fields.
  const declared = {
    llm: {
      defaultProvider: "anthropic",
      providers: { anthropic: { type: "anthropic", group: "Claude" } },
      defaultModel: "claude-opus-5",
      timeoutMs: 60_000,
      models: [{ id: "claude-opus-5", label: "Opus 5", provider: "anthropic", timeoutMs: 900_000, limit: { context: 1_000_000 } }],
    },
  } as unknown as MyClawConfig;
  const own = await handleStatusCommand({ config: declared, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
  expect(own).toMatch(/request wall\s+900s \(model\)/);

  const global = {
    llm: { defaultModel: "claude-opus-5", timeoutMs: 60_000, models: [{ id: "claude-opus-5", label: "Opus 5" }] },
  } as unknown as MyClawConfig;
  const inherited = await handleStatusCommand({ config: global, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
  expect(inherited).toMatch(/request wall\s+60s \(global\)/);
});

test("no wall at all is spelled out, and travels in the payload the app draws", async () => {
  const sessionId = "matrix/room/!nowall:test";
  const unbounded = {
    llm: {
      defaultProvider: "anthropic",
      providers: { anthropic: { type: "anthropic", group: "Claude" } },
      defaultModel: "claude-opus-5",
      models: [{ id: "claude-opus-5", label: "Opus 5", provider: "anthropic", timeoutMs: 0 }],
    },
  } as unknown as MyClawConfig;
  const report = await statusReport({ config: unbounded, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
  expect(report.text).toMatch(/request wall\s+none \(Stop only\)/);
  expect(report.status.model.timeout).toBe("none (Stop only)");
});

test("a model that does not resolve degrades the wall line instead of failing the report", async () => {
  // /status is the screen opened *because* something is broken: a throw here would hide every
  // other number the owner came for.
  const sessionId = "matrix/room/!brokenwall:test";
  const broken = {
    llm: { defaultModel: "ghost/model", providers: {}, models: [{ id: "ghost/model", provider: "nowhere" }] },
  } as unknown as MyClawConfig;
  const out = await handleStatusCommand({ config: broken, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });
  expect(out).toContain("request wall  unknown (model does not resolve)");
});

test("a sub-agent session reports its visibility and who spawned it", async () => {
  const id = "subagent/digger-bbbb";
  const out = await handleStatusCommand({
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

test("an active run is named", async () => {
  const id = "matrix/room/!running:test";
  const out = await handleStatusCommand({
    config,
    sessionId: id,
    session: session(id),
    liveRuns: [{ label: "digger", depth: 1, startedAt: Date.now() }, { label: "main", depth: 0, startedAt: Date.now() }],
  });
  expect(out).toContain("digger[1]");
  expect(out).toContain("main");
});

test("without a price table the tokens are still reported", async () => {
  const sessionId = "matrix/room/!noprice:test";
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "claude-opus-5", baseUrl: "https://api.anthropic.com",
    streaming: true, caller: "orchestrator", promptTokens: 1000, completionTokens: 10, totalTokens: 1010, toolCalls: 0, iteration: 1, durationMs: 5,
  });
  const out = await handleStatusCommand({ config, sessionId, session: session(sessionId), liveRuns: [] });
  expect(out).toContain("1 calls");
  expect(out).toContain("unpriced");
});

test("after a reset the previous call is not reported as filling the window", async () => {
  const sessionId = "matrix/room/!reset:test";
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "claude-opus-5", baseUrl: "https://api.anthropic.com",
    streaming: true, caller: "orchestrator", promptTokens: 10_000, completionTokens: 1, totalTokens: 10001, toolCalls: 0, iteration: 1, durationMs: 5,
  });
  // Analytics keeps the call; the session history does not. Showing it as a share of the window
  // would contradict the occupied line on the very next row.
  const out = await handleStatusCommand({
    config, sessionId, session: session(sessionId, { messages: [] }), liveRuns: [], pricing: pricing(),
  });
  expect(out).toContain("measured      no call recorded yet");
  expect(out).not.toMatch(/measured\s+10k/);
});

test("statusReport hands the payload over as `status`, the field the app channel reads", async () => {
  // The app channel's command output types `status` as optional, so a rename here is assignable
  // and only shows up in production as "status unavailable". Pin the field name.
  const sessionId = "matrix/room/!report:test";
  const report = await statusReport({ config, sessionId, session: session(sessionId), liveRuns: [] });

  expect(report.status.model.current).toBe("claude-opus-5");
  expect(report.text).toContain("claude-opus-5");
  expect("payload" in report).toBe(false);
});

test("the report text is the chat command's, character for character", async () => {
  const sessionId = "matrix/room/!parity:test";
  const data = session(sessionId);
  const report = await statusReport({ config, sessionId, session: data, liveRuns: [] });

  expect(report.text).toBe(await handleStatusCommand({ config, sessionId, session: data, liveRuns: [] }));
});

test("a tag reference is resolved to the model it runs, with the tag named", async () => {
  const tagged = {
    llm: {
      defaultModel: "claude-opus-5",
      models: [{ id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 } }],
      tags: { zsmart: { model: "claude-opus-5" } },
    },
  } as unknown as MyClawConfig;

  const sessionId = "matrix/room/!tagged:test";
  const withTag = session(sessionId, { modelOverride: "tag:zsmart" });
  const out = await handleStatusCommand({ config: tagged, sessionId, session: withTag, liveRuns: [] });
  // The page shows the model the API receives; the tag stays named so the chain is explainable.
  expect(out).toMatch(/current\s+claude-opus-5 \(tag zsmart\) \(session override\)/);
  expect(out).not.toContain("tag:zsmart");

  const report = await statusReport({ config: tagged, sessionId, session: withTag, liveRuns: [] });
  expect(report.status.model.current).toBe("claude-opus-5");
  expect(report.status.model.tag).toBe("zsmart");
});

// Criterion 8 of docs/model-resolution.md: the surfaces do not each keep their own idea of the
// current model. /status is the one that was already right; this pins it to the shared function so
// the two cannot drift apart again.
test("/status names the model the run would use, pin included, exactly like chatModel", async () => {
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
  const out = await handleStatusCommand({ config: pinned, sessionId, session: session(sessionId), liveRuns: [] });
  const expected = chatModel(pinned, undefined);
  expect(expected).toBe("kimi-k26-turbo");
  expect(out).toContain(expected);
  // The global default is not what runs, so the line must not name it.
  expect(out).not.toContain("claude-opus-5");

  // And a chat with its own pick reports that instead, on the same code path.
  const withPick = session(sessionId, { modelOverride: "claude-opus-5" });
  const picked = await handleStatusCommand({ config: pinned, sessionId, session: withPick, liveRuns: [] });
  expect(picked).toContain(chatModel(pinned, "claude-opus-5"));
});

test("the same history on the home loop keeps the estimate as a floor", async () => {
  const homeConfig = {
    llm: { defaultModel: "mimo", models: [{ id: "mimo", label: "Mimo", limit: { context: 1_000_000 } }] },
    context: { cap: 512_000 },
  } as unknown as MyClawConfig;
  const sessionId = "matrix/room/!home:test";
  // Occupancy now comes from the log, so we build a session with 400 messages to populate it
  const messages: LegacySessionData["messages"] = Array.from({ length: 400 }, (_, i) => ({
    role: "user" as const,
    content: "x".repeat(4000),
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
  }));
  const sess = session(sessionId, {
    messages,
    lastPrompt: { tokens: 79_552, messageCount: 400 },
  });
  await saveSessionWithLog(sessionId, sess);

  const { status } = await statusReport({ config: homeConfig, sessionId: sess.id, session: sess, liveRuns: [] });

  // Every one of those messages is resent on the next call, so the estimate is a lower bound.
  expect(status.context.occupied).toBe(status.context.estimated);
});

test("measured is present when lastPrompt exists", async () => {
  const sessionId = "matrix/room/!measured:test";
  const sess = session(sessionId, {
    lastPrompt: { tokens: 50_000, messageCount: 10 },
  });
  await saveSessionWithLog(sessionId, sess);

  const measureConfig = {
    llm: {
      defaultModel: "claude-opus-5",
      models: [{ id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 } }],
    },
  } as unknown as MyClawConfig;

  const { status } = await statusReport({
    config: measureConfig,
    sessionId: sess.id,
    session: sess,
    liveRuns: [],
  });

  expect(status.context.measured?.tokens).toBe(50_000);
});
