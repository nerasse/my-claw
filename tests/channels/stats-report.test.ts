import { test, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import { analyticsDb, recordApiCall } from "../../src/analytics/usage-db.ts";
import { foldBefore } from "../helpers/analytics-fold.ts";
import { archiveChannelMessage } from "../../src/conversations/store.ts";
import { ModelPricing, CACHE_VERSION, setSharedPricing } from "../../src/llm/pricing.ts";
import { statsReport } from "../../src/channels/stats-command.ts";
import type { StatsFilter } from "../../src/analytics/usage-stats.ts";
import { refreshOpenRouterAccount } from "../../src/llm/openrouter-account.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import type { MyClawAppStatsPayload, MyClawAppStatsPeriod } from "../../src/channels/my-claw-app/types.ts";

/**
 * The install-wide statistics payload: what the page is handed, and what it is allowed to say.
 *
 * Every figure here is about the install rather than about a conversation, which is the whole
 * reason this screen exists apart from `/status`. The provider ledger is mocked throughout: it
 * comes from a third party, and a test that reached it would report a different number every day
 * and none at all offline.
 */

const KEY_ENV = "TEST_STATS_OR_KEY";

function pricing(kimi = 4): ModelPricing {
  mkdirSync(MY_CLAW_DIR, { recursive: true });
  writeFileSync(
    join(MY_CLAW_DIR, "model-pricing.json"),
    JSON.stringify({
      version: CACHE_VERSION,
      fetchedAt: new Date().toISOString(),
      hosts: { openrouter: "https://openrouter.ai/api/v1" },
      models: {
        openrouter: { "glm-5.2": { cost: { input: 1, output: 2 }, id: "glm-5.2" }, "kimi-k3": { cost: { input: kimi, output: 8 }, id: "kimi-k3" } },
      },
    }),
  );
  return new ModelPricing(() => ({}), () => []);
}

const config = {
  llm: {
    defaultModel: "claude-opus-5",
    models: [{ id: "claude-opus-5", label: "Opus 5", limit: { context: 1_000_000 } }],
    providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: KEY_ENV } },
  },
} as unknown as MyClawConfig;

/** The same config with no credential to read: there is nothing to reconcile against. */
const keyless = { llm: { ...config.llm, providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } } } } as unknown as MyClawConfig;

beforeEach(() => {
  const db = new Database(join(MY_CLAW_DIR, "analytics.db"));
  try {
    db.run("DELETE FROM api_calls");
    db.run("DELETE FROM usage_monthly");
  } catch {
    // Nothing has recorded a call yet, so neither table exists.
  } finally {
    db.close();
  }
  const archive = new Database(join(MY_CLAW_DIR, "conversations.db"));
  try {
    archive.run("DELETE FROM messages");
  } catch {
    // Nothing archived yet.
  } finally {
    archive.close();
  }
  setSharedPricing(null);
});

