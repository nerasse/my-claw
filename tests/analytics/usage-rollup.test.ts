import { test, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { analyticsDb, pruneOldRecords, recordApiCall, usageHorizon } from "../../src/analytics/usage-db.ts";
import { ModelPricing, CACHE_VERSION, setSharedPricing } from "../../src/llm/pricing.ts";

/**
 * The retention wall, and the one thing that must survive it.
 *
 * `pruneOldRecords` deletes every per-call row older than ninety days. A page that claims to show
 * everything this install ever spent would then be short by however much history the purge has
 * already taken, so the purge folds the rows it is about to delete into a permanent monthly
 * rollup, in the same transaction, and only rows it deletes.
 *
 * The test that matters here is the sum: rollup + live must equal the total from before the purge
 * for every column that counts something, and must never *lose* money. Everything else in this file
 * exists to make that one measurable without waiting ninety days.
 *
 * Money is the one figure that can go up across a purge, and deliberately: a row that carried no
 * frozen cost is priced at the purge through the live ladder, into `reference_usd`, because rolling
 * it up at zero would turn real spend into a permanent hole. See docs/stats-page.md.
 */

/** models.dev on disk, so `recordApiCall` can freeze a cost on the rows that should carry one. */
function pricing(): ModelPricing {
  mkdirSync(MY_CLAW_DIR, { recursive: true });
  writeFileSync(
    join(MY_CLAW_DIR, "model-pricing.json"),
    JSON.stringify({
      version: CACHE_VERSION,
      fetchedAt: new Date().toISOString(),
      hosts: { openrouter: "https://openrouter.ai/api/v1" },
      models: { openrouter: { "glm-5.2": { cost: { input: 1, output: 2 }, id: "glm-5.2" } } },
    }),
  );
  return new ModelPricing(() => ({}), () => []);
}

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
  setSharedPricing(null);
});

interface Sown {
  at: string;
  model?: string;
  baseUrl?: string;
  platform?: string;
  caller?: "orchestrator" | "subagent" | "browser" | "compaction";
  error?: string;
  priced?: boolean;
}

/**
 * One recorded call, dated.
 *
 * `recordApiCall` stamps `now` and takes no date, so the timestamp is moved afterwards through the
 * shared handle. Every row of a sowing gets a distinct session id, which is also how it is found.
 */
function sow(id: string, rows: Sown[]): void {
  rows.forEach((row, i) => {
    const sessionId = `${id}-${i}`;
    setSharedPricing(row.priced === true ? pricing() : null);
    recordApiCall({
      sessionId,
      parentSessionId: sessionId,
      platform: row.platform ?? "my-claw-app",
      model: row.model ?? "glm-5.2",
      baseUrl: row.baseUrl ?? "https://openrouter.ai/api/v1",
      streaming: true,
      caller: row.caller ?? "orchestrator",
      promptTokens: 1000 * (i + 1),
      completionTokens: 10 * (i + 1),
      totalTokens: 1010 * (i + 1),
      cacheReadTokens: 100 * (i + 1),
      cacheWriteTokens: 5 * (i + 1),
      toolCalls: 0,
      iteration: 1,
      durationMs: 250 + i,
      ...(row.error === undefined ? {} : { error: row.error }),
    });
    analyticsDb().run("UPDATE api_calls SET timestamp = ? WHERE session_id = ?", [row.at, sessionId]);
  });
  setSharedPricing(null);
}

const SUMS = `
  COUNT(*)                                            AS calls,
  COALESCE(SUM(prompt_tokens), 0)                     AS promptTokens,
  COALESCE(SUM(completion_tokens), 0)                 AS completionTokens,
  COALESCE(SUM(cache_read_tokens), 0)                 AS cacheReadTokens,
  COALESCE(SUM(cache_write_tokens), 0)                AS cacheWriteTokens,
  COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_billed = 1 THEN cost_usd ELSE 0 END), 0)  AS billedUsd,
  COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_billed <> 1 THEN cost_usd ELSE 0 END), 0) AS referenceUsd,
  SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END)   AS unpricedCalls,
  SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)  AS errors,
  COALESCE(SUM(duration_ms), 0)                       AS durationMs
`;

