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
  /**
   * The configured provider that served the group, by key. Null on a rollup group (the purge key
   * never had it) and on old rows nothing could place.
   */
  providerKey: string | null;
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
  /**
   * Who paid for these calls: the session itself for a conversation, its driver for a worker.
   * Null on the calls recorded before the column existed, which no row can place.
   */
  parentSessionId: string | null;
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

/** The distinct values a filter can be set to over a window. */
export interface UsageFacets {
  models: string[];
  providers: string[];
  callers: string[];
  sessionIds: string[];
  workspaces: string[];
  folderIds: string[];
}

/**
 * The distinct values a filter can be set to over the window: the option list of the filter sheet,
 * for the one case that cannot answer it from the grain it already has (`facetsOfGrain`).
 *
 * One `DISTINCT` per dimension, six of them, rather than the aggregates the report is made of:
 * this answers what exists, not what it cost. Measured on a 30-day window: 573 ms, which is why a
 * page nobody narrowed never runs it -- the report's own grain carries every one of these columns.
 *
 * Deliberately unfiltered by whatever the caller is narrowing: an option list that shrank to the
 * choice already made would leave no way back to the others.
 */
export function usageFacets(period: UsagePeriod): UsageFacets {
  try {
    const cutoff = periodCutoff(period);
    const values = (column: string, nullAs: string): string[] =>
      (db()
        .prepare(`SELECT DISTINCT ${column} AS value FROM api_calls ${where(cutoff, {})}`)
        .all(bind(cutoff, {})) as Array<{ value: string | null }>)
        .map((row) => row.value ?? nullAs)
        .sort((a, b) => a.localeCompare(b));
    return {
      models: values("model", ""),
      providers: values("provider_key", UNKNOWN_PROVIDER),
      callers: values("caller", ""),
      sessionIds: values("session_id", ""),
      workspaces: values("workspace", UNKNOWN_WORKSPACE),
      folderIds: values("folder_id", NO_FOLDER),
    };
  } catch (err) {
    void log("warn", "analytics usageFacets failed", { error: String(err) });
    return { models: [], providers: [], callers: [], sessionIds: [], workspaces: [], folderIds: [] };
  }
}

/**
 * The dimensions a report can be narrowed by, each one a column of `api_calls`.
 *
 * The narrowing happens in SQL, before the aggregation, and that is the whole point: a filtered
 * report is a smaller population, not a smaller answer to the same question. The totals are
 * recomputed over the rows that survive, so a filtered page cannot show a sum that disagrees with
 * the rows under it -- which is what filtering pre-folded groups would do the moment a dimension a
 * group does not carry (a caller on a model ranking) is asked for.
 *
 * `errorsOnly` and `unpricedOnly` are row predicates for the same reason. "Only the failures" is
 * the calls that failed, not the routes that happened to fail once: a group-level version of that
 * filter would report the whole spend of a model with a single error on it.
 *
 * `provider` is the key of a configured provider (`provider_key`), not the route the page draws:
 * two OpenRouter accounts are two values, one address. The endpoint pin (`streamlake/fp8`) lives in
 * the model id, so the `model` dimension narrows to it exactly.
 */
export interface StatsFilter {
  model?: string;
  provider?: string;
  caller?: string;
  sessionId?: string;
  /** Where the call ran from: a workspace key, "default", or `UNKNOWN_WORKSPACE`. */
  workspace?: string;
  /** The folder the call was filed as at call time, or `NO_FOLDER`. */
  folderId?: string;
  errorsOnly?: boolean;
  unpricedOnly?: boolean;
}

/**
 * What a NULL is called in the two new dimensions.
 *
 * Both are offered as values rather than as holes: the rows written before the columns existed
 * (workspace) and the calls nobody filed (folder) are populations worth asking after, and a
 * filter that cannot select them has no way back to a quarter of the history. Neither name can be
 * produced by the writers -- a workspace is a config key, a `default`, or a directory.
 */
export const UNKNOWN_WORKSPACE = "(unknown)";
export const NO_FOLDER = "(none)";
/** The calls no provider could be given: recorded before the column, on an address nothing owns. */
export const UNKNOWN_PROVIDER = "(unknown)";

/** True when the filter narrows anything: the one thing that makes the extra passes worth it. */
export function filterNarrows(filter: StatsFilter): boolean {
  return Object.values(filter).some((value) => value !== undefined && value !== false);
}

