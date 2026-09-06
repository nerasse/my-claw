import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { LegacySessionData } from "../../src/sessions/store.ts";
import { recordApiCall } from "../../src/analytics/usage-db.ts";
import { ModelPricing, CACHE_VERSION } from "../../src/llm/pricing.ts";
import { statusReport } from "../../src/channels/status-command.ts";
import type { SubAgentMeta } from "../../src/sessions/store.ts";
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


type Params = Parameters<typeof statusReport>[0];

/** The report of one session, with the price table unless the test says otherwise. */
async function report(over: Partial<Params> & { sessionId: string }) {
  return (await statusReport({ config, liveRuns: [], pricing: pricing(), session: session(over.sessionId), ...over })).status;
}

function call(sessionId: string, over: Partial<Parameters<typeof recordApiCall>[0]> = {}): void {
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "my-claw-app", model: "claude-opus-5",
    baseUrl: "https://api.anthropic.com", streaming: true, caller: "orchestrator",
    promptTokens: 1000, completionTokens: 10, totalTokens: 1010, toolCalls: 0, iteration: 1, durationMs: 10,
    ...over,
  });
}

test("no session still reports the model and the live runs", async () => {
  const { text, status } = await statusReport({ config, sessionId: "matrix/room/!empty:test", session: null, liveRuns: [{ label: "main", depth: 0, startedAt: Date.now() }] });
  expect(status.session).toBeNull();
  expect(status.usage).toBeNull();
  expect(status.model.current).toBe("claude-opus-5");
  expect(status.runtime.runs.map((r) => r.label)).toEqual(["main"]);
  expect(text).toBe("Status: claude-opus-5 · no session yet · running: main");
});

test("the usage is one block: calls, tokens and money from analytics, no second counter beside it", async () => {
  // The session counter (`tokenUsage`) and the analytics used to be shown side by side, because a
  // Matrix room id carried two answers. A thread is the conversation: one set of figures.
  const sessionId = "my-claw-app/thread/o/twototals";
  for (let i = 0; i < 4; i++) call(sessionId, { promptTokens: 1_000_000, completionTokens: 1000, totalTokens: 1_001_000 });
  const status = await report({
    sessionId,
    session: session(sessionId, { tokenUsage: { promptTokens: 500, completionTokens: 10, totalTokens: 510, apiCalls: 1 } }),
  });
  expect(status.usage?.own.calls).toBe(4);
  expect(status.usage?.own.promptTokens).toBe(4_000_000);
  expect(status.usage?.own.durationMs).toBe(40);
  expect(status.usage?.total).toEqual(expect.objectContaining({ calls: 4, promptTokens: 4_000_000, completionTokens: 4000 }));
  expect(status.usage?.since).toBeUndefined();
  expect("conversation" in status).toBe(false);
  expect("analytics" in status).toBe(false);
});

test("a billed endpoint and a subscription are totalled apart, and the row says which it is", async () => {
  const sessionId = "my-claw-app/thread/o/mixed";
  call(sessionId, { model: "accounts/fireworks/routers/kimi-k2p6-turbo", baseUrl: "https://api.fireworks.ai/inference/v1", promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 });
  call(sessionId, { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 });
  const status = await report({ sessionId });
  expect(status.usage?.own.billedUsd).toBeCloseTo(2, 5);
  expect(status.usage?.own.referenceUsd).toBeCloseTo(5, 5);
  expect(status.usage?.own.unpriced).toBe(0);
  const byModel = Object.fromEntries((status.usage?.own.rows ?? []).map((r) => [r.model, r]));
  expect(byModel["claude-opus-5"]).toEqual(expect.objectContaining({ costUsd: 5, costBilled: false, costApproximate: false }));
  expect(byModel["accounts/fireworks/routers/kimi-k2p6-turbo"]).toEqual(expect.objectContaining({ costBilled: true }));
});