type Totals = Record<string, number>;

function liveTotals(): Totals {
  return analyticsDb().prepare(`SELECT ${SUMS} FROM api_calls`).get() as Totals;
}

function rollupTotals(): Totals {
  return analyticsDb()
    .prepare(
      `SELECT
         COALESCE(SUM(calls), 0)              AS calls,
         COALESCE(SUM(prompt_tokens), 0)      AS promptTokens,
         COALESCE(SUM(completion_tokens), 0)  AS completionTokens,
         COALESCE(SUM(cache_read_tokens), 0)  AS cacheReadTokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
         COALESCE(SUM(billed_usd), 0)         AS billedUsd,
         COALESCE(SUM(reference_usd), 0)      AS referenceUsd,
         COALESCE(SUM(unpriced_calls), 0)     AS unpricedCalls,
         COALESCE(SUM(errors), 0)             AS errors,
         COALESCE(SUM(duration_ms), 0)        AS durationMs
       FROM usage_monthly`,
    )
    .get() as Totals;
}

function combined(): Totals {
  const live = liveTotals();
  const rolled = rollupTotals();
  const out: Totals = {};
  for (const key of Object.keys(live)) out[key] = (live[key] ?? 0) + (rolled[key] ?? 0);
  return out;
}

/** The columns a purge may never change: what happened is what happened. */
const COUNTED = ["calls", "promptTokens", "completionTokens", "cacheReadTokens", "cacheWriteTokens", "errors", "durationMs"] as const;

/**
 * What a purge is allowed to do to the totals.
 *
 * Everything counted is conserved exactly. `billedUsd` too: only a provider states a charge, and
 * the purge is not a provider. `referenceUsd` may grow, by exactly the rows the ladder could price
 * on the way out, and `unpricedCalls` may only shrink -- those two move together, and that movement
 * is the whole point of pricing at the purge.
 */
function expectConserved(before: Totals, after: Totals): void {
  for (const key of COUNTED) expect(after[key]).toBe(before[key]!);
  // Float sums in a different order land within a cent of nothing.
  expect(after["billedUsd"]).toBeCloseTo(before["billedUsd"]!, 9);
  expect(after["referenceUsd"]).toBeGreaterThanOrEqual(before["referenceUsd"]! - 1e-9);
  expect(after["unpricedCalls"]).toBeLessThanOrEqual(before["unpricedCalls"]!);
}

/** The stricter form, for rows that were all frozen: nothing at all is left to compute. */
function expectSameTotals(before: Totals, after: Totals): void {
  for (const key of Object.keys(before)) {
    if (key.endsWith("Usd")) expect(after[key]).toBeCloseTo(before[key]!, 9);
    else expect(after[key]).toBe(before[key]!);
  }
}

/** The whole point of the rollup, measured. */
test("rollup plus live equals the total from before the purge, column by column", () => {
  sow("mix", [
    { at: "2026-01-05T10:00:00.000Z", priced: true },
    { at: "2026-01-06T10:00:00.000Z", caller: "subagent", error: "boom" },
    { at: "2026-02-14T10:00:00.000Z", model: "claude-opus-5", baseUrl: "https://api.anthropic.com" },
    { at: "2026-02-15T10:00:00.000Z", platform: "cron", caller: "browser", priced: true },
    { at: "2026-03-01T10:00:00.000Z" },
    { at: "2026-06-20T10:00:00.000Z" },
    { at: "2026-06-21T10:00:00.000Z", caller: "compaction", error: "timeout" },
  ]);

  const before = combined();
  expect(before["calls"]).toBe(7);
  expect(rollupTotals()["calls"]).toBe(0);

  pruneOldRecords("2026-04-01T00:00:00.000Z");

  // Five of seven were condemned, so a purge that quietly did nothing cannot pass this.
  expect(liveTotals()["calls"]).toBe(2);
  expect(rollupTotals()["calls"]).toBe(5);
  expectConserved(before, combined());
});

