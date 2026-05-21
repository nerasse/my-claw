import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Use a temp dir so tests don't touch the real analytics DB
const TEST_DIR = join("/tmp/opencode", `analytics-test-${Date.now()}`);
const TEST_DB_PATH = join(TEST_DIR, "analytics.db");

// We can't easily mock MY_CLAW_DIR in the module, so we test the DB logic directly
// using the same schema as usage-db.ts

let db: Database;

function createSchema(d: Database): void {
  d.exec("PRAGMA journal_mode = WAL");
  d.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_api_calls_timestamp ON api_calls (timestamp);
    CREATE INDEX IF NOT EXISTS idx_api_calls_session   ON api_calls (session_id);
    CREATE INDEX IF NOT EXISTS idx_api_calls_model     ON api_calls (model);
    CREATE INDEX IF NOT EXISTS idx_api_calls_platform  ON api_calls (platform);
    CREATE INDEX IF NOT EXISTS idx_api_calls_caller    ON api_calls (caller);
  `);
}

function insertRow(d: Database, overrides: Partial<Record<string, unknown>> = {}): void {
  const defaults = {
    session_id: "test/session",
    platform: "telegram",
    model: "test-model",
    base_url: "https://api.example.com",
    streaming: 0,
    caller: "orchestrator",
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    tool_calls: 0,
    iteration: 1,
    duration_ms: 500,
    error: null,
  };
  const row = { ...defaults, ...overrides };
  d.prepare(`
    INSERT INTO api_calls (
      session_id, platform, model, base_url, streaming, caller,
      prompt_tokens, completion_tokens, total_tokens,
      tool_calls, iteration, duration_ms, error
    ) VALUES (
      $session_id, $platform, $model, $base_url, $streaming, $caller,
      $prompt_tokens, $completion_tokens, $total_tokens,
      $tool_calls, $iteration, $duration_ms, $error
    )
  `).run({
    $session_id: row.session_id,
    $platform: row.platform,
    $model: row.model,
    $base_url: row.base_url,
    $streaming: row.streaming,
    $caller: row.caller,
    $prompt_tokens: row.prompt_tokens,
    $completion_tokens: row.completion_tokens,
    $total_tokens: row.total_tokens,
    $tool_calls: row.tool_calls,
    $iteration: row.iteration,
    $duration_ms: row.duration_ms,
    $error: row.error,
  });
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(TEST_DB_PATH, { create: true });
  createSchema(db);
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("schema creates table and indexes", () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_calls'").all();
  assert.equal(tables.length, 1);

  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_api_calls_%'").all();
  assert.equal(indexes.length, 5);
});

test("insert a row and read it back", () => {
  insertRow(db, { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 });

  const rows = db.prepare("SELECT * FROM api_calls").all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.prompt_tokens, 200);
  assert.equal(rows[0]!.completion_tokens, 80);
  assert.equal(rows[0]!.total_tokens, 280);
  assert.equal(rows[0]!.session_id, "test/session");
  assert.equal(rows[0]!.caller, "orchestrator");
});

test("timestamp is auto-generated", () => {
  insertRow(db);
  const row = db.prepare("SELECT timestamp FROM api_calls").get() as { timestamp: string };
  assert.ok(row.timestamp);
  assert.ok(row.timestamp.includes("T"));
  assert.ok(row.timestamp.endsWith("Z"));
});

test("multiple rows with different callers", () => {
  insertRow(db, { caller: "orchestrator", prompt_tokens: 100 });
  insertRow(db, { caller: "subagent", prompt_tokens: 200 });
  insertRow(db, { caller: "compaction", prompt_tokens: 50 });
  insertRow(db, { caller: "browser", prompt_tokens: 300 });

  const byCaller = db.prepare(
    "SELECT caller, sum(prompt_tokens) as total_in FROM api_calls GROUP BY caller ORDER BY caller"
  ).all() as Array<{ caller: string; total_in: number }>;

  assert.equal(byCaller.length, 4);
  assert.equal(byCaller.find((r) => r.caller === "browser")!.total_in, 300);
  assert.equal(byCaller.find((r) => r.caller === "compaction")!.total_in, 50);
});

test("aggregation queries work", () => {
  insertRow(db, { session_id: "s1", model: "model-a", total_tokens: 100, duration_ms: 200 });
  insertRow(db, { session_id: "s1", model: "model-a", total_tokens: 150, duration_ms: 300 });
  insertRow(db, { session_id: "s2", model: "model-b", total_tokens: 400, duration_ms: 100 });

  // Total by session
  const bySession = db.prepare(
    "SELECT session_id, sum(total_tokens) as tokens, count(*) as calls FROM api_calls GROUP BY session_id ORDER BY tokens DESC"
  ).all() as Array<{ session_id: string; tokens: number; calls: number }>;
  assert.equal(bySession[0]!.session_id, "s2");
  assert.equal(bySession[0]!.tokens, 400);
  assert.equal(bySession[1]!.session_id, "s1");
  assert.equal(bySession[1]!.tokens, 250);
  assert.equal(bySession[1]!.calls, 2);

  // Avg latency
  const avgLatency = db.prepare(
    "SELECT avg(duration_ms) as avg_ms FROM api_calls"
  ).get() as { avg_ms: number };
  assert.equal(avgLatency.avg_ms, 200);
});

test("error field is nullable", () => {
  insertRow(db, { error: null });
  insertRow(db, { error: "LLM request failed: HTTP 500" });

  const rows = db.prepare("SELECT error FROM api_calls ORDER BY id").all() as Array<{ error: string | null }>;
  assert.equal(rows[0]!.error, null);
  assert.equal(rows[1]!.error, "LLM request failed: HTTP 500");
});

test("streaming flag stores as 0/1", () => {
  insertRow(db, { streaming: 0 });
  insertRow(db, { streaming: 1 });

  const rows = db.prepare("SELECT streaming FROM api_calls ORDER BY id").all() as Array<{ streaming: number }>;
  assert.equal(rows[0]!.streaming, 0);
  assert.equal(rows[1]!.streaming, 1);
});

test("zero tokens are valid", () => {
  insertRow(db, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  const row = db.prepare("SELECT * FROM api_calls").get() as Record<string, unknown>;
  assert.equal(row.prompt_tokens, 0);
  assert.equal(row.completion_tokens, 0);
  assert.equal(row.total_tokens, 0);
});

test("getSessionUsage logic: aggregates calls, tokens, and errors per session", () => {
  insertRow(db, { session_id: "s1", prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, duration_ms: 200, error: null });
  insertRow(db, { session_id: "s1", prompt_tokens: 80, completion_tokens: 40, total_tokens: 120, duration_ms: 300, error: null });
  insertRow(db, { session_id: "s1", prompt_tokens: 60, completion_tokens: 30, total_tokens: 90, duration_ms: 100, error: "HTTP 500" });
  insertRow(db, { session_id: "s2", prompt_tokens: 999, completion_tokens: 999, total_tokens: 1998, duration_ms: 999, error: null });

  const row = db.prepare(
    `SELECT
       COUNT(*)              AS total_calls,
       SUM(total_tokens)     AS total_tokens,
       SUM(prompt_tokens)    AS prompt_tokens,
       SUM(completion_tokens) AS completion_tokens,
       SUM(duration_ms)      AS total_duration_ms,
       SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS error_count
     FROM api_calls WHERE session_id = ?`
  ).get("s1") as Record<string, number>;

  assert.equal(row["total_calls"], 3);
  assert.equal(row["prompt_tokens"], 240);
  assert.equal(row["completion_tokens"], 120);
  assert.equal(row["total_tokens"], 360);
  assert.equal(row["total_duration_ms"], 600);
  assert.equal(row["error_count"], 1);
});

test("getDailySummary logic: groups rows by date with distinct models", () => {
  const day1 = "2025-06-01T10:00:00.000Z";
  const day2 = "2025-06-02T14:00:00.000Z";

  db.prepare(
    `INSERT INTO api_calls (timestamp, session_id, platform, model, base_url, prompt_tokens, completion_tokens, total_tokens, duration_ms)
     VALUES (?, 's1', 'telegram', 'model-a', 'https://api.example.com', 100, 50, 150, 200)`
  ).run(day1);
  db.prepare(
    `INSERT INTO api_calls (timestamp, session_id, platform, model, base_url, prompt_tokens, completion_tokens, total_tokens, duration_ms)
     VALUES (?, 's1', 'telegram', 'model-b', 'https://api.example.com', 200, 100, 300, 400)`
  ).run(day1);
  db.prepare(
    `INSERT INTO api_calls (timestamp, session_id, platform, model, base_url, prompt_tokens, completion_tokens, total_tokens, duration_ms)
     VALUES (?, 's2', 'matrix', 'model-a', 'https://api.example.com', 50, 25, 75, 100)`
  ).run(day2);

  const rows = db.prepare(
    `SELECT
       DATE(timestamp) AS date,
       COUNT(*)        AS calls,
       SUM(total_tokens) AS total_tokens,
       GROUP_CONCAT(DISTINCT model) AS models
     FROM api_calls
     WHERE DATE(timestamp) >= ?
     GROUP BY DATE(timestamp)
     ORDER BY date DESC`
  ).all("2025-01-01") as Array<Record<string, unknown>>;

  assert.equal(rows.length, 2);
  assert.equal(rows[0]!["date"], "2025-06-02");
  assert.equal(rows[0]!["calls"], 1);
  assert.equal(rows[0]!["total_tokens"], 75);
  assert.equal(rows[1]!["date"], "2025-06-01");
  assert.equal(rows[1]!["calls"], 2);
  assert.equal(rows[1]!["total_tokens"], 450);
  const day1Models = String(rows[1]!["models"]).split(",").sort();
  assert.deepEqual(day1Models, ["model-a", "model-b"]);
});

test("getModelUsage logic: aggregates calls, tokens, and avg duration per model", () => {
  insertRow(db, { model: "gpt-4", total_tokens: 200, duration_ms: 100 });
  insertRow(db, { model: "gpt-4", total_tokens: 300, duration_ms: 200 });
  insertRow(db, { model: "claude", total_tokens: 500, duration_ms: 150 });

  const rows = db.prepare(
    `SELECT
       model,
       COUNT(*)           AS calls,
       SUM(total_tokens)  AS total_tokens,
       AVG(duration_ms)   AS avg_duration_ms
     FROM api_calls
     GROUP BY model
     ORDER BY total_tokens DESC`
  ).all() as Array<Record<string, unknown>>;

  assert.equal(rows.length, 2);
  assert.equal(rows[0]!["model"], "claude");
  assert.equal(rows[0]!["calls"], 1);
  assert.equal(rows[0]!["total_tokens"], 500);
  assert.equal(Math.round(Number(rows[0]!["avg_duration_ms"])), 150);
  assert.equal(rows[1]!["model"], "gpt-4");
  assert.equal(rows[1]!["calls"], 2);
  assert.equal(rows[1]!["total_tokens"], 500);
  assert.equal(Math.round(Number(rows[1]!["avg_duration_ms"])), 150);
});