test("the sub-agents a conversation drove are rows of their own, named, with their models, and the total covers them", async () => {
  const parent = "my-claw-app/thread/o/parent";
  call("subagent/digger-aaaa", { parentSessionId: parent, caller: "subagent", promptTokens: 200_000, completionTokens: 100, totalTokens: 200_100 });
  call("subagent/digger-aaaa", { parentSessionId: parent, caller: "subagent", model: "accounts/fireworks/routers/kimi-k2p6-turbo", baseUrl: "https://api.fireworks.ai/inference/v1", promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000 });
  call("subagent/run-bbbb", { parentSessionId: parent, caller: "subagent", promptTokens: 50_000, completionTokens: 50, totalTokens: 50_050 });
  call(parent, { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 });
  const metas: Record<string, SubAgentMeta> = {
    "subagent/digger-aaaa": { displayName: "digger", type: "research", parentSessionId: parent, visibility: "global", createdAt: new Date().toISOString() },
  };
  const status = await report({
    sessionId: parent,
    liveRuns: [{ label: "main", depth: 0, startedAt: Date.now() }, { label: "digger", depth: 1, startedAt: Date.now() }],
    subAgentOf: async (id) => metas[id] ?? null,
  });
  const agents = status.usage?.agents ?? [];
  expect(agents.map((a) => a.sessionId).sort()).toEqual(["subagent/digger-aaaa", "subagent/run-bbbb"]);
  const digger = agents.find((a) => a.sessionId === "subagent/digger-aaaa")!;
  expect(digger).toEqual(expect.objectContaining({ displayName: "digger", type: "research", depth: 1, alive: true, running: true, calls: 2, promptTokens: 300_000 }));
  expect(digger.rows.map((r) => r.model).sort()).toEqual(["accounts/fireworks/routers/kimi-k2p6-turbo", "claude-opus-5"]);
  // A one-shot whose session is gone is still a row: named by its id, not openable, not running.
  const gone = agents.find((a) => a.sessionId === "subagent/run-bbbb")!;
  expect(gone).toEqual(expect.objectContaining({ displayName: "run-bbbb", alive: false, running: false, calls: 1 }));
  expect(gone.type).toBeUndefined();
  // The parent's own block holds the parent's calls alone; the total holds everything.
  expect(status.usage?.own.calls).toBe(1);
  expect(status.usage?.total.calls).toBe(4);
  expect(status.usage?.total.promptTokens).toBe(351_000);
  expect(status.usage?.total.billedUsd).toBeCloseTo(0.2, 5);
  expect(status.usage?.total.referenceUsd).toBeCloseTo(digger.referenceUsd + gone.referenceUsd + (status.usage?.own.referenceUsd ?? 0), 5);
});

test("a sub-agent's own sub-agents are billed to it, so the walk continues under it and the total reaches them", async () => {
  const parent = "my-claw-app/thread/o/grand";
  call("subagent/research-1", { parentSessionId: parent, caller: "subagent", promptTokens: 10_000, completionTokens: 0, totalTokens: 10_000 });
  call("subagent/coder-2", { parentSessionId: "subagent/research-1", caller: "subagent", promptTokens: 20_000, completionTokens: 0, totalTokens: 20_000 });
  const status = await report({ sessionId: parent, session: session(parent) });
  const agents = status.usage?.agents ?? [];
  expect(agents.map((a) => [a.sessionId, a.depth])).toEqual([["subagent/research-1", 1], ["subagent/coder-2", 2]]);
  expect(status.usage?.total.promptTokens).toBe(30_000);
  // The conversation itself made no call: the block still exists, for the agents.
  expect(status.usage?.own.calls).toBe(0);
  expect(status.usage?.own.rows).toEqual([]);
});