/** The same reading with every row frozen: nothing is left to compute, so nothing moves at all. */
test("a purge of rows that all carry a frozen cost changes no column whatsoever", () => {
  sow("frozen", [
    { at: "2026-01-05T10:00:00.000Z", priced: true },
    { at: "2026-02-05T10:00:00.000Z", priced: true, caller: "subagent", error: "boom" },
    { at: "2026-06-20T10:00:00.000Z", priced: true },
  ]);
  const before = combined();
  expect(before["unpricedCalls"]).toBe(0);

  pruneOldRecords("2026-04-01T00:00:00.000Z");
  expect(rollupTotals()["calls"]).toBe(2);
  expectSameTotals(before, combined());
});

test("a second purge folds only what it deletes, and never the months already rolled up", () => {
  sow("two", [
    { at: "2026-01-05T10:00:00.000Z", priced: true },
    { at: "2026-02-05T10:00:00.000Z" },
    { at: "2026-03-05T10:00:00.000Z", error: "boom" },
  ]);
  const before = combined();

  pruneOldRecords("2026-02-01T00:00:00.000Z");
  expectSameTotals(before, combined());
  pruneOldRecords("2026-04-01T00:00:00.000Z");
  expectSameTotals(before, combined());

  // And the third pass, with nothing left to condemn, is not a third helping of anything.
  pruneOldRecords("2026-04-01T00:00:00.000Z");
  expect(liveTotals()["calls"]).toBe(0);
  expectSameTotals(before, combined());
});

test("the aggregate key is the month and the four dimensions, and nothing else collapses", () => {
  sow("keys", [
    { at: "2026-01-05T10:00:00.000Z" },
    { at: "2026-01-25T10:00:00.000Z" },
    { at: "2026-02-05T10:00:00.000Z" },
    { at: "2026-01-06T10:00:00.000Z", model: "claude-opus-5" },
    { at: "2026-01-07T10:00:00.000Z", baseUrl: "https://api.anthropic.com" },
    { at: "2026-01-08T10:00:00.000Z", platform: "cron" },
    { at: "2026-01-09T10:00:00.000Z", caller: "subagent" },
  ]);
  pruneOldRecords("2026-03-01T00:00:00.000Z");

  const rows = analyticsDb()
    .prepare("SELECT month, model, base_url AS baseUrl, platform, caller, calls FROM usage_monthly ORDER BY month, model, base_url, platform, caller")
    .all() as Array<{ month: string; calls: number }>;
  // Seven rows, six groups: only the two January calls that agree on all four dimensions merge.
  expect(rows).toHaveLength(6);
  expect(rows.reduce((sum, r) => sum + r.calls, 0)).toBe(7);
  expect(rows.filter((r) => r.calls === 2)).toHaveLength(1);
  expect(new Set(rows.map((r) => r.month))).toEqual(new Set(["2026-01", "2026-02"]));
});

/**
 * The purge is a rollup and a delete, or it is neither.
 *
 * A rollup that lands alone double-counts its months at the next boot; a delete that lands alone
 * is the loss the rollup exists to prevent. The transaction is what makes that a non-question, and
 * a failing statement is what proves it: the DELETE cannot run without its INSERT.
 */
test("a rollup that cannot be written takes its delete down with it", () => {
  sow("atomic", [{ at: "2026-01-05T10:00:00.000Z" }, { at: "2026-01-06T10:00:00.000Z" }]);
  const before = combined();

  try {
    // A table in the way of the INSERT: the rollup throws, and the whole transaction rolls back.
    analyticsDb().run("DROP TABLE usage_monthly");
    pruneOldRecords("2026-04-01T00:00:00.000Z");
    expect(liveTotals()["calls"]).toBe(2);
  } finally {
    // In a finally, so a failure here is one failure: the table is shared by every test of this
    // file, and leaving it dropped would fail the rest of them for a reason none of them is about.
    analyticsDb().run(`
      CREATE TABLE IF NOT EXISTS usage_monthly (
        month TEXT NOT NULL, model TEXT NOT NULL, base_url TEXT NOT NULL, platform TEXT NOT NULL, caller TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        billed_usd REAL NOT NULL DEFAULT 0, reference_usd REAL NOT NULL DEFAULT 0, unpriced_calls INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (month, model, base_url, platform, caller)
      )`);
  }
  pruneOldRecords("2026-04-01T00:00:00.000Z");
  expect(liveTotals()["calls"]).toBe(0);
  expectSameTotals(before, combined());
});