/**
 * Whether a filter can be asked of a month the purge already swept.
 *
 * The rollup key is `(month, model, base_url, platform, caller)`: two of the dimensions above
 * are columns of it, the others are not (the provider among them: the purge never kept it). A session is not on that key, and `errors` and `unpriced_calls`
 * are counters rather than rows -- "only the failures" is not a question a monthly fold can
 * answer. Those three drop the rollup instead of adding months no filter ever touched, and the
 * payload's `rollupIncluded` goes false with them so the page stops claiming a horizon it is not
 * showing.
 */
export function filterReachesRollup(filter: StatsFilter): boolean {
  return (
    filter.sessionId === undefined &&
    filter.provider === undefined &&
    filter.workspace === undefined &&
    filter.folderId === undefined &&
    filter.errorsOnly !== true &&
    filter.unpricedOnly !== true
  );
}

/** The same shape read off the rollup: one month already folded, money frozen when it was swept. */
const ROLLUP_COLUMNS = `
  model,
  base_url            AS baseUrl,
  NULL                AS providerKey,
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

/**
 * The row predicate a window and a filter make, and the parameters it binds.
 *
 * One list, used by the string and by the bind, so a clause can never be added to the SQL without
 * its parameter following it. The four column filters are named rather than interpolated: a model
 * id or a session id goes into the statement as a value, whatever it contains.
 */
function predicate(cutoff: string | null, filter: StatsFilter): { sql: string[]; params: Record<string, string> } {
  const sql: string[] = [];
  const params: Record<string, string> = {};
  if (cutoff !== null) {
    sql.push("timestamp >= $cutoff");
    params.$cutoff = cutoff;
  }
  if (filter.model !== undefined) {
    sql.push("model = $model");
    params.$model = filter.model;
  }
  if (filter.provider === UNKNOWN_PROVIDER) sql.push("provider_key IS NULL");
  else if (filter.provider !== undefined) {
    sql.push("provider_key = $provider");
    params.$provider = filter.provider;
  }
  if (filter.caller !== undefined) {
    sql.push("caller = $caller");
    params.$caller = filter.caller;
  }
  if (filter.sessionId !== undefined) {
    sql.push("session_id = $sessionId");
    params.$sessionId = filter.sessionId;
  }
  // The two dimensions a NULL is a value in: matched as a hole rather than as a string, or a
  // whole population (the pre-column history, the unfolder conversations) would be unfilterable.
  if (filter.workspace === UNKNOWN_WORKSPACE) sql.push("workspace IS NULL");
  else if (filter.workspace !== undefined) {
    sql.push("workspace = $workspace");
    params.$workspace = filter.workspace;
  }
  if (filter.folderId === NO_FOLDER) sql.push("folder_id IS NULL");
  else if (filter.folderId !== undefined) {
    sql.push("folder_id = $folderId");
    params.$folderId = filter.folderId;
  }
  if (filter.errorsOnly === true) sql.push("error IS NOT NULL");
  if (filter.unpricedOnly === true) sql.push("cost_usd IS NULL");
  return { sql, params };
}

function where(cutoff: string | null, filter: StatsFilter): string {
  const parts = predicate(cutoff, filter).sql;
  return parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`;
}

function bind(cutoff: string | null, filter: StatsFilter): Record<string, string> {
  return predicate(cutoff, filter).params;
}