test("a conversation older than the analytics horizon says where its figures start", async () => {
  const sessionId = "my-claw-app/thread/o/old";
  call(sessionId);
  const status = await report({ sessionId, session: session(sessionId, { createdAt: new Date(Date.now() - 200 * 86_400_000).toISOString() }) });
  expect(status.usage?.since).toBeDefined();
  const since = Date.parse(status.usage!.since!);
  expect(Math.abs(Date.now() - 90 * 86_400_000 - since)).toBeLessThan(60_000);
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
  const status = await report({ sessionId, session: sess });
  // Share of the *effective* window: claude-opus-5 resolves to 1M and the default cap lowers it to
  // 512k, so a percentage computed against the raw window would read half as much.
  expect(status.context.measured).toEqual({ tokens: 12_345, pctOfLimit: expect.closeTo(2.41, 1) });
  // The three must not be conflated: the estimate is tiny here while the measurement is not.
  expect(status.context.estimated).toBeLessThan(1000);
  expect(status.context.occupied).toBeGreaterThanOrEqual(12_345);
});

test("the cap lowers the window and says what it lowered, so the number can be explained", async () => {
  const sessionId = "matrix/room/!capped:test";
  const status = await report({ sessionId });
  expect(status.model.contextLimit).toBe(512_000);
  expect(status.model.contextNotes).toEqual(["declared", "capped from 1,000,000"]);
});

test("a session that asked for the full window is not capped, and the override is named", async () => {
  const sessionId = "matrix/room/!full:test";
  const status = await report({ sessionId, session: session(sessionId, { contextOverride: "full" }) });
  expect(status.model.contextLimit).toBe(1_000_000);
  expect(status.model.contextNotes).toEqual(["declared", "session override: full"]);
  // The threshold has to follow the override, or the gate would still compact at the capped size.
  expect(status.context.autoCompactThresholdPct).toBe(80);
  expect(status.context.autoCompactThresholdTokens).toBe(800_000);
});

test("the request wall is reported with where the number comes from", async () => {
  // A run that died on a timeout has to be traceable to the declaration that set it: a number
  // without its provenance sends the owner editing the wrong one.
  const sessionId = "matrix/room/!wall:test";
  const plain = await report({ sessionId });
  expect(plain.model.timeout).toBe("120s (default)");

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
  const own = await report({ config: declared, sessionId });
  expect(own.model.timeout).toBe("900s (model)");

  const global = {
    llm: { defaultModel: "claude-opus-5", timeoutMs: 60_000, models: [{ id: "claude-opus-5", label: "Opus 5" }] },
  } as unknown as MyClawConfig;
  const inherited = await report({ config: global, sessionId });
  expect(inherited.model.timeout).toBe("60s (global)");
});

test("no wall at all is spelled out in the payload the app draws", async () => {
  const sessionId = "matrix/room/!nowall:test";
  const unbounded = {
    llm: {
      defaultProvider: "anthropic",
      providers: { anthropic: { type: "anthropic", group: "Claude" } },
      defaultModel: "claude-opus-5",
      models: [{ id: "claude-opus-5", label: "Opus 5", provider: "anthropic", timeoutMs: 0 }],
    },
  } as unknown as MyClawConfig;
  const status = await report({ config: unbounded, sessionId });
  expect(status.model.timeout).toBe("none (Stop only)");
});

test("a model that does not resolve degrades the wall line instead of failing the report", async () => {
  // /status is the screen opened *because* something is broken: a throw here would hide every
  // other number the owner came for.
  const sessionId = "matrix/room/!brokenwall:test";
  const broken = {
    llm: { defaultModel: "ghost/model", providers: {}, models: [{ id: "ghost/model", provider: "nowhere" }] },
  } as unknown as MyClawConfig;
  const status = await report({ config: broken, sessionId });
  expect(status.model.timeout).toBe("unknown (model does not resolve)");
});

test("a sub-agent session reports its visibility and who spawned it", async () => {
  const id = "subagent/digger-bbbb";
  const status = await report({
    sessionId: id,
    session: session(id, {
      meta: { displayName: "digger", type: "research", parentSessionId: "matrix/room/!boss:test", visibility: "private", createdAt: new Date().toISOString() },
    }),
  });
  expect(status.session?.subAgent).toEqual({ displayName: "digger", type: "research", visibility: "private", parentSessionId: "matrix/room/!boss:test" });
});

