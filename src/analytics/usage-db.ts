import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";

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

  // Must come after ensureColumn: an index on a column the table does not have yet would throw,
  // and inside the block above it would take the whole statement down with it.
  db.exec("CREATE INDEX IF NOT EXISTS idx_api_calls_parent ON api_calls (parent_session_id)");

  return db;
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

  error?: string;
}

let insertStmt: ReturnType<Database["prepare"]> | null = null;

export function recordApiCall(record: ApiCallRecord): void {
  try {
    const d = getDb();
    if (!insertStmt) {
      insertStmt = d.prepare(`
        INSERT INTO api_calls (
          session_id, parent_session_id, platform, model, base_url, streaming, caller,
          prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cache_write_tokens,
          tool_calls, iteration, duration_ms, proxy_cost_usd, upstream_api_base, backend,
          cache_dialect, error
        ) VALUES (
          $session_id, $parent_session_id, $platform, $model, $base_url, $streaming, $caller,
          $prompt_tokens, $completion_tokens, $total_tokens, $cache_read_tokens, $cache_write_tokens,
          $tool_calls, $iteration, $duration_ms, $proxy_cost_usd, $upstream_api_base, $backend,
          $cache_dialect, $error
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
    });
  } catch (err) {
    void log("warn", "analytics recordApiCall failed", { error: String(err) });
    return;
  }
  // The one moment a conversation's spend moves: what follows the money (the status page) hangs
  // on this rather than on each of the three call sites that write a row.
  hooks.emit("analytics:call:recorded", { sessionId: record.sessionId, parentSessionId: record.parentSessionId ?? record.sessionId });
}

/** How far back the analytics reach: rows older than this are swept at boot. */
export const RETENTION_DAYS = 90;

export function pruneOldRecords(): void {
  try {
    const d = getDb();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    d.run("DELETE FROM api_calls WHERE timestamp < ?", [cutoff]);
  } catch (err) {
    void log("warn", "analytics pruneOldRecords failed", { error: String(err) });
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
    return d
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
           MAX(timestamp)                  AS lastUsedAt
         FROM api_calls
         WHERE ${where}
         GROUP BY model, base_url
         ORDER BY SUM(total_tokens) DESC`,
      )
      .all(sessionId) as SessionModelRow[];
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
    return d
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
           MAX(timestamp)                  AS lastUsedAt
         FROM api_calls
         WHERE parent_session_id = ? AND session_id <> parent_session_id
         GROUP BY session_id, model, base_url
         ORDER BY MAX(timestamp) DESC, SUM(total_tokens) DESC`,
      )
      .all(parentSessionId) as DelegatedModelRow[];
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