/** The two dimensions the rollup shares with the live rows. */
function rolledPredicate(filter: StatsFilter): { sql: string; params: Record<string, string> } {
  const parts: string[] = [];
  const params: Record<string, string> = {};
  if (filter.model !== undefined) {
    parts.push("model = $model");
    params.$model = filter.model;
  }
  if (filter.caller !== undefined) {
    parts.push("caller = $caller");
    params.$caller = filter.caller;
  }
  return { sql: parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`, params };
}

/**
 * The grain every aggregate on the page is folded from: one scan of the window.
 *
 * Totals, the model ranking, the per-caller split, the day chart and the per-session ranking are
 * the same rows grouped by different columns. Asked one at a time that is four scans of
 * `api_calls`, plus six `DISTINCT`s for the filter sheet when the page is not narrowed: 1.6 s of
 * SQLite on a 107k-row window and 3.4 s over the whole table, measured on the install's own file
 * (docs/stats-page.md). Asked once at the finest grain they share, it is one scan and a few
 * thousand rows folded here: 380 ms and 740 ms.
 *
 * The grain carries the two dimensions no aggregate keeps (workspace, folder), so the filter sheet
 * of an unfiltered page costs no query at all.
 */
const GRAIN_COLUMNS = `
  substr(timestamp, 1, 10)                              AS date,
  session_id                                            AS sessionId,
  MAX(parent_session_id)                                AS parentSessionId,
  caller,
  workspace,
  folder_id                                             AS folderId,
  model,
  base_url                                              AS baseUrl,
  provider_key                                          AS providerKey,
  MAX(upstream_api_base)                                AS upstreamApiBase,
  MIN(timestamp)                                        AS firstAt,
  MAX(timestamp)                                        AS lastAt,
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

/** One row of the shared scan: the calls that agree on every dimension the page can group by. */
export interface UsageGrainRow extends UsageGroup {
  origin: "live";
  /** `YYYY-MM-DD`, as SQLite reads it off the ISO timestamp. */
  date: string;
  sessionId: string;
  /** The session that paid for these calls: this one for a conversation, its driver for a worker. */
  parentSessionId: string | null;
  caller: string;
  workspace: string | null;
  folderId: string | null;
  firstAt: string;
  lastAt: string;
}

export function usageGrain(period: UsagePeriod, filter: StatsFilter): UsageGrainRow[] {
  try {
    const cutoff = periodCutoff(period);
    const rows = db()
      .prepare(
        `SELECT ${GRAIN_COLUMNS} FROM api_calls ${where(cutoff, filter)}
         GROUP BY substr(timestamp, 1, 10), session_id, caller, workspace, folder_id, model, base_url, provider_key`,
      )
      .all(bind(cutoff, filter)) as Array<Omit<UsageGrainRow, "origin">>;
    return rows.map((row) => ({ ...row, origin: "live" as const }));
  } catch (err) {
    void log("warn", "analytics usageGrain failed", { error: String(err) });
    return [];
  }
}

/** A group being accumulated across grain rows. */
type GrainAcc = UsageGroup & { origin: "live" };

function accOf(row: UsageGrainRow): GrainAcc {
  return {
    origin: "live",
    model: row.model,
    baseUrl: row.baseUrl,
    providerKey: row.providerKey,
    upstreamApiBase: row.upstreamApiBase,
    calls: row.calls,
    errors: row.errors,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    durationMs: row.durationMs,
    billedUsd: row.billedUsd,
    referenceUsd: row.referenceUsd,
    unpricedCalls: row.unpricedCalls,
  };
}

function mergeAcc(into: GrainAcc, row: UsageGrainRow): void {
  into.calls += row.calls;
  into.errors += row.errors;
  into.promptTokens += row.promptTokens;
  into.completionTokens += row.completionTokens;
  into.cacheReadTokens += row.cacheReadTokens;
  into.cacheWriteTokens += row.cacheWriteTokens;
  into.durationMs += row.durationMs;
  into.billedUsd += row.billedUsd;
  into.referenceUsd += row.referenceUsd;
  into.unpricedCalls += row.unpricedCalls;
  // MAX(upstream_api_base) ignores NULLs, so a group with one placed call carries its address.
  if (row.upstreamApiBase !== null && (into.upstreamApiBase === null || row.upstreamApiBase > into.upstreamApiBase)) {
    into.upstreamApiBase = row.upstreamApiBase;
  }
}

/** A fold key. JSON, so a NULL dimension can never collide with the empty string. */
function keyOf(...parts: Array<string | null>): string {
  return JSON.stringify(parts);
}

/** A fold's groups, each with the first grain row that started it -- where a label comes from. */
function fold(rows: readonly UsageGrainRow[], key: (row: UsageGrainRow) => string): Map<string, { group: GrainAcc; first: UsageGrainRow }> {
  const groups = new Map<string, { group: GrainAcc; first: UsageGrainRow }>();
  for (const row of rows) {
    const k = key(row);
    const held = groups.get(k);
    if (held) mergeAcc(held.group, row);
    else groups.set(k, { group: accOf(row), first: row });
  }
  return groups;
}

/**
 * Every model on every endpoint over the period: the one grouping the totals, the per-provider
 * ranking, the reliability table, the cache shares and the reconciliation are all built from.
 *
 * `grain` is passed by the caller that already read it: the page folds four groupings out of one
 * scan, and a function that re-read the table per grouping would put the four scans back.
 */
export function usageByModel(period: UsagePeriod, filter: StatsFilter, grain = usageGrain(period, filter)): UsageGroup[] {
  try {
    const live = [...fold(grain, (row) => keyOf(row.model, row.baseUrl, row.providerKey)).values()].map((held) => held.group);
    if (!reachesRollup(period) || !filterReachesRollup(filter)) return live;
    const months = rolledPredicate(filter);
    const rolled = db()
      .prepare(`SELECT ${ROLLUP_COLUMNS} FROM usage_monthly ${months.sql} GROUP BY model, base_url`)
      .all(months.params) as RawGroup[];
    return [...live, ...tag(rolled, "rollup")];
  } catch (err) {
    void log("warn", "analytics usageByModel failed", { error: String(err) });
    return [];
  }
}

/**
 * Every caller over the period, split by model so each slice can be priced: the orchestrator, the
 * sub-agents it spawned, the browser, the compactions.
 */
export function usageByCaller(period: UsagePeriod, filter: StatsFilter, grain = usageGrain(period, filter)): UsageCallerGroup[] {
  try {
    const out: UsageCallerGroup[] = [...fold(grain, (row) => keyOf(row.caller, row.model, row.baseUrl, row.providerKey)).values()].map(
      ({ group, first }) => ({ ...group, caller: first.caller }),
    );
    if (!reachesRollup(period) || !filterReachesRollup(filter)) return out;
    const months = rolledPredicate(filter);
    const rolled = db()
      .prepare(`SELECT caller, ${ROLLUP_COLUMNS} FROM usage_monthly ${months.sql} GROUP BY caller, model, base_url`)
      .all(months.params) as Array<RawGroup & { caller: string }>;
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
export function usageBySession(period: UsagePeriod, filter: StatsFilter, grain = usageGrain(period, filter)): UsageSessionGroup[] {
  try {
    const held = new Map<string, UsageSessionGroup & { origin: "live" }>();
    for (const row of grain) {
      const key = keyOf(row.sessionId, row.model, row.baseUrl, row.providerKey);
      const group = held.get(key);
      if (!group) {
        held.set(key, {
          ...accOf(row),
          sessionId: row.sessionId,
          parentSessionId: row.parentSessionId,
          firstAt: row.firstAt,
          lastAt: row.lastAt,
        });
        continue;
      }
      mergeAcc(group, row);
      if (row.parentSessionId !== null && (group.parentSessionId === null || row.parentSessionId > group.parentSessionId)) {
        group.parentSessionId = row.parentSessionId;
      }
      if (row.firstAt < group.firstAt) group.firstAt = row.firstAt;
      if (row.lastAt > group.lastAt) group.lastAt = row.lastAt;
    }
    return [...held.values()];
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
export function usageByDay(period: UsagePeriod, filter: StatsFilter, grain = usageGrain(period, filter)): UsageDayGroup[] {
  try {
    return [...fold(grain, (row) => keyOf(row.date, row.model, row.baseUrl, row.providerKey)).values()].map(({ group, first }) => ({
      ...group,
      date: first.date,
    }));
  } catch (err) {
    void log("warn", "analytics usageByDay failed", { error: String(err) });
    return [];
  }
}

/**
 * What the filter sheet offers, folded off the same grain: the option list of a page that is not
 * narrowed costs no second scan.
 */
export function facetsOfGrain(rows: readonly UsageGrainRow[]): UsageFacets {
  const distinct = (values: Iterable<string>): string[] => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  return {
    models: distinct(rows.map((row) => row.model)),
    providers: distinct(rows.map((row) => row.providerKey ?? UNKNOWN_PROVIDER)),
    callers: distinct(rows.map((row) => row.caller)),
    sessionIds: distinct(rows.map((row) => row.sessionId)),
    workspaces: distinct(rows.map((row) => row.workspace ?? UNKNOWN_WORKSPACE)),
    folderIds: distinct(rows.map((row) => row.folderId ?? NO_FOLDER)),
  };
}