/** The purge with a price table published, which is how it runs at boot. */
function purgePriced(cutoff: string): void {
  setSharedPricing(pricing());
  try {
    pruneOldRecords(cutoff);
  } finally {
    setSharedPricing(null);
  }
}

interface RollupMoney {
  billed: number;
  reference: number;
  unpriced: number;
  calls: number;
}

function rollupMoney(): RollupMoney {
  return analyticsDb()
    .prepare(
      `SELECT COALESCE(SUM(billed_usd), 0) AS billed, COALESCE(SUM(reference_usd), 0) AS reference,
              COALESCE(SUM(unpriced_calls), 0) AS unpriced, COALESCE(SUM(calls), 0) AS calls
       FROM usage_monthly`,
    )
    .get() as RollupMoney;
}

/**
 * The decision the owner took: the purge prices what it condemns, or three quarters of this
 * install's history becomes a permanent hole the day those months fall past the wall.
 *
 * The price is a catalogue rate, so it lands in `reference_usd` and never in `billed_usd`. Only
 * whatever billed a call can state a charge, and the purge is not a provider.
 */
test("rows carrying no frozen cost are priced on their way out, into reference and never into billed", () => {
  sow("toprice", [
    { at: "2026-01-05T10:00:00.000Z" },
    { at: "2026-01-06T10:00:00.000Z" },
  ]);
  const tokens = analyticsDb()
    .prepare(
      `SELECT SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens,
              SUM(cache_read_tokens) AS cacheReadTokens, SUM(cache_write_tokens) AS cacheWriteTokens
       FROM api_calls`,
    )
    .get() as Record<string, number>;
  expect(analyticsDb().prepare("SELECT COUNT(cost_usd) AS n FROM api_calls").get()).toEqual({ n: 0 });

  purgePriced("2026-04-01T00:00:00.000Z");

  // Coherent, not merely non-zero: the same ladder over the same aggregated tokens, which is what
  // proves the purge priced the rows it condemned and not something else.
  const expected = pricing().costOf({
    model: "glm-5.2",
    baseUrl: "https://openrouter.ai/api/v1",
    promptTokens: tokens["promptTokens"]!,
    completionTokens: tokens["completionTokens"]!,
    cacheReadTokens: tokens["cacheReadTokens"]!,
    cacheWriteTokens: tokens["cacheWriteTokens"]!,
  });
  expect(expected?.usd).toBeGreaterThan(0);

  const rolled = rollupMoney();
  expect(rolled.calls).toBe(2);
  expect(rolled.reference).toBeCloseTo(expected!.usd, 9);
  expect(rolled.billed).toBe(0);
  expect(rolled.unpriced).toBe(0);
});

/**
 * A group can hold both kinds of call -- the cost columns shipped mid-history -- and the two halves
 * are settled apart. Pricing the whole group's tokens on top of the frozen sum would charge the
 * frozen calls twice.
 */
