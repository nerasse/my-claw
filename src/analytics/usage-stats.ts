import { Database } from "bun:sqlite";
import { analyticsDb } from "./usage-db.ts";
import { log } from "../utils/logger.ts";

/**
 * Everything a global statistics page asks the analytics, aggregated in SQL.
 *
 * `usage-db.ts` answers questions about one conversation; this file answers questions about the
 * install. The two never share a query: a report scoped to a session can afford to hand rows back,
 * and one scoped to 47 000 rows cannot. Nothing here returns a row of `api_calls` -- every function
 * returns groups that SQLite already folded, and the only work left in TypeScript is pricing them
 * and joining the session labels, which live in another database entirely.
 *
 * See docs/stats-page.md.
 */

/** The windows the page offers. `all` is the only one that reaches past the retention wall. */
export type UsagePeriod = "7d" | "30d" | "90d" | "all";

const PERIOD_DAYS: Record<Exclude<UsagePeriod, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

/**
 * Where a group's numbers come from, and therefore how its money must be read.
 *
 * `live` is a group of `api_calls` rows still on disk: the cost frozen on them when the whole
 * group carries one, the price ladder when it does not. `rollup` is a month the purge already
 * swept, and its money is **final** -- frozen where the rows carried a cost, priced at the purge
 * into `reference_usd` where they did not. Nothing re-prices it: the rows it describes are gone,
 * and its tokens are there to be counted, not to be charged a second time.
 *
 * They are never merged before they are priced. The two halves are disjoint by construction --
 * the rollup covers exactly the rows the purge deleted -- so adding two priced totals is safe,
 * while adding two token counts and pricing once would throw away the frozen half.
 */
export type UsageOrigin = "live" | "rollup";

/** One model on one endpoint, folded, with everything needed to put a price on it. */
export interface UsageGroup {
  origin: UsageOrigin;
  model: string;
  baseUrl: string;
  /** Filled by the resellers that proxy; the pricing ladder reads it. Never on a rollup group. */
  upstreamApiBase: string | null;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  /**
   * The money already settled on this group, split the way it was charged.
   *
   * On a `live` group it is the cost frozen row by row, and it is the answer only when
   * `unpricedCalls` is 0: a group with even one unpriced call reports a sum covering part of its
   * tokens, which reads as a cheap model rather than as a partial sum, so the caller prices that
   * group from its tokens instead -- same rule as the per-conversation report.
   *
   * On a `rollup` group it is always the answer, because the purge already applied that same rule.
   */
  billedUsd: number;
  referenceUsd: number;
  /**
   * Calls carrying no money. On a live group, calls with no frozen cost; on a rollup group, calls
   * that not even the ladder could price when the purge ran.
   */
  unpricedCalls: number;
}

export interface UsageSessionGroup extends UsageGroup {
  sessionId: string;
  firstAt: string;
  lastAt: string;
}

export interface UsageDayGroup extends UsageGroup {
  /** `YYYY-MM-DD`, as SQLite reads it off the ISO timestamp. */
  date: string;
}

export interface UsageCallerGroup extends UsageGroup {
  caller: string;
}

/**
 * The live columns, in the order every query below needs them.
 *
 * `unpricedCalls` is what lets the caller decide whether the frozen money covers the whole group:
 * a group half-written before the cost columns shipped reports a sum covering part of its tokens,
 * which reads as a cheap model rather than as a partial sum. Same rule as the per-conversation
 * report, for the same reason.
 */
const LIVE_COLUMNS = `
  model,
  base_url                                              AS baseUrl,
  MAX(upstream_api_base)                                AS upstreamApiBase,
  COUNT(*)                                              AS calls,
  SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)    AS errors,
  COALESCE(SUM(prompt_tokens), 0)                       AS promptTokens,
  COALESCE(SUM(completion_tokens), 0)                   AS completionTokens,
  COALESCE(SUM(cache_read_tokens), 0)                   AS cacheReadTokens,
  COALESCE(SUM(cache_write_tokens), 0)                  AS cacheWriteTokens,
  COALESCE(SUM(duration_ms), 0)                         AS durationMs,
  COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_billed = 1 THEN cost_usd ELSE 0 END), 0)  AS billedUsd,
  COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_billed <> 1 THEN cost_usd ELSE 0 END), 0) AS referenceUsd,
  SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END)     AS unpricedCalls
`;

/** The same shape read off the rollup: one month already folded, money frozen when it was swept. */
const ROLLUP_COLUMNS = `
  model,
  base_url            AS baseUrl,
  NULL                AS upstreamApiBase,
  SUM(calls)          AS calls,
  SUM(errors)         AS errors,
  SUM(prompt_tokens)      AS promptTokens,
  SUM(completion_tokens)  AS completionTokens,
  SUM(cache_read_tokens)  AS cacheReadTokens,
  SUM(cache_write_tokens) AS cacheWriteTokens,
  SUM(duration_ms)    AS durationMs,
  SUM(billed_usd)     AS billedUsd,
  SUM(reference_usd)  AS referenceUsd,
  SUM(unpriced_calls) AS unpricedCalls
`;

type RawGroup = Omit<UsageGroup, "origin">;

/**
 * The lower bound of a window, as an ISO string, or `null` for `all`.
 *
 * Compared with `<=` against `timestamp`, which is lexicographically ordered because every writer
 * of that column produces the same fixed-width ISO form. The index on `timestamp` is what makes a
 * bounded period cheap; `all` deliberately has no bound and scans.
 */