test("the live run tree and a compaction in progress travel as structure", async () => {
  const id = "matrix/room/!running:test";
  const started = Date.now();
  const { status, text } = await statusReport({
    config,
    sessionId: id,
    session: session(id),
    liveRuns: [{ label: "digger", depth: 1, startedAt: started }, { label: "main", depth: 0, startedAt: started }],
    compacting: true,
  });
  expect(status.runtime.runs).toEqual([
    { label: "digger", depth: 1, startedAt: new Date(started).toISOString() },
    { label: "main", depth: 0, startedAt: new Date(started).toISOString() },
  ]);
  expect(status.runtime.compacting).toBe(true);
  expect(text).toContain("running: digger, main");
  expect(text).toContain("compacting");
});

test("without a price table the tokens are still reported", async () => {
  const sessionId = "matrix/room/!noprice:test";
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "claude-opus-5", baseUrl: "https://api.anthropic.com",
    streaming: true, caller: "orchestrator", promptTokens: 1000, completionTokens: 10, totalTokens: 1010, toolCalls: 0, iteration: 1, durationMs: 5,
  });
  const status = await report({ sessionId, pricing: undefined });
  expect(status.usage?.own.calls).toBe(1);
  expect(status.usage?.own.unpriced).toBe(1);
  expect(status.usage?.own.rows[0]?.costUsd).toBeUndefined();
});

test("after a reset the previous call is not reported as filling the window", async () => {
  const sessionId = "matrix/room/!reset:test";
  recordApiCall({
    sessionId, parentSessionId: sessionId, platform: "matrix", model: "claude-opus-5", baseUrl: "https://api.anthropic.com",
    streaming: true, caller: "orchestrator", promptTokens: 10_000, completionTokens: 1, totalTokens: 10001, toolCalls: 0, iteration: 1, durationMs: 5,
  });
  // Analytics keeps the call; the session history does not. Showing it as a share of the window
  // would contradict the occupied line on the very next row.
  const status = await report({ sessionId, session: session(sessionId, { messages: [] }) });
  expect(status.context.measured).toBeUndefined();
});

test("statusReport hands the payload over as `status`, the field the app channel reads, and one line of text", async () => {
  // The app channel's command output types `status` as optional, so a rename here is assignable
  // and only shows up in production as "status unavailable". Pin the field name.
  const sessionId = "my-claw-app/thread/o/report";
  call(sessionId);
  const out = await statusReport({ config, sessionId, session: session(sessionId), liveRuns: [], pricing: pricing() });

  expect(out.status.model.current).toBe("claude-opus-5");
  expect("payload" in out).toBe(false);
  // The page is the report; the text is the one line a chat bubble would show.
  expect(out.text).toMatch(/^Status: claude-opus-5 · context \d+\.\d% · 1 calls · <\$0\.01$/);
  expect(out.text.split("\n")).toHaveLength(1);
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
  const { status, text } = await statusReport({ config: tagged, sessionId, session: withTag, liveRuns: [] });
  // The page shows the model the API receives; the tag stays named so the chain is explainable.
  expect(status.model.current).toBe("claude-opus-5");
  expect(status.model.tag).toBe("zsmart");
  expect(status.model.configDefault).toBe("claude-opus-5");
  expect(text).toContain("claude-opus-5 (tag zsmart)");
  expect(text).not.toContain("tag:zsmart");
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
  const status = await report({ config: pinned, sessionId, pricing: undefined });
  const expected = chatModel(pinned, undefined);
  expect(expected).toBe("kimi-k26-turbo");
  expect(status.model.current).toBe(expected);
  // The global default is not what runs, so the report must not name it.
  expect(status.model.configDefault).toBeUndefined();

  // And a chat with its own pick reports that instead, on the same code path.
  const withPick = session(sessionId, { modelOverride: "claude-opus-5" });
  const picked = await report({ config: pinned, sessionId, session: withPick, pricing: undefined });
  expect(picked.model.current).toBe(chatModel(pinned, "claude-opus-5"));
  expect(picked.model.configDefault).toBe("kimi-k26-turbo");
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