interface CallOver {
  at?: string;
  sessionId?: string;
  parentSessionId?: string;
  model?: string;
  baseUrl?: string;
  providerKey?: string;
  caller?: "orchestrator" | "subagent" | "browser";
  workspace?: string;
  folderId?: string;
  error?: string;
  promptTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function call(over: CallOver = {}): void {
  const sessionId = over.sessionId ?? "my-claw-app/thread/o/one";
  recordApiCall({
    sessionId,
    parentSessionId: over.parentSessionId ?? sessionId,
    platform: "my-claw-app",
    model: over.model ?? "glm-5.2",
    baseUrl: over.baseUrl ?? "https://openrouter.ai/api/v1",
    ...(over.providerKey === undefined ? {} : { providerKey: over.providerKey }),
    streaming: true,
    caller: over.caller ?? "orchestrator",
    ...(over.workspace === undefined ? {} : { workspace: over.workspace }),
    ...(over.folderId === undefined ? {} : { folderId: over.folderId }),
    promptTokens: over.promptTokens ?? 1_000_000,
    completionTokens: 0,
    totalTokens: over.promptTokens ?? 1_000_000,
    cacheReadTokens: over.cacheReadTokens ?? 0,
    cacheWriteTokens: over.cacheWriteTokens ?? 0,
    toolCalls: 0,
    iteration: 1,
    durationMs: 100,
    ...(over.error === undefined ? {} : { error: over.error }),
  });
  if (over.at) analyticsDb().run("UPDATE api_calls SET timestamp = ? WHERE id = last_insert_rowid()", [over.at]);
}

/** Sessions the store still holds, by id: everything else reads as deleted, which is the point. */
function report(
  live: Record<string, { title?: string }> = {},
  over: { period?: MyClawAppStatsPeriod; config?: MyClawConfig; kimi?: number; filter?: StatsFilter; folders?: Array<{ id: string; name: string }> } = {},
): Promise<MyClawAppStatsPayload> {
  return statsReport({
    config: over.config ?? config,
    period: over.period ?? "all",
    filter: over.filter ?? {},
    pricing: pricing(over.kimi),
    sessionInfo: async (sessionId) => live[sessionId],
    folders: over.folders ?? [{ id: "folder-career", name: "career" }],
  });
}

/** `/key` and `/credits`, as the live routes answer them. */
function accountMock(usage: number, credits: { total: number; used: number } | null = { total: 20, used: 12.5 }) {
  return mockFetch(async (input) =>
    String(input).endsWith("/key")
      ? new Response(JSON.stringify({ data: { label: "sk-or-v1-...", limit: null, limit_remaining: null, usage, is_free_tier: false } }), { status: 200 })
      : credits === null
        ? new Response("{}", { status: 403 })
        : new Response(JSON.stringify({ data: { total_credits: credits.total, total_usage: credits.used } }), { status: 200 }),
  );
}

async function warmed(usage: number, credits?: { total: number; used: number } | null): Promise<void> {
  const mock = accountMock(usage, credits === undefined ? { total: 20, used: 12.5 } : credits);
  try {
    process.env[KEY_ENV] = "sk-or-test";
    await refreshOpenRouterAccount("sk-or-test");
  } finally {
    mock.restore();
  }
}

test("the totals are the calls, the tokens, the money and the API time of the whole install", async () => {
  call({ sessionId: "a", promptTokens: 1_000_000 });
  call({ sessionId: "b", promptTokens: 2_000_000, error: "HTTP 500" });
  const stats = await report();
  expect(stats.totals.calls).toBe(2);
  expect(stats.totals.errors).toBe(1);
  expect(stats.totals.promptTokens).toBe(3_000_000);
  expect(stats.totals.durationMs).toBe(200);
  expect(stats.totals.billedUsd).toBeCloseTo(3, 6);
  expect(stats.totals.unpriced).toBe(0);
});

test("the rows add up to the totals, view by view", async () => {
  call({ sessionId: "a", model: "glm-5.2" });
  call({ sessionId: "b", model: "kimi-k3", caller: "subagent" });
  call({ sessionId: "b", model: "glm-5.2", baseUrl: "https://api.anthropic.com", caller: "browser" });
  const stats = await report();
  const sum = (rows: Array<{ calls: number }>): number => rows.reduce((n, r) => n + r.calls, 0);
  expect(sum(stats.models)).toBe(stats.totals.calls);
  expect(sum(stats.providers)).toBe(stats.totals.calls);
  expect(sum(stats.sessions)).toBe(stats.totals.calls);
  expect(sum(stats.daily)).toBe(stats.totals.calls);
  expect(sum(stats.callers)).toBe(stats.totals.calls);
  expect(stats.callers.map((c) => c.caller).sort()).toEqual(["browser", "orchestrator", "subagent"]);
});

test("the models and the providers are ranked by what they cost, not by what they were called", async () => {
  // One cheap call, many times; one expensive call, once.
  for (let i = 0; i < 5; i++) call({ model: "glm-5.2", promptTokens: 100_000 });
  call({ model: "kimi-k3", promptTokens: 1_000_000 });
  const stats = await report();
  expect(stats.models[0]!.model).toBe("kimi-k3");
  expect(stats.models[0]!.calls).toBe(1);
  expect(stats.models[1]!.calls).toBe(5);
});

test("a provider folds every model it served, and the host is the label when no endpoint is pinned", async () => {
  call({ model: "glm-5.2", baseUrl: "https://openrouter.ai/api/v1" });
  call({ model: "kimi-k3", baseUrl: "https://openrouter.ai/api/v1" });
  call({ model: "claude-opus-5", baseUrl: "https://api.anthropic.com" });
  const stats = await report();
  const openrouter = stats.providers.find((p) => p.provider === "openrouter.ai")!;
  expect(openrouter.calls).toBe(2);
  expect(stats.providers.map((p) => p.provider).sort()).toEqual(["api.anthropic.com", "openrouter.ai"]);
});

/**
 * 189 of this install's 315 recorded sessions no longer exist on disk, and their calls are intact.
 * A ranking that dropped them would not add up to the total printed above it.
 */
test("a deleted session keeps its spend and is labelled from its opening message", async () => {
  call({ sessionId: "my-claw-app/thread/o/gone" });
  archiveChannelMessage({
    id: "m1",
    platform: "my-claw-app",
    userId: "o",
    chatId: "o",
    chatType: "dm",
    text: "  rewrite   the   deploy script  ",
    timestamp: new Date().toISOString(),
    attachments: [],
    isForwarded: false,
    threadId: "gone",
    sessionScope: "per-user",
    raw: {},
  });

  const row = (await report()).sessions[0]!;
  expect(row.sessionId).toBe("my-claw-app/thread/o/gone");
  expect(row.deleted).toBe(true);
  expect(row.label).toBe("rewrite the deploy script");
  expect(row.labelSource).toBe("first-message");
  expect(row.calls).toBe(1);
});

test("a session that still exists takes its own title, and is not marked deleted", async () => {
  call({ sessionId: "my-claw-app/thread/o/alive" });
  const row = (await report({ "my-claw-app/thread/o/alive": { title: "The deploy thread" } })).sessions[0]!;
  expect(row.label).toBe("The deploy thread");
  expect(row.labelSource).toBe("title");
  expect(row.deleted).toBe(false);
});

test("nothing archived and no title leaves the id standing rather than an invented label", async () => {
  call({ sessionId: "subagent/digger-7" });
  const row = (await report()).sessions[0]!;
  expect(row.label).toBe("subagent/digger-7");
  expect(row.labelSource).toBe("id");
  expect(row.deleted).toBe(true);
});

test("a live conversation the owner never renamed is labelled from the archive, and is not deleted", async () => {
  call({ sessionId: "my-claw-app/thread/o/untitled" });
  archiveChannelMessage({
    id: "m2",
    platform: "my-claw-app",
    userId: "o",
    chatId: "o",
    chatType: "dm",
    text: "what does this stack trace mean",
    timestamp: new Date().toISOString(),
    attachments: [],
    isForwarded: false,
    threadId: "untitled",
    sessionScope: "per-user",
    raw: {},
  });
  const row = (await report({ "my-claw-app/thread/o/untitled": {} })).sessions[0]!;
  expect(row.label).toBe("what does this stack trace mean");
  expect(row.labelSource).toBe("first-message");
  expect(row.deleted).toBe(false);
});

/**
 * Two horizons on one payload, because the page must be able to say "detail since June, totals
 * since always". A screen that shows one figure for both is lying about one of them.
 */
test("the payload carries where the detail starts and where the totals start, apart", async () => {
  call({ at: "2026-01-05T10:00:00.000Z", sessionId: "old" });
  call({ at: "2026-09-01T10:00:00.000Z", sessionId: "recent" });
  foldBefore("2026-04-01T00:00:00.000Z");

  const stats = await report();
  expect(stats.detailSince).toBe("2026-09-01T10:00:00.000Z");
  expect(stats.totalsSince).toBe("2026-01");
  expect(stats.rollupIncluded).toBe(true);
  // The totals cross the wall; the per-session ranking stops at the detail.
  expect(stats.totals.calls).toBe(2);
  expect(stats.sessions.map((s) => s.sessionId)).toEqual(["recent"]);
  expect(stats.daily).toHaveLength(1);
});

test("a bounded period never claims to include the rollup, even when one exists", async () => {
  call({ at: "2026-01-05T10:00:00.000Z" });
  foldBefore("2026-04-01T00:00:00.000Z");
  call();
  const stats = await report({}, { period: "30d" });
  expect(stats.period).toBe("30d");
  expect(stats.rollupIncluded).toBe(false);
  expect(stats.totals.calls).toBe(1);
  // The horizon is still reported: the page needs it to explain what the window cannot reach.
  expect(stats.totalsSince).toBe("2026-01");
});

/**
 * A provider raising its tariff must not restate a year of spend. The money frozen on a row when it
 * was recorded is the money the page shows, whatever the table says today.
 */
test("frozen money stays frozen, and a group that was never priced is priced live", async () => {
  setSharedPricing(pricing(4));
  call({ model: "kimi-k3" });
  setSharedPricing(null);
  call({ model: "glm-5.2" });

  // The tariff has moved tenfold since. The frozen row must not move with it.
  const stats = await report({}, { kimi: 40 });
  expect(stats.totals.billedUsd).toBeCloseTo(5, 6);
  expect(stats.totals.unpriced).toBe(0);
});

/**
 * The day the cost columns shipped, one model on one endpoint held both kinds of call. Summing the
 * frozen half and then adding a live estimate over the whole group's tokens counts those calls
 * twice, so a half-frozen group is priced live and its partial sum is dropped.
 */
test("a group that is only half frozen is priced live, not frozen plus live", async () => {
  setSharedPricing(pricing());
  call({ model: "glm-5.2", promptTokens: 1_000_000 });
  setSharedPricing(null);
  call({ model: "glm-5.2", promptTokens: 1_000_000 });

  // One group, two million input tokens at one dollar a million. Three dollars would be the frozen
  // half added to an estimate that already covers it.
  const stats = await report();
  expect(stats.models).toHaveLength(1);
  expect(stats.totals.billedUsd).toBeCloseTo(2, 6);
});

test("a group nothing can price keeps its calls and reports no money, and says how many", async () => {
  call({ model: "a-model-no-table-knows", baseUrl: "https://unknown.example.com" });
  const stats = await report();
  expect(stats.totals.calls).toBe(1);
  expect(stats.totals.billedUsd).toBe(0);
  expect(stats.totals.referenceUsd).toBe(0);
  expect(stats.totals.unpriced).toBe(1);
});

/**
 * A rolled-up month is settled. The purge priced whatever the rows did not carry, in the last
 * moment they existed, and wrote it into `reference_usd`. Re-reading it through today's table would
 * restate a closed month every time a provider moves a price, which is the thing the whole frozen
 * scheme exists to prevent.
 */
test("a rolled-up month is settled: a later tariff change does not restate it", async () => {
  call({ at: "2026-01-05T10:00:00.000Z", model: "kimi-k3", promptTokens: 1_000_000 });

  // Alive, the row carries no frozen cost, so the page prices it with the table of the moment and
  // a tariff change moves it. Closing a month is what settles that exposure.
  expect((await report({}, { kimi: 40 })).totals.billedUsd).toBeCloseTo(40, 6);

  // The month closes with the cost the row carried then: kimi at four dollars a million input, in
  // reference because a rate nobody stated is not a charge.
  analyticsDb().run("UPDATE api_calls SET cost_usd = 4, cost_billed = 0, cost_source = 'test' WHERE timestamp = ?", [
    "2026-01-05T10:00:00.000Z",
  ]);
  foldBefore("2026-04-01T00:00:00.000Z");

  // Tenfold since, and the closed month does not move: four dollars, and in reference still.
  const stats = await report({}, { kimi: 40 });
  expect(stats.totals.referenceUsd).toBeCloseTo(4, 6);
  expect(stats.totals.billedUsd).toBe(0);
  expect(stats.totals.unpriced).toBe(0);
  expect(stats.totals.calls).toBe(1);
});

/**
 * A month closed with no price stays closed with no price.
 *
 * A boot with no price table in hand used to fold those calls up as unpriced, and a month closed that
 * way stays closed: reading it through a table that arrived afterwards would put money on a settled
 * month from tokens alone. Settled is settled; `unpriced` is the page saying so.
 */
test("a month rolled up without a price table is not re-priced by one that arrives later", async () => {
  call({ at: "2026-01-05T10:00:00.000Z", model: "kimi-k3", promptTokens: 1_000_000 });
  // No table published: this is the first boot of a fresh install, and the purge still runs.
  foldBefore("2026-04-01T00:00:00.000Z");

  // The table is there now, and it knows this model perfectly well. The closed month is not its
  // business.
  const stats = await report({}, { kimi: 40 });
  expect(stats.totals.calls).toBe(1);
  expect(stats.totals.unpriced).toBe(1);
  expect(stats.totals.billedUsd).toBe(0);
  expect(stats.totals.referenceUsd).toBe(0);
});

test("a call the ladder could not price even at the purge is still counted, and still costs nothing", async () => {
  call({ at: "2026-01-05T10:00:00.000Z", model: "a-model-no-table-knows", baseUrl: "https://unknown.example.test" });
  setSharedPricing(pricing());
  try {
    foldBefore("2026-04-01T00:00:00.000Z");
  } finally {
    setSharedPricing(null);
  }

  const stats = await report();
  expect(stats.totals.calls).toBe(1);
  expect(stats.totals.unpriced).toBe(1);
  expect(stats.totals.billedUsd).toBe(0);
  expect(stats.totals.referenceUsd).toBe(0);
});

test("the rolled-up money is added to the live money, and the calls are counted once", async () => {
  setSharedPricing(pricing());
  call({ at: "2026-01-05T10:00:00.000Z" });
  call({ at: "2026-09-01T10:00:00.000Z" });
  setSharedPricing(null);
  const before = await report();
  foldBefore("2026-04-01T00:00:00.000Z");
  const after = await report();

  expect(after.totals.calls).toBe(before.totals.calls);
  expect(after.totals.billedUsd).toBeCloseTo(before.totals.billedUsd, 6);
  expect(after.totals.promptTokens).toBe(before.totals.promptTokens);
});

test("reliability reports the error rate and the mean latency, per model and per host", async () => {
  call({ model: "flaky", baseUrl: "https://flaky.example.com", error: "HTTP 500" });
  call({ model: "flaky", baseUrl: "https://flaky.example.com" });
  call({ model: "glm-5.2" });

  const stats = await report();
  const byModel = stats.reliability.filter((r) => r.kind === "model");
  const byProvider = stats.reliability.filter((r) => r.kind === "provider");
  expect(byModel.find((r) => r.key === "flaky")).toMatchObject({ calls: 2, errors: 1, errorRatePct: 50, avgDurationMs: 100 });
  expect(byModel.find((r) => r.key === "glm-5.2")!.errorRatePct).toBe(0);
  expect(byProvider.find((r) => r.key === "flaky.example.com")!.errorRatePct).toBe(50);
  // Worst first, so the page leads with the route that is failing.
  expect(byModel[0]!.key).toBe("flaky");
});

test("the cache shares are read against the prompt tokens they are a part of", async () => {
  call({ promptTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 100 });
  const stats = await report();
  expect(stats.cache.promptTokens).toBe(1000);
  expect(stats.cache.readSharePct).toBeCloseTo(80, 6);
  expect(stats.cache.writeSharePct).toBeCloseTo(10, 6);
});

test("no traffic at all is zeroes and empty lists, never a division by nothing", async () => {
  const stats = await report();
  expect(stats.totals.calls).toBe(0);
  expect(stats.cache.readSharePct).toBe(0);
  expect(stats.cache.writeSharePct).toBe(0);
  expect(stats.models).toEqual([]);
  expect(stats.sessions).toEqual([]);
  expect(stats.detailSince).toBeUndefined();
  expect(stats.rollupIncluded).toBe(false);
});

test("the reconciliation puts the provider's ledger beside ours, with the balance when there is one", async () => {
  call({ sessionId: "a" });
  call({ sessionId: "b" });
  try {
    await warmed(12.5);
    const [r] = (await report()).reconciliation;
    expect(r!.provider).toBe("openrouter.ai");
    // Two conversations, one dollar of input each: the key is billed, not the chat, so both count.
    expect(r!.recordedUsd).toBeCloseTo(2, 6);
    expect(r!.calls).toBe(2);
    expect(r!.providerUsd).toBe(12.5);
    expect(r!.deltaUsd).toBeCloseTo(10.5, 6);
    expect(r!.balanceUsd).toBeCloseTo(7.5, 6);
    expect(r!.providerUnread).toBe(false);
  } finally {
    delete process.env[KEY_ENV];
  }
});

test("the provider is unreachable: the entry stays, carrying our sum alone and saying so", async () => {
  call();
  const mock = mockFetch(async () => new Response("{}", { status: 403 }));
  try {
    process.env[KEY_ENV] = "sk-or-test";
    // The failure is cached, so the report reads it instead of starting a second attempt.
    await refreshOpenRouterAccount("sk-or-test");
    const [r] = (await report()).reconciliation;
    expect(r!.providerUnread).toBe(true);
    expect(r!.recordedUsd).toBeCloseTo(1, 6);
    // Half a comparison is not a comparison: no figure of theirs, no gap, no balance.
    expect(r!.providerUsd).toBeUndefined();
    expect(r!.deltaUsd).toBeUndefined();
    expect(r!.balanceUsd).toBeUndefined();
  } finally {
    delete process.env[KEY_ENV];
    mock.restore();
  }
});

test("no key to read: no entry at all, rather than one number wearing the label of a comparison", async () => {
  call();
  expect((await report({}, { config: keyless })).reconciliation).toEqual([]);
});

test("a host that merely mentions openrouter.ai in its path is not OpenRouter", async () => {
  call({ baseUrl: "https://proxy.example.com/openrouter.ai/v1" });
  call();
  try {
    await warmed(12.5);
    const [r] = (await report()).reconciliation;
    expect(r!.calls).toBe(1);
    expect(r!.recordedUsd).toBeCloseTo(1, 6);
  } finally {
    delete process.env[KEY_ENV];
  }
});

test("the page never waits on the provider: a call still in flight leaves the entry unread", async () => {
  call();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = mockFetch(async (input) => {
    await gate;
    return new Response(JSON.stringify(String(input).endsWith("/key") ? { data: { usage: 12.5 } } : { data: { total_credits: 20, total_usage: 12.5 } }), { status: 200 });
  });
  try {
    process.env[KEY_ENV] = "sk-or-test";
    const pending = refreshOpenRouterAccount("sk-or-test");
    const [r] = (await report()).reconciliation;
    expect(r!.providerUnread).toBe(true);
    expect(r!.recordedUsd).toBeCloseTo(1, 6);
    release?.();
    await pending;
  } finally {
    delete process.env[KEY_ENV];
    mock.restore();
  }
});

/**
 * The live `/key` answer carries a label and the key's limits. None of it is read, so none of it
 * can reach a payload, a log line that quotes one, or a screen.
 */
test("nothing that identifies the key, and no path of this machine, reaches the payload", async () => {
  call({ sessionId: "my-claw-app/thread/o/secret" });
  const mock = mockFetch(async (input) =>
    String(input).endsWith("/key")
      ? new Response(JSON.stringify({ data: { label: "sk-or-v1-0123456789abcdef", limit: 50, limit_remaining: 37.5, usage: 12.5, is_free_tier: false } }), { status: 200 })
      : new Response(JSON.stringify({ data: { total_credits: 20, total_usage: 12.5 } }), { status: 200 }),
  );
  try {
    process.env[KEY_ENV] = "sk-or-test";
    await refreshOpenRouterAccount("sk-or-test");
    const stats = await report();
    const serialised = JSON.stringify(stats);
    for (const secret of ["sk-or", "0123456789abcdef", "limit_remaining", "is_free_tier", KEY_ENV, MY_CLAW_DIR, "/home/", "analytics.db"]) {
      expect(serialised).not.toContain(secret);
    }
    // The figures that are on purpose are still there.
    expect(stats.reconciliation[0]!.balanceUsd).toBeCloseTo(7.5, 6);
  } finally {
    delete process.env[KEY_ENV];
    mock.restore();
  }
});

/**
 * A filter is applied where the rows are, so it narrows every view at once and the totals are
 * recomputed over what is left rather than scaled down from what was folded. That is the whole
 * promise: a filtered page whose hero did not match the rows under it would be worse than no
 * filter at all.
 */
test("a filter narrows every view at once, and the totals are of the smaller population", async () => {
  call({ sessionId: "a", model: "glm-5.2", promptTokens: 1_000_000, caller: "orchestrator" });
  call({ sessionId: "b", model: "glm-5.2", promptTokens: 1_000_000, caller: "subagent" });
  call({ sessionId: "b", model: "kimi-k3", promptTokens: 2_000_000, caller: "subagent" });

  const all = await report();
  expect(all.totals.calls).toBe(3);

  const sub = await report({}, { filter: { caller: "subagent" } });
  expect(sub.totals.calls).toBe(2);
  expect(sub.totals.promptTokens).toBe(3_000_000);
  expect(sub.callers.map((c) => c.caller)).toEqual(["subagent"]);

  const sum = (rows: Array<{ calls: number }>): number => rows.reduce((n, r) => n + r.calls, 0);
  expect(sum(sub.models)).toBe(2);
  expect(sum(sub.providers)).toBe(2);
  expect(sum(sub.sessions)).toBe(2);
  expect(sum(sub.daily)).toBe(2);
  expect(sum(sub.callers)).toBe(2);
});

/**
 * The facets are the window's values, not the answer's. An option list built from a filtered
 * report would keep the choice already made and drop every alternative, which is a filter nobody
 * can undo -- so the list is computed by a pass that ignores the filter on screen.
 */
test("the filter is echoed, and the facets ignore it so the choice can be undone", async () => {
  call({ sessionId: "one", model: "glm-5.2", baseUrl: "https://openrouter.ai/api/v1", providerKey: "openrouter" });
  call({ sessionId: "two", model: "kimi-k3", baseUrl: "https://api.anthropic.com", caller: "subagent" });

  const narrowed = await report({}, { filter: { model: "glm-5.2" } });
  expect(narrowed.filter).toEqual({ model: "glm-5.2" });
  expect(narrowed.models.map((m) => m.model)).toEqual(["glm-5.2"]);
  expect(narrowed.totals.calls).toBe(1);

  expect(narrowed.facets.models).toEqual(["glm-5.2", "kimi-k3"]);
  // The configured providers, by key: a call nobody could place is a value too, so it can be found.
  expect(narrowed.facets.providers).toEqual(["(unknown)", "openrouter"]);
  expect(narrowed.facets.providerLabels).toEqual({ "(unknown)": "(unknown)", openrouter: "openrouter" });
  expect(narrowed.facets.callers).toEqual(["orchestrator", "subagent"]);
  expect(narrowed.facets.sessions.map((s) => s.sessionId).sort()).toEqual(["one", "two"]);
  expect(narrowed.facets.sessions.every((s) => s.deleted)).toBe(true);
});

/** Unfiltered, the option lists come from the rows the report is already made of: no extra pass. */
test("an unfiltered report carries the facets of its own rows", async () => {
  call({ sessionId: "one", model: "glm-5.2" });
  const stats = await report();
  expect(stats.filter).toEqual({});
  expect(stats.facets.models).toEqual(["glm-5.2"]);
  expect(stats.facets.sessions.map((s) => s.sessionId)).toEqual(["one"]);
});

/**
 * The rollup key has no session on it and no per-call row behind it, so a session filter cannot be
 * asked of the swept months. The flag goes false rather than the months being added untouched: the
 * page's horizon note reads off it, and a note promising history the answer left out is the lie
 * this page was built to stop telling.
 */
test("a filter a month cannot answer turns the horizon off rather than claiming it", async () => {
  call({ at: "2026-01-05T10:00:00.000Z", sessionId: "old" });
  call({ sessionId: "new" });
  foldBefore("2026-04-01T00:00:00.000Z");

  const all = await report();
  expect(all.rollupIncluded).toBe(true);

  // A model is a column of the rollup, so the months come with the window.
  const byModel = await report({}, { filter: { model: "glm-5.2" } });
  expect(byModel.rollupIncluded).toBe(true);
  expect(byModel.totals.calls).toBe(2);

  // A session is not, so the months are dropped and the page stops claiming them.
  const bySession = await report({}, { filter: { sessionId: "new" } });
  expect(bySession.rollupIncluded).toBe(false);
  expect(bySession.totals.calls).toBe(1);
});

/**
 * The two filing dimensions, recorded at call time so a workspace switch or a re-filed
 * conversation keeps its past where it was. The owner, 2026-09-22: "il faut traquer les requetes
 * depuis quel workspace" and "un filtre par dossier [...] un snapshot par appel".
 */
test("the workspace and the folder ride on the row, and both narrow the report", async () => {
  call({ sessionId: "a", workspace: "dev", folderId: "folder-career" });
  call({ sessionId: "b", workspace: "career", folderId: "folder-career", promptTokens: 5 });
  call({ sessionId: "c", workspace: "dev", promptTokens: 7 });

  const byWorkspace = await report({}, { filter: { workspace: "dev" } });
  expect(byWorkspace.totals.calls).toBe(2);
  expect(byWorkspace.sessions.map((r) => r.sessionId).sort()).toEqual(["a", "c"]);

  const byFolder = await report({}, { filter: { folderId: "folder-career" } });
  expect(byFolder.totals.calls).toBe(2);
  expect(byFolder.sessions.map((r) => r.sessionId).sort()).toEqual(["a", "b"]);
});

test("the sentinels select what no workspace and no folder hold", async () => {
  // No columns at all: the shape of every row written before the tracking existed.
  call({ sessionId: "old" });
  call({ sessionId: "unfiled", workspace: "dev" });

  const unknown = await report({}, { filter: { workspace: "(unknown)" } });
  expect(unknown.totals.calls).toBe(1);
  expect(unknown.sessions.map((r) => r.sessionId)).toEqual(["old"]);

  const noFolder = await report({}, { filter: { folderId: "(none)" } });
  expect(noFolder.totals.calls).toBe(2);
});

test("a workspace or folder filter drops the monthly rollup, and says so", async () => {
  call({ at: "2026-01-05T10:00:00.000Z", sessionId: "old" });
  foldBefore("2026-04-01T00:00:00.000Z");
  call({ workspace: "dev", folderId: "folder-career" });

  // Unfiltered, the totals reach behind the wall through the rollup.
  const all = await report();
  expect(all.rollupIncluded).toBe(true);

  // The rollup key has no workspace and no folder in it: a filter on one of them cannot be asked
  // of a folded month, so the month is dropped and the page stops claiming the horizon.
  for (const filter of [{ workspace: "dev" }, { folderId: "folder-career" }] as StatsFilter[]) {
    const narrowed = await report({}, { filter });
    expect(narrowed.rollupIncluded).toBe(false);
    expect(narrowed.totals.calls).toBe(1);
    expect(narrowed.totalsSince).toBe("2026-01");
  }
});

test("a delegated run is flagged, so the page files it under delegated runs", async () => {
  call({ sessionId: "chat" });
  call({ sessionId: "subagent/run-1", parentSessionId: "chat", caller: "subagent" });

  const stats = await report();
  const own = stats.sessions.find((r) => r.sessionId === "chat");
  const worker = stats.sessions.find((r) => r.sessionId === "subagent/run-1");
  expect(own?.delegated).toBe(false);
  expect(worker?.delegated).toBe(true);
});

test("the facets name the workspaces and the folders of the window", async () => {
  call({ sessionId: "a", workspace: "dev", folderId: "folder-career" });
  call({ sessionId: "b" });

  const stats = await report({}, { folders: [{ id: "folder-career", name: "career" }, { id: "gone", name: "old name" }] });
  expect(stats.facets.workspaces).toEqual(["(unknown)", "dev"]);
  // Named from the channel's store; the "(none)" calls need no name, and a folder the store no
  // longer holds says so rather than showing a bare uuid.
  expect(stats.facets.folders).toEqual([
    { folderId: "(none)", label: "(none)" },
    { folderId: "folder-career", label: "career" },
  ]);
});

/**
 * Two accounts of one service are two bills (owner, 2026-10-05: "si je colle lui, c'est lui"). The
 * address is the same for both, so the provider key on each row is the only thing that tells them
 * apart, from the ranking down to the provider's own ledger.
 */
const twoAccounts = {
  llm: {
    ...config.llm,
    providers: {
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: KEY_ENV, group: "OpenRouter perso" },
      work: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: `${KEY_ENV}_WORK`, group: "OpenRouter boulot" },
    },
  },
} as unknown as MyClawConfig;