export function periodCutoff(period: UsagePeriod, now = Date.now()): string | null {
  if (period === "all") return null;
  return new Date(now - PERIOD_DAYS[period] * 86_400_000).toISOString();
}

/**
 * True when this period's totals include months the purge has already swept.
 *
 * Only `all` ever does. A bounded period stops at most 90 days back, and the purge only removes
 * rows older than that, so the rollup and a bounded window cannot describe the same call.
 */
export function reachesRollup(period: UsagePeriod): boolean {
  return period === "all";
}

function db(): Database {
  return analyticsDb();
}

function tag(rows: RawGroup[], origin: UsageOrigin): UsageGroup[] {
  return rows.map((row) => ({ ...row, origin }));
}

function where(cutoff: string | null): string {
  return cutoff === null ? "" : "WHERE timestamp >= $cutoff";
}

function bind(cutoff: string | null): Record<string, string> {
  return cutoff === null ? {} : { $cutoff: cutoff };
}

/**
 * Every model on every endpoint over the period: the one query the totals, the per-provider
 * ranking, the reliability table, the cache shares and the reconciliation are all folded from.
 *
 * There is no index on `base_url` and none would help: this is a full aggregate over the window,
 * which SQLite answers by scanning it whatever indexes exist. Measured in docs/stats-page.md.
 */
export function usageByModel(period: UsagePeriod): UsageGroup[] {
  try {
    const cutoff = periodCutoff(period);
    const live = db()
      .prepare(`SELECT ${LIVE_COLUMNS} FROM api_calls ${where(cutoff)} GROUP BY model, base_url`)
      .all(bind(cutoff)) as RawGroup[];
    if (!reachesRollup(period)) return tag(live, "live");
    const rolled = db().prepare(`SELECT ${ROLLUP_COLUMNS} FROM usage_monthly GROUP BY model, base_url`).all() as RawGroup[];
    return [...tag(live, "live"), ...tag(rolled, "rollup")];
  } catch (err) {
    void log("warn", "analytics usageByModel failed", { error: String(err) });
    return [];
  }
}

/**
 * Every caller over the period, split by model so each slice can be priced: the orchestrator, the
 * sub-agents it spawned, the browser, the compactions.
 */
export function usageByCaller(period: UsagePeriod): UsageCallerGroup[] {
  try {
    const cutoff = periodCutoff(period);
    const live = db()
      .prepare(`SELECT caller, ${LIVE_COLUMNS} FROM api_calls ${where(cutoff)} GROUP BY caller, model, base_url`)
      .all(bind(cutoff)) as Array<RawGroup & { caller: string }>;
    const out: UsageCallerGroup[] = live.map((row) => ({ ...row, origin: "live" as const }));
    if (!reachesRollup(period)) return out;
    const rolled = db()
      .prepare(`SELECT caller, ${ROLLUP_COLUMNS} FROM usage_monthly GROUP BY caller, model, base_url`)
      .all() as Array<RawGroup & { caller: string }>;
    return [...out, ...rolled.map((row) => ({ ...row, origin: "rollup" as const }))];
  } catch (err) {
    void log("warn", "analytics usageByCaller failed", { error: String(err) });
    return [];
  }
}

/**
 * Every session that ever made a call in the window, split by model, with the sessions that no
 * longer exist on disk included: their rows outlive them, and a page that dropped them would
 * report a spend smaller than the one it just totalled.
 *
 * Live rows only, whatever the period. The rollup key has no session on it, so the ranking stops
 * where the per-call detail stops -- `usageHorizon().detailSince` is the date to say that with.
 */
export function usageBySession(period: UsagePeriod): UsageSessionGroup[] {
  try {
    const cutoff = periodCutoff(period);
    const rows = db()
      .prepare(
        `SELECT session_id AS sessionId, MIN(timestamp) AS firstAt, MAX(timestamp) AS lastAt, ${LIVE_COLUMNS}
         FROM api_calls ${where(cutoff)}
         GROUP BY session_id, model, base_url`,
      )
      .all(bind(cutoff)) as Array<RawGroup & { sessionId: string; firstAt: string; lastAt: string }>;
    return rows.map((row) => ({ ...row, origin: "live" as const }));
  } catch (err) {
    void log("warn", "analytics usageBySession failed", { error: String(err) });
    return [];
  }
}

/**
 * The window day by day, split by model so each day can be priced.
 *
 * Live rows only, like the sessions and for the same reason: the rollup is monthly, so a daily
 * chart cannot reach behind the retention wall and must not pretend to.
 */
export function usageByDay(period: UsagePeriod): UsageDayGroup[] {
  try {
    const cutoff = periodCutoff(period);
    const rows = db()
      .prepare(
        `SELECT substr(timestamp, 1, 10) AS date, ${LIVE_COLUMNS}
         FROM api_calls ${where(cutoff)}
         GROUP BY substr(timestamp, 1, 10), model, base_url`,
      )
      .all(bind(cutoff)) as Array<RawGroup & { date: string }>;
    return rows.map((row) => ({ ...row, origin: "live" as const }));
  } catch (err) {
    void log("warn", "analytics usageByDay failed", { error: String(err) });
    return [];
  }
}
