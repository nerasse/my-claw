import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { sharedPricing, type CostBreakdown } from "../llm/pricing.ts";

const DB_PATH = join(MY_CLAW_DIR, "analytics.db");

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  mkdirSync(MY_CLAW_DIR, { recursive: true });
  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 3000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_calls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      session_id  TEXT    NOT NULL,
      platform    TEXT    NOT NULL,
      model       TEXT    NOT NULL,
      base_url    TEXT    NOT NULL,
      streaming   INTEGER NOT NULL DEFAULT 0,
      caller      TEXT    NOT NULL DEFAULT 'orchestrator',

      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0,

      tool_calls  INTEGER NOT NULL DEFAULT 0,
      iteration   INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,

      error       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_api_calls_timestamp   ON api_calls (timestamp);
    CREATE INDEX IF NOT EXISTS idx_api_calls_session      ON api_calls (session_id);
    CREATE INDEX IF NOT EXISTS idx_api_calls_model        ON api_calls (model);
    CREATE INDEX IF NOT EXISTS idx_api_calls_platform     ON api_calls (platform);
    CREATE INDEX IF NOT EXISTS idx_api_calls_caller       ON api_calls (caller);

    CREATE TABLE IF NOT EXISTS usage_monthly (
      month       TEXT NOT NULL,
      model       TEXT NOT NULL,
      base_url    TEXT NOT NULL,
      platform    TEXT NOT NULL,
      caller      TEXT NOT NULL,

      calls              INTEGER NOT NULL DEFAULT 0,
      prompt_tokens      INTEGER NOT NULL DEFAULT 0,
      completion_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,

      -- billed_usd is what was charged, and only ever what was charged: a price the purge had to
      -- compute is a catalogue rate, so it lands in reference_usd. unpriced_calls is what no rung
      -- of the ladder could price even then.
      billed_usd     REAL    NOT NULL DEFAULT 0,
      reference_usd  REAL    NOT NULL DEFAULT 0,
      unpriced_calls INTEGER NOT NULL DEFAULT 0,

      errors      INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,

      PRIMARY KEY (month, model, base_url, platform, caller)
    );
  `);

  // Columns added after the table shipped. CREATE TABLE IF NOT EXISTS never re-runs, so an
  // existing analytics.db would keep the old shape and every INSERT would fail -- silently,
  // because recordApiCall swallows its errors.
  ensureColumn(db, "api_calls", "parent_session_id", "TEXT");
  ensureColumn(db, "api_calls", "cache_read_tokens", "INTEGER");
  ensureColumn(db, "api_calls", "cache_write_tokens", "INTEGER");
  ensureColumn(db, "api_calls", "upstream_api_base", "TEXT");
  ensureColumn(db, "api_calls", "proxy_cost_usd", "REAL");
  // Which wire protocol answered. Not derivable from base_url after the fact: a couple of hosts
  // name a transport (`chatgpt.com/backend-api`, the retired `claude-sdk`) while every other one
  // names a reseller that could be fronting any engine, so auditing cache behaviour by URL
  // misreads the data -- which is exactly how it was once misread.
  ensureColumn(db, "api_calls", "backend", "TEXT");
  // The dialect the request actually used, so a cache regression can be traced to the hint that
  // was sent rather than inferred from the model name months later.
  ensureColumn(db, "api_calls", "cache_dialect", "TEXT");
  // The money this call was charged, frozen when the row was written, with the rung that produced
  // it. Resolving a call against a table refetched since answers "what would this cost today", and
  // the models.dev file is one copy overwritten every 24 h with no history: without these columns a
  // provider changing its price silently restates up to 90 days of spend. The per-token tariff is
  // not stored -- it is recoverable from this and the token columns, and it is the money that must
  // not move. Rows written before the columns existed carry NULL and are priced live, as they always
  // were. See docs/status-command.md.
  ensureColumn(db, "api_calls", "cost_usd", "REAL");
  ensureColumn(db, "api_calls", "cost_billed", "INTEGER");
  ensureColumn(db, "api_calls", "cost_approximate", "INTEGER");
  ensureColumn(db, "api_calls", "cost_source", "TEXT");
  // Where the call ran from and what it was filed as, both at call time. A conversation changes
  // workspace (applies from the next run) and gets re-filed (a folder is a place) -- a column is
  // the only way the history survives either move. Both NULL on rows older than these columns:
  // an invented workspace is worse than an unknown one. The rollup key has neither, so a filter
  // set to one of them drops the rollup like `session_id` does. docs/stats-page.md.
  ensureColumn(db, "api_calls", "workspace", "TEXT");
  ensureColumn(db, "api_calls", "folder_id", "TEXT");

  // Must come after ensureColumn: an index on a column the table does not have yet would throw,
  // and inside the block above it would take the whole statement down with it.
  db.exec("CREATE INDEX IF NOT EXISTS idx_api_calls_parent ON api_calls (parent_session_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_api_calls_workspace ON api_calls (workspace)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_api_calls_folder ON api_calls (folder_id)");

  return db;
}

/**
 * The one open handle on the analytics, for the query layer that lives beside this file.
 *
 * Shared rather than reopened: the module holds a WAL connection and a prepared insert, and a
 * second handle on the same file would sit behind the same write lock for no gain.
 */
export function analyticsDb(): Database {
  return getDb();
}

/** Add a column to an existing table if a prior schema version lacks it. */
function ensureColumn(d: Database, table: string, column: string, type: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export interface ApiCallRecord {
  sessionId: string;
  // Session this call is billed to. A sub-agent or browser run charges the session that drove it,
  // so a chat's real cost includes the work it delegated. A top-level chat records itself.
  parentSessionId?: string;
  platform: string;
  model: string;
  baseUrl: string;
  streaming: boolean;
  caller: "orchestrator" | "subagent" | "compaction" | "compaction-speculative" | "browser";

  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // Subsets of promptTokens, billed at a different rate -- often two orders of magnitude cheaper,
  // so a cost computed without them is meaningless rather than merely imprecise.
  cacheReadTokens?: number;
  cacheWriteTokens?: number;

  toolCalls: number;
  iteration: number;
  durationMs: number;

  // What a billing proxy said this call cost, and which endpoint it forwarded to. Authoritative
  // when present; the price table is the fallback.
  proxyCostUsd?: number;
  upstreamApiBase?: string;

  // The transport that ran the call and the prompt-cache dialect it spoke. Recorded rather than
  // inferred: see the column comments in the schema.
  backend?: string;
  cacheDialect?: string;

  // Where the call ran from: a workspace key of config.workspaces, "default", or a directory
  // outside all of them. Absent on rows written before the column existed.
  workspace?: string;
  // The folder of the conversation this call is billed to, as of the call. Never a session's
  // current folder: moving a conversation re-files its future, not its past.
  folderId?: string;

  error?: string;
}

let insertStmt: ReturnType<Database["prepare"]> | null = null;

/**
 * The cost this call is charged, resolved once and kept on the row.
 *
 * Undefined before boot (no table registered) and for a model no rung can price -- the row then
 * stores nothing and the report prices it live, which is what every row did before.
 */
function pinnedCostFor(record: ApiCallRecord): CostBreakdown | undefined {
  const pricing = sharedPricing();
  if (!pricing) return undefined;
  return pricing.costOf({
    model: record.model,
    baseUrl: record.baseUrl,
    promptTokens: record.promptTokens ?? 0,
    completionTokens: record.completionTokens ?? 0,
    cacheReadTokens: record.cacheReadTokens ?? 0,
    cacheWriteTokens: record.cacheWriteTokens ?? 0,
    ...(record.upstreamApiBase === undefined ? {} : { upstreamApiBase: record.upstreamApiBase }),
    ...(record.proxyCostUsd === undefined ? {} : { proxyCostUsd: record.proxyCostUsd }),
  });
}

/** The cost a stored row was recorded with, or undefined when it predates the columns. */
function pinnedCostOf(row: {
  cost_usd: number | null;
  cost_billed: number | null;
  cost_approximate: number | null;
  cost_source: string | null;
}): CostBreakdown | undefined {
  if (row.cost_usd === null) return undefined;
  return {
    usd: row.cost_usd,
    billed: row.cost_billed === 1,
    approximate: row.cost_approximate === 1,
    source: row.cost_source ?? "unknown",
  };
}

export function recordApiCall(record: ApiCallRecord): void {
  try {
    const d = getDb();
    const cost = pinnedCostFor(record);
    if (!insertStmt) {
      insertStmt = d.prepare(`
        INSERT INTO api_calls (
          session_id, parent_session_id, platform, model, base_url, streaming, caller,
          prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cache_write_tokens,
          tool_calls, iteration, duration_ms, proxy_cost_usd, upstream_api_base, backend,
          cache_dialect, error, workspace, folder_id,
          cost_usd, cost_billed, cost_approximate, cost_source
        ) VALUES (
          $session_id, $parent_session_id, $platform, $model, $base_url, $streaming, $caller,
          $prompt_tokens, $completion_tokens, $total_tokens, $cache_read_tokens, $cache_write_tokens,
          $tool_calls, $iteration, $duration_ms, $proxy_cost_usd, $upstream_api_base, $backend,
          $cache_dialect, $error, $workspace, $folder_id,
          $cost_usd, $cost_billed, $cost_approximate, $cost_source
        )
      `);
    }
    insertStmt.run({
      $session_id: record.sessionId,
      $parent_session_id: record.parentSessionId ?? record.sessionId,
      $platform: record.platform,
      $model: record.model,
      $base_url: record.baseUrl,
      $streaming: record.streaming ? 1 : 0,
      $caller: record.caller,
      // Coerced because bun:sqlite rejects an undefined binding by throwing, and this function
      // swallows its errors: one caller with a missing field would silently stop all recording.
      $prompt_tokens: record.promptTokens ?? 0,
      $completion_tokens: record.completionTokens ?? 0,
      $total_tokens: record.totalTokens ?? (record.promptTokens ?? 0) + (record.completionTokens ?? 0),
      $cache_read_tokens: record.cacheReadTokens ?? 0,
      $cache_write_tokens: record.cacheWriteTokens ?? 0,
      $tool_calls: record.toolCalls ?? 0,
      $iteration: record.iteration ?? 0,
      $duration_ms: record.durationMs ?? 0,
      $proxy_cost_usd: record.proxyCostUsd ?? null,
      $upstream_api_base: record.upstreamApiBase ?? null,
      $backend: record.backend ?? null,
      $cache_dialect: record.cacheDialect ?? null,
      $error: record.error ?? null,
      $workspace: record.workspace ?? null,
      $folder_id: record.folderId ?? null,
      $cost_usd: cost?.usd ?? null,
      $cost_billed: cost === undefined ? null : cost.billed ? 1 : 0,
      $cost_approximate: cost === undefined ? null : cost.approximate ? 1 : 0,
      $cost_source: cost?.source ?? null,
    });
  } catch (err) {
    void log("warn", "analytics recordApiCall failed", { error: String(err) });
    return;
  }
  // The one moment a conversation's spend moves: what follows the money (the status page) hangs
  // on this rather than on each of the three call sites that write a row.
  hooks.emit("analytics:call:recorded", { sessionId: record.sessionId, parentSessionId: record.parentSessionId ?? record.sessionId });
}

/**
 * Where the two halves of a global report start.
 *
 * `detailSince` is the oldest per-call row left on disk: every view that needs a session, a day or
 * an hour stops there, because that is where the rows that carry them stop. `totalsSince` is the
 * first month the rollup holds, and the totals reach back to it whatever the purge has swept.
 *
 * A page that shows one figure for both is lying about one of them, which is the whole reason this
 * is on the payload rather than inferred from the period.
 */
export interface UsageHorizon {
  detailSince?: string;
  totalsSince?: string;
}

export function usageHorizon(): UsageHorizon {
  try {
    const d = getDb();
    const detail = d.prepare("SELECT MIN(timestamp) AS at FROM api_calls").get() as { at: string | null } | null;
    const rollup = d.prepare("SELECT MIN(month) AS month FROM usage_monthly").get() as { month: string | null } | null;
    return {
      ...(detail?.at ? { detailSince: detail.at } : {}),
      ...(rollup?.month ? { totalsSince: rollup.month } : {}),
    };
  } catch (err) {
    void log("warn", "analytics usageHorizon failed", { error: String(err) });
    return {};
  }
}

export interface UsageSummary {
  totalCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalDurationMs: number;
  errorCount: number;
}

/** One model as used by one session, with everything needed to price it. */
export interface SessionModelRow {
  model: string;
  baseUrl: string;
  upstreamApiBase: string | null;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  proxyCostUsd: number | null;
  errorCount: number;
  lastUsedAt: string;
  /**
   * The money this group was actually charged, frozen as each call was recorded. Absent when the
   * group cannot be pinned -- see `withPinnedCost`.
   */
  pinnedCost?: CostBreakdown;
}

/** A group's raw aggregate, before the frozen-cost decision is made. */
interface AggregatedModelRow extends SessionModelRow {
  pinnedUsd: number | null;
  pinnedRows: number;
  costSources: number;
  costSource: string | null;
  costBilled: number | null;
  costApproximate: number | null;
}

/**
 * The frozen money of a group, when it can be trusted.
 *
 * Only when every call in the group was recorded with a cost, and all of them came from one rung of
 * the ladder. A group half-written before the columns existed would otherwise report a total
 * covering part of its tokens, which reads as a cheap model rather than as a partial sum -- and a
 * group spanning two rungs has two markers (`*` not a charge) that no single row can carry.
 */
function withPinnedCost(row: AggregatedModelRow): SessionModelRow {
  const { model, baseUrl, upstreamApiBase, calls, promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens, proxyCostUsd, errorCount, lastUsedAt } = row;
  const out: SessionModelRow = {
    model,
    baseUrl,
    upstreamApiBase,
    calls,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    proxyCostUsd,
    errorCount,
    lastUsedAt,
  };
  if (row.pinnedUsd === null || row.pinnedRows !== calls || row.costSources !== 1) return out;
  out.pinnedCost = {
    usd: row.pinnedUsd,
    billed: row.costBilled === 1,
    approximate: row.costApproximate === 1,
    source: row.costSource ?? "unknown",
  };
  return out;
}

/**
 * Per-model breakdown for one session, grouped by endpoint as well as by model: the same model id
 * reached through two different providers is billed at two different rates, so collapsing them
 * would make the total unpriceable.
 *
 * `own` counts what the session ran itself; `delegated` counts what it spawned. They are separate
 * because a chat's own tokens and the tokens of the sub-agents it drove answer different questions.
 */
export function getSessionModelUsage(sessionId: string, scope: "own" | "delegated"): SessionModelRow[] {
  const where = scope === "own" ? "session_id = ?" : "parent_session_id = ? AND session_id <> parent_session_id";
  try {
    const d = getDb();
    const rows = d
      .prepare(
        `SELECT
           model,
           base_url                        AS baseUrl,
           MAX(upstream_api_base)          AS upstreamApiBase,
           COUNT(*)                        AS calls,
           COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
           COALESCE(SUM(completion_tokens), 0) AS completionTokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
           SUM(proxy_cost_usd)             AS proxyCostUsd,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errorCount,
           MAX(timestamp)                  AS lastUsedAt,
           SUM(cost_usd)                   AS pinnedUsd,
           COUNT(cost_usd)                 AS pinnedRows,
           COUNT(DISTINCT cost_source)     AS costSources,
           MAX(cost_source)                AS costSource,
           MAX(cost_billed)                AS costBilled,
           MAX(cost_approximate)           AS costApproximate
         FROM api_calls
         WHERE ${where}
         GROUP BY model, base_url
         ORDER BY SUM(total_tokens) DESC`,
      )
      .all(sessionId) as AggregatedModelRow[];
    return rows.map(withPinnedCost);
  } catch (err) {
    void log("warn", "analytics getSessionModelUsage failed", { error: String(err) });
    return [];
  }
}

/** One model as one delegated session used it, on the paying conversation's behalf. */
export interface DelegatedModelRow extends SessionModelRow {
  sessionId: string;
}

/**
 * What the sessions a conversation drove have spent for it, per session and per model: the
 * payer of a call is the parent recorded on its row, so a named sub-agent driven from two
 * conversations shows each of them its own share and nothing of the other's.
 */
export function getDelegatedModelUsage(parentSessionId: string): DelegatedModelRow[] {
  try {
    const d = getDb();
    const rows = d
      .prepare(
        `SELECT
           session_id                      AS sessionId,
           model,
           base_url                        AS baseUrl,
           MAX(upstream_api_base)          AS upstreamApiBase,
           COUNT(*)                        AS calls,
           COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
           COALESCE(SUM(completion_tokens), 0) AS completionTokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
           SUM(proxy_cost_usd)             AS proxyCostUsd,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errorCount,
           MAX(timestamp)                  AS lastUsedAt,
           SUM(cost_usd)                   AS pinnedUsd,
           COUNT(cost_usd)                 AS pinnedRows,
           COUNT(DISTINCT cost_source)     AS costSources,
           MAX(cost_source)                AS costSource,
           MAX(cost_billed)                AS costBilled,
           MAX(cost_approximate)           AS costApproximate
         FROM api_calls
         WHERE parent_session_id = ? AND session_id <> parent_session_id
         GROUP BY session_id, model, base_url
         ORDER BY MAX(timestamp) DESC, SUM(total_tokens) DESC`,
      )
      .all(parentSessionId) as Array<AggregatedModelRow & { sessionId: string }>;
    return rows.map((row) => ({ ...withPinnedCost(row), sessionId: row.sessionId }));
  } catch (err) {
    void log("warn", "analytics getDelegatedModelUsage failed", { error: String(err) });
    return [];
  }
}

/**
 * Input tokens the provider counted on the most recent successful call. This is the only measured
 * context occupancy available: everything else in the codebase estimates it from character counts.
 */
export function getLastContextTokens(sessionId: string): { promptTokens: number; model: string; at: string } | null {
  try {
    const d = getDb();
    const row = d
      .prepare(
        `SELECT prompt_tokens AS promptTokens, model, timestamp AS at
         FROM api_calls
         WHERE session_id = ? AND error IS NULL AND prompt_tokens > 0
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(sessionId) as { promptTokens: number; model: string; at: string } | null;
    return row ?? null;
  } catch (err) {
    void log("warn", "analytics getLastContextTokens failed", { error: String(err) });
    return null;
  }
}