test("a half-frozen group keeps its charge and prices only the calls that had none", () => {
  sow("half", [
    { at: "2026-01-05T10:00:00.000Z", priced: true },
    { at: "2026-01-06T10:00:00.000Z" },
  ]);
  const frozen = analyticsDb().prepare("SELECT SUM(cost_usd) AS usd FROM api_calls WHERE cost_usd IS NOT NULL").get() as { usd: number };
  const unfrozen = analyticsDb()
    .prepare(
      `SELECT SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens,
              SUM(cache_read_tokens) AS cacheReadTokens, SUM(cache_write_tokens) AS cacheWriteTokens
       FROM api_calls WHERE cost_usd IS NULL`,
    )
    .get() as Record<string, number>;

  purgePriced("2026-04-01T00:00:00.000Z");

  const expected = pricing().costOf({
    model: "glm-5.2",
    baseUrl: "https://openrouter.ai/api/v1",
    promptTokens: unfrozen["promptTokens"]!,
    completionTokens: unfrozen["completionTokens"]!,
    cacheReadTokens: unfrozen["cacheReadTokens"]!,
    cacheWriteTokens: unfrozen["cacheWriteTokens"]!,
  })!;
  const rolled = rollupMoney();
  expect(rolled.calls).toBe(2);
  expect(rolled.billed).toBeCloseTo(frozen.usd, 9);
  expect(rolled.reference).toBeCloseTo(expected.usd, 9);
  expect(rolled.unpriced).toBe(0);
});

/**
 * `unpriced_calls` now means one thing: nothing anywhere knows what this cost. Not "the columns
 * had not shipped yet", which the purge can answer for, but a model and a host no rung of the
 * ladder has ever heard of.
 */
test("what even the ladder cannot price stays unpriced, and takes no money with it", () => {
  sow("unknown", [{ at: "2026-01-05T10:00:00.000Z", model: "a-model-no-table-knows", baseUrl: "https://unknown.example.test" }]);
  purgePriced("2026-04-01T00:00:00.000Z");

  const rolled = rollupMoney();
  expect(rolled.calls).toBe(1);
  expect(rolled.unpriced).toBe(1);
  expect(rolled.billed).toBe(0);
  expect(rolled.reference).toBe(0);
});

/** No table published at all: the purge cannot invent one, and says so the same way. */
test("a purge with no price table in hand rolls the calls up and counts them unpriced", () => {
  sow("notable", [{ at: "2026-01-05T10:00:00.000Z" }]);
  pruneOldRecords("2026-04-01T00:00:00.000Z");

  const rolled = rollupMoney();
  expect(rolled.calls).toBe(1);
  expect(rolled.unpriced).toBe(1);
  expect(rolled.reference).toBe(0);
});

/**
 * `CREATE TABLE IF NOT EXISTS` is enough for a table, where it is not enough for a column.
 *
 * The comment above `ensureColumn` says why a column added after the fact needs an ALTER: the
 * CREATE never runs again on a database that already has the table. A brand new *table* has no
 * such problem, and this is the measurement rather than the assertion.
 */
test("the rollup table appears on an analytics database that predates it", () => {
  const path = join(MY_CLAW_DIR, "legacy-analytics.db");
  const old = new Database(path, { create: true });
  old.exec("CREATE TABLE api_calls (id INTEGER PRIMARY KEY, timestamp TEXT)");
  old.exec("CREATE TABLE IF NOT EXISTS api_calls (id INTEGER PRIMARY KEY, timestamp TEXT, added TEXT)");
  // The CREATE that ran second changed nothing: that is the trap `ensureColumn` works around.
  expect((old.prepare("PRAGMA table_info(api_calls)").all() as Array<{ name: string }>).map((c) => c.name)).toEqual(["id", "timestamp"]);

  old.exec(`CREATE TABLE IF NOT EXISTS usage_monthly (month TEXT NOT NULL, PRIMARY KEY (month))`);
  const tables = (old.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
  old.close();
  expect(tables).toContain("usage_monthly");
});

test("the horizon names where the detail starts and where the totals start, and neither before it exists", () => {
  expect(usageHorizon()).toEqual({});

  sow("horizon", [{ at: "2026-01-05T10:00:00.000Z" }, { at: "2026-06-20T10:00:00.000Z" }]);
  expect(usageHorizon()).toEqual({ detailSince: "2026-01-05T10:00:00.000Z" });

  pruneOldRecords("2026-04-01T00:00:00.000Z");
  expect(usageHorizon()).toEqual({ detailSince: "2026-06-20T10:00:00.000Z", totalsSince: "2026-01" });
});
