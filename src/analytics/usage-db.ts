import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { MY_CLAW_DIR } from "../core/config.ts";

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
  } catch {
    // analytics should never break the agent
  }
}

const RETENTION_DAYS = 90;

export function pruneOldRecords(): void {
  try {
    const d = getDb();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    d.run("DELETE FROM api_calls WHERE timestamp < ?", [cutoff]);
  } catch {
    // best-effort
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