export function getSessionUsage(sessionId: string): UsageSummary | null {
  try {
    const d = getDb();
    const row = d
      .prepare(
        `SELECT
           COUNT(*)              AS total_calls,
           SUM(total_tokens)     AS total_tokens,
           SUM(prompt_tokens)    AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(duration_ms)      AS total_duration_ms,
           SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS error_count
         FROM api_calls WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, number> | null;
    if (!row || row["total_calls"] === 0) return null;
    return {
      totalCalls: row["total_calls"]!,
      totalTokens: row["total_tokens"]!,
      promptTokens: row["prompt_tokens"]!,
      completionTokens: row["completion_tokens"]!,
      totalDurationMs: row["total_duration_ms"]!,
      errorCount: row["error_count"]!,
    };
  } catch (err) {
    void log("warn", "analytics getSessionUsage failed", { error: String(err) });
    return null;
  }
}

export interface DailySummaryRow {
  date: string;
  calls: number;
  totalTokens: number;
  models: string;
}

export function getDailySummary(days = 30): DailySummaryRow[] {
  try {
    const d = getDb();
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const rows = d
      .prepare(
        `SELECT
           DATE(timestamp) AS date,
           COUNT(*)        AS calls,
           SUM(total_tokens) AS total_tokens,
           GROUP_CONCAT(DISTINCT model) AS models
         FROM api_calls
         WHERE DATE(timestamp) >= ?
         GROUP BY DATE(timestamp)
         ORDER BY date DESC`,
      )
      .all(cutoff) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      date: String(r["date"]),
      calls: Number(r["calls"]),
      totalTokens: Number(r["total_tokens"]),
      models: String(r["models"]),
    }));
  } catch (err) {
    void log("warn", "analytics getDailySummary failed", { error: String(err) });
    return [];
  }
}

export interface ModelUsageRow {
  model: string;
  calls: number;
  totalTokens: number;
  avgDurationMs: number;
}

export function getModelUsage(): ModelUsageRow[] {
  try {
    const d = getDb();
    const rows = d
      .prepare(
        `SELECT
           model,
           COUNT(*)           AS calls,
           SUM(total_tokens)  AS total_tokens,
           AVG(duration_ms)   AS avg_duration_ms
         FROM api_calls
         GROUP BY model
         ORDER BY total_tokens DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      model: String(r["model"]),
      calls: Number(r["calls"]),
      totalTokens: Number(r["total_tokens"]),
      avgDurationMs: Math.round(Number(r["avg_duration_ms"])),
    }));
  } catch (err) {
    void log("warn", "analytics getModelUsage failed", { error: String(err) });
    return [];
  }
}

export function closeDb(): void {
  if (insertStmt) {
    insertStmt.finalize();
    insertStmt = null;
  }
  if (db) {
    db.close();
    db = null;
  }
}
