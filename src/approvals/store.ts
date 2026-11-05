import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";

/**
 * What actually happened to an approval prompt. `allow-once` and `allow-session` are kept apart
 * on purpose: they are the same click for the owner but not the same grant, and the journal is
 * the only place that can say afterwards which one was given.
 *
 * `expired` is the timeout, `cancelled` the run going away under the prompt: neither is a
 * decision the owner made, and reading them as a refusal would blame him for a machine event.
 */
export type ApprovalOutcome = "allow-once" | "allow-session" | "allow-always" | "deny" | "expired" | "cancelled";

export interface ApprovalRecord {
  id: string;
  owner: string;
  threadId: string;
  sessionId: string;
  toolName: string;
  /** Serialized arguments, already redacted by the caller. */
  args: string;
  outcome: ApprovalOutcome;
  requestedAt: string;
  decidedAt: string;
  /** Milliseconds the prompt stayed on screen. */
  durationMs: number;
  /** Set when the grant came from an earlier `allow-session` instead of a fresh prompt. */
  auto: boolean;
}

export interface ApprovalHistoryOptions {
  owner: string;
  threadId?: string;
  limit?: number;
  before?: string;
}

type ApprovalRow = {
  id: string;
  owner: string;
  thread_id: string;
  session_id: string;
  tool_name: string;
  args: string;
  outcome: ApprovalOutcome;
  requested_at: string;
  decided_at: string;
  duration_ms: number;
  auto: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Arguments are evidence, not a payload: a 2 MB write tool call must not bloat the journal. */
const MAX_ARGS_CHARS = 4000;

let db: Database | null = null;

function databasePath(): string {
  return process.env["MY_CLAW_APPROVALS_DB"] ?? join(MY_CLAW_DIR, "approvals.db");
}

function getDb(): Database {
  if (db) return db;

  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id           TEXT PRIMARY KEY,
      owner        TEXT NOT NULL,
      thread_id    TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      tool_name    TEXT NOT NULL,
      args         TEXT NOT NULL,
      outcome      TEXT NOT NULL CHECK (outcome IN ('allow-once', 'allow-session', 'allow-always', 'deny', 'expired', 'cancelled')),
      requested_at TEXT NOT NULL,
      decided_at   TEXT NOT NULL,
      duration_ms  INTEGER NOT NULL,
      auto         INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_owner_time
      ON approvals(owner, decided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_approvals_thread_time
      ON approvals(owner, thread_id, decided_at DESC);
  `);
  migrateAllowAlways(db);
  return db;
}

/**
 * A database written before standing grants forbids `allow-always` at the schema level, and SQLite
 * cannot alter a CHECK: the table is rebuilt and copied, id and every column preserved. Guarded by
 * the stored SQL, so it runs once per install and never on a fresh one.
 */
function migrateAllowAlways(conn: Database): void {
  const row = conn
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'")
    .get() as { sql?: string } | null;
  if (!row?.sql || row.sql.includes("allow-always")) return;
  conn.exec("PRAGMA foreign_keys = OFF");
  conn.exec("BEGIN");
  try {
    conn.exec(`
      CREATE TABLE approvals_next (
        id           TEXT PRIMARY KEY,
        owner        TEXT NOT NULL,
        thread_id    TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        args         TEXT NOT NULL,
        outcome      TEXT NOT NULL CHECK (outcome IN ('allow-once', 'allow-session', 'allow-always', 'deny', 'expired', 'cancelled')),
        requested_at TEXT NOT NULL,
        decided_at   TEXT NOT NULL,
        duration_ms  INTEGER NOT NULL,
        auto         INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO approvals_next SELECT id, owner, thread_id, session_id, tool_name, args, outcome, requested_at, decided_at, duration_ms, auto FROM approvals;
      DROP TABLE approvals;
      ALTER TABLE approvals_next RENAME TO approvals;
      CREATE INDEX IF NOT EXISTS idx_approvals_owner_time ON approvals(owner, decided_at DESC);
      CREATE INDEX IF NOT EXISTS idx_approvals_thread_time ON approvals(owner, thread_id, decided_at DESC);
    `);
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  } finally {
    conn.exec("PRAGMA foreign_keys = ON");
  }
}

/** Truncation is marked, so a reader never mistakes a cut argument list for the whole call. */
export function serializeArgs(args: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? "{}";
  } catch {
    // A tool argument that cannot be serialized (cycle, BigInt) must not cost the audit trail.
    text = '{"__unserializable":true}';
  }
  if (text.length <= MAX_ARGS_CHARS) return text;
  return `${text.slice(0, MAX_ARGS_CHARS)}...[truncated ${text.length - MAX_ARGS_CHARS} chars]`;
}

/**
 * Records one decision. Idempotent on `id`: a device that answers twice (two windows, or a
 * reconnect replaying its outbox) must not write the same decision twice.
 */
export function recordApproval(record: ApprovalRecord): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO approvals
         (id, owner, thread_id, session_id, tool_name, args, outcome, requested_at, decided_at, duration_ms, auto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.owner,
      record.threadId,
      record.sessionId,
      record.toolName,
      record.args,
      record.outcome,
      record.requestedAt,
      record.decidedAt,
      Math.max(0, Math.round(record.durationMs)),
      record.auto ? 1 : 0,
    );
}

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    owner: row.owner,
    threadId: row.thread_id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    args: row.args,
    outcome: row.outcome,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    durationMs: Number(row.duration_ms),
    auto: row.auto === 1,
  };
}

/**
 * Newest first, always scoped to one owner: the journal is per-owner by construction, so a
 * device can never page into somebody else's decisions.
 */
export function listApprovals(options: ApprovalHistoryOptions): ApprovalRecord[] {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const params: unknown[] = [options.owner];
  let sql = "SELECT * FROM approvals WHERE owner = ?";
  if (options.threadId) {
    sql += " AND thread_id = ?";
    params.push(options.threadId);
  }
  if (options.before) {
    sql += " AND decided_at < ?";
    params.push(options.before);
  }
  sql += " ORDER BY decided_at DESC, rowid DESC LIMIT ?";
  params.push(limit);
  return (getDb().prepare(sql).all(...(params as never[])) as ApprovalRow[]).map(toRecord);
}

export interface ApprovalStats {
  total: number;
  allowed: number;
  denied: number;
  expired: number;
}

/** The counters behind the history header, computed in SQL rather than over a paged list. */
export function approvalStats(owner: string): ApprovalStats {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*)                                                          AS total,
         SUM(CASE WHEN outcome IN ('allow-once', 'allow-session') THEN 1 ELSE 0 END) AS allowed,
         SUM(CASE WHEN outcome = 'deny' THEN 1 ELSE 0 END)                 AS denied,
         SUM(CASE WHEN outcome IN ('expired', 'cancelled') THEN 1 ELSE 0 END) AS expired
       FROM approvals WHERE owner = ?`,
    )
    .get(owner) as { total: number | null; allowed: number | null; denied: number | null; expired: number | null };
  return {
    total: Number(row.total ?? 0),
    allowed: Number(row.allowed ?? 0),
    denied: Number(row.denied ?? 0),
    expired: Number(row.expired ?? 0),
  };
}

export function closeApprovalStore(): void {
  db?.close();
  db = null;
}