test("two accounts on one address: each spends under its own name, and each ledger meets its own calls", async () => {
  call({ sessionId: "a", providerKey: "openrouter" });
  call({ sessionId: "b", providerKey: "work" });
  call({ sessionId: "c", providerKey: "work" });
  const mock = mockFetch(async (input, init) => {
    const perso = new Headers(init?.headers).get("Authorization") === "Bearer sk-or-perso";
    return String(input).endsWith("/key")
      ? new Response(JSON.stringify({ data: { usage: perso ? 1.5 : 4 } }), { status: 200 })
      : new Response("{}", { status: 403 });
  });
  try {
    process.env[KEY_ENV] = "sk-or-perso";
    process.env[`${KEY_ENV}_WORK`] = "sk-or-work";
    await refreshOpenRouterAccount("sk-or-perso");
    await refreshOpenRouterAccount("sk-or-work");
    const stats = await report({}, { config: twoAccounts });

    expect(stats.providerKeys.map((p) => [p.providerKey, p.providerLabel, p.calls])).toEqual([
      ["work", "OpenRouter boulot", 2],
      ["openrouter", "OpenRouter perso", 1],
    ]);
    // The same model on the same route is two rows, one per account.
    expect(stats.models.map((m) => [m.model, m.providerLabel, m.calls])).toEqual([
      ["glm-5.2", "OpenRouter boulot", 2],
      ["glm-5.2", "OpenRouter perso", 1],
    ]);
    // The endpoint view still folds them: both went to openrouter.ai.
    expect(stats.providers.map((p) => [p.provider, p.calls])).toEqual([["openrouter.ai", 3]]);

    const byLabel = Object.fromEntries(stats.reconciliation.map((r) => [r.providerLabel, r]));
    expect(byLabel["OpenRouter perso"]!.calls).toBe(1);
    expect(byLabel["OpenRouter perso"]!.recordedUsd).toBeCloseTo(1, 6);
    expect(byLabel["OpenRouter perso"]!.providerUsd).toBe(1.5);
    expect(byLabel["OpenRouter boulot"]!.calls).toBe(2);
    expect(byLabel["OpenRouter boulot"]!.recordedUsd).toBeCloseTo(2, 6);
    expect(byLabel["OpenRouter boulot"]!.providerUsd).toBe(4);
    expect(stats.facets.providerLabels).toEqual({ openrouter: "OpenRouter perso", work: "OpenRouter boulot" });
  } finally {
    delete process.env[KEY_ENV];
    delete process.env[`${KEY_ENV}_WORK`];
    mock.restore();
  }
});

