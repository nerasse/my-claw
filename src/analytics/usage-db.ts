import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";

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

  return db;
}

export interface ApiCallRecord {
  sessionId: string;
  platform: string;
  model: string;
  baseUrl: string;
  streaming: boolean;
  caller: "orchestrator" | "subagent" | "compaction" | "browser";

  promptTokens: number;
  completionTokens: number;
  totalTokens: number;

  toolCalls: number;
  iteration: number;
  durationMs: number;

  error?: string;
}

let insertStmt: ReturnType<Database["prepare"]> | null = null;

export function recordApiCall(record: ApiCallRecord): void {
  try {
    const d = getDb();
    if (!insertStmt) {
      insertStmt = d.prepare(`
        INSERT INTO api_calls (
          session_id, platform, model, base_url, streaming, caller,
          prompt_tokens, completion_tokens, total_tokens,
          tool_calls, iteration, duration_ms, error
        ) VALUES (
          $session_id, $platform, $model, $base_url, $streaming, $caller,
          $prompt_tokens, $completion_tokens, $total_tokens,
          $tool_calls, $iteration, $duration_ms, $error
        )
      `);
    }
    insertStmt.run({
      $session_id: record.sessionId,
      $platform: record.platform,
      $model: record.model,
      $base_url: record.baseUrl,
      $streaming: record.streaming ? 1 : 0,
      $caller: record.caller,
      $prompt_tokens: record.promptTokens,
      $completion_tokens: record.completionTokens,
      $total_tokens: record.totalTokens,
      $tool_calls: record.toolCalls,
      $iteration: record.iteration,
      $duration_ms: record.durationMs,
      $error: record.error ?? null,
    });
  } catch (err) {
    void log("warn", "analytics recordApiCall failed", { error: String(err) });
  }
}

const RETENTION_DAYS = 90;

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