test("with two ledgers, a call nobody placed is counted by neither, and stays findable", async () => {
  call({ sessionId: "a", providerKey: "openrouter" });
  call({ sessionId: "old" });
  // Both ledgers warm on the report: answered here, never by openrouter.ai.
  const mock = accountMock(1);
  try {
    process.env[KEY_ENV] = "sk-or-perso";
    process.env[`${KEY_ENV}_WORK`] = "sk-or-work";
    const stats = await report({}, { config: twoAccounts });
    expect(stats.reconciliation.map((r) => r.calls)).toEqual([1, 0]);
    expect(stats.providerKeys.find((p) => p.providerKey === "(unknown)")?.calls).toBe(1);
    const unknown = await report({}, { config: twoAccounts, filter: { provider: "(unknown)" } });
    expect(unknown.totals.calls).toBe(1);
    expect(unknown.sessions.map((s) => s.sessionId)).toEqual(["old"]);
  } finally {
    delete process.env[KEY_ENV];
    delete process.env[`${KEY_ENV}_WORK`];  mock.restore();
  }
});

test("the provider filter narrows to one account, and a provider removed since keeps its spend", async () => {
  call({ sessionId: "a", providerKey: "work" });
  call({ sessionId: "b", providerKey: "gone" });
  const work = await report({}, { config: twoAccounts, filter: { provider: "work" } });
  expect(work.totals.calls).toBe(1);
  expect(work.sessions.map((s) => s.sessionId)).toEqual(["a"]);
  const all = await report({}, { config: twoAccounts });
  expect(all.providerKeys.find((p) => p.providerKey === "gone")?.providerLabel).toBe("gone (removed)");
});

test("a provider filter cannot be asked of a swept month: the horizon goes off", async () => {
  call({ at: "2026-01-05T10:00:00.000Z", sessionId: "old", providerKey: "openrouter" });
  call({ sessionId: "new", providerKey: "openrouter" });
  foldBefore("2026-04-01T00:00:00.000Z");
  expect((await report()).rollupIncluded).toBe(true);
  const narrowed = await report({}, { filter: { provider: "openrouter" } });
  expect(narrowed.rollupIncluded).toBe(false);
  expect(narrowed.totals.calls).toBe(1);
});
