import type { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { analyticsDb } from "./usage-db.ts";
import { periodCutoff, type UsagePeriod } from "./usage-stats.ts";

/**
 * One row per tool call the model made, in the analytics database beside `api_calls`.
 *
 * What it is for: telling whether a tool works for the model, not whether it ran. A failure here is
 * what the model was told was a failure, so a false one (a search that found nothing, a patch
 * refused for an unchanged block) is visible as a rate, and a fix to it shows as the rate dropping.
 * See docs/tool-telemetry.md.
 */

const BACKFILL_BEFORE = "tool_calls.backfill_before";
const BACKFILLED = "tool_calls.backfilled";

const ready = new WeakSet<Database>();

function db(): Database {
  const d = analyticsDb();
  if (ready.has(d)) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT    NOT NULL,
      session_id  TEXT    NOT NULL,
      caller      TEXT    NOT NULL,
      tool        TEXT    NOT NULL,
      ok          INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      outcome     TEXT,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls (timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session   ON tool_calls (session_id, timestamp);
    CREATE TABLE IF NOT EXISTS analytics_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Fixed once, the first time the table exists, and never moved: the backfill takes the logs
  // strictly before it and the live recorder everything after, so a restart halfway through the
  // backfill can neither double a call nor lose one.
  d.query("INSERT OR IGNORE INTO analytics_meta (key, value) VALUES (?, ?)").run(BACKFILL_BEFORE, new Date().toISOString());
  ready.add(d);
  return d;
}

export interface ToolCallRecord {
  sessionId: string;
  caller: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  /** ToolResult.outcome: a success read out of a non-zero exit or a partly empty request. */
  outcome?: string;
  /** What the model was told, on a failure. Stored as its kind, not verbatim. */
  error?: string;
  at?: string;
}

/**
 * The kind of a failure: its first line with the paths and the long numbers taken out, so the
 * same failure on two files is one row of the ranking and the table never holds file contents.
 */
export function errorKind(message: string): string {
  const first = message.replace(/^(?:Error:\s*)+/, "").split("\n", 1)[0] ?? "";
  return first
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)]+/gi, "<url>")
    .replace(/(?:~|\.{1,2})?\/[^\s"'`,:;)]+/g, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .trim()
    .slice(0, 160);
}

function insert(d: Database, record: ToolCallRecord): void {
  d.query(
    "INSERT INTO tool_calls (timestamp, session_id, caller, tool, ok, duration_ms, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    record.at ?? new Date().toISOString(),
    record.sessionId,
    record.caller,
    record.tool,
    record.ok ? 1 : 0,
    Math.max(0, Math.round(record.durationMs)),
    record.outcome ?? null,
    record.error === undefined ? null : errorKind(record.error),
  );
}

export function recordToolCall(record: ToolCallRecord): void {
  try {
    insert(db(), record);
  } catch (err) {
    void log("warn", "tool call telemetry write failed", { error: String(err) });
  }
}

export interface ToolStatsRow {
  tool: string;
  calls: number;
  failures: number;
  avgDurationMs: number;
  /** Failures followed, in the same conversation, by another call to the same tool. */
  retried: number;
  /** Failures followed by a call to a different tool: the model routing around this one. */
  switched: number;
  /** Successes the tool read out of something that looks like a failure, by outcome. */
  outcomes: Record<string, number>;
  /** The most frequent failure kinds, most frequent first. */
  topErrors: Array<{ kind: string; count: number }>;
}

export interface ToolStats {
  /** Oldest call on record. Absent when there is none. */
  since?: string;
  /** True once the conversation logs older than the table have been read into it. */
  backfilled: boolean;
  rows: ToolStatsRow[];
}

export interface ToolStatsFilter {
  sessionId?: string;
  caller?: string;
}

const TOP_ERRORS = 3;

export function toolStats(period: UsagePeriod, filter: ToolStatsFilter = {}): ToolStats {
  const d = db();
  const where: string[] = [];
  const params: string[] = [];
  const cutoff = periodCutoff(period);
  if (cutoff) { where.push("timestamp >= ?"); params.push(cutoff); }
  if (filter.sessionId) { where.push("session_id = ?"); params.push(filter.sessionId); }
  if (filter.caller) { where.push("caller = ?"); params.push(filter.caller); }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  // The per-tool totals and the two retry figures, in one pass over the calls in the order a
  // session made them.
  //
  // "Followed by another call" is a window function's job, and `LEAD(tool) OVER (PARTITION BY
  // session_id ...)` cost 470 ms over 235k rows because SQLite walks the whole session index and
  // sorts it. The rows themselves are 60 MB of index entries either way; reading the three columns
  // back and deciding in TypeScript is 200 ms, and the walk is the same one the window does.
  const calls = d
    .query(`SELECT session_id, tool, ok, duration_ms FROM tool_calls ${clause} ORDER BY session_id, timestamp, id`)
    .all(...params) as Array<{ session_id: string; tool: string; ok: number; duration_ms: number }>;

  const folded = new Map<string, ToolStatsRow>();
  const rowOf = (tool: string): ToolStatsRow => {
    const held = folded.get(tool);
    if (held) return held;
    const fresh: ToolStatsRow = { tool, calls: 0, failures: 0, avgDurationMs: 0, retried: 0, switched: 0, outcomes: {}, topErrors: [] };
    folded.set(tool, fresh);
    return fresh;
  };
  const durations = new Map<string, number>();
  // A failure is "retried" when the very next call of its session is the same tool, and "switched"
  // when it is a different one. The last call of a session has no next, and counts as neither.
  let pending: { tool: string; session: string } | null = null;
  for (const call of calls) {
    if (pending !== null) {
      if (call.session_id === pending.session) {
        const row = rowOf(pending.tool);
        if (call.tool === pending.tool) row.retried += 1;
        else row.switched += 1;
      }
      pending = null;
    }
    const row = rowOf(call.tool);
    row.calls += 1;
    durations.set(call.tool, (durations.get(call.tool) ?? 0) + call.duration_ms);
    if (call.ok === 0) {
      row.failures += 1;
      pending = { tool: call.tool, session: call.session_id };
    }
  }
  const totals = [...folded.values()];
  for (const row of totals) row.avgDurationMs = row.calls > 0 ? Math.round((durations.get(row.tool) ?? 0) / row.calls) : 0;
  totals.sort((a, b) => b.calls - a.calls);

  const outcomes = d
    .query(`SELECT tool, outcome, COUNT(*) AS n FROM tool_calls ${clause ? `${clause} AND` : "WHERE"} outcome IS NOT NULL GROUP BY tool, outcome`)
    .all(...params) as Array<{ tool: string; outcome: string; n: number }>;

  const errors = d
    .query(`SELECT tool, error, COUNT(*) AS n FROM tool_calls ${clause ? `${clause} AND` : "WHERE"} ok = 0 AND error IS NOT NULL GROUP BY tool, error ORDER BY n DESC`)
    .all(...params) as Array<{ tool: string; error: string; n: number }>;

  const rows = totals.map((t): ToolStatsRow => ({
    ...t,
    outcomes: Object.fromEntries(outcomes.filter((o) => o.tool === t.tool).map((o) => [o.outcome, o.n])),
    topErrors: errors.filter((e) => e.tool === t.tool).slice(0, TOP_ERRORS).map((e) => ({ kind: e.error, count: e.n })),
  }));

  const since = (d.query("SELECT MIN(timestamp) AS t FROM tool_calls").get() as { t: string | null }).t ?? undefined;
  const backfilled = d.query("SELECT 1 FROM analytics_meta WHERE key = ?").get(BACKFILLED) !== null;
  return { ...(since ? { since } : {}), backfilled, rows };
}

const SESSIONS_DIR = join(MY_CLAW_DIR, "sessions");

async function* entryFiles(dir: string): AsyncGenerator<string> {
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* entryFiles(path);
    else if (entry.name === "entries.jsonl") yield path;
  }
}

/** Both spellings are on disk: the imported logs were written with a space after the colon. */
const TOOL_LINE = /"type":\s?"tool"/;

interface LoggedTool {
  type?: string;
  name?: string;
  ok?: boolean;
  durationMs?: number;
  output?: unknown;
  ts?: number;
}

/**
 * Reads the conversation logs written before the table existed into it, once.
 *
 * The logs already hold every tool call (`ToolEntry`: name, ok, duration, what the model was told),
 * so the history does not start the day the recorder shipped: the rates before a fix are there to
 * compare with the rates after. Everything is inserted in one transaction with the flag that says
 * it is done, so an interrupted pass leaves nothing and the next boot starts it again.
 */
export async function backfillToolCalls(sessionsDir = SESSIONS_DIR): Promise<number> {
  const d = db();
  if (d.query("SELECT 1 FROM analytics_meta WHERE key = ?").get(BACKFILLED) !== null) return 0;
  d.query("INSERT OR IGNORE INTO analytics_meta (key, value) VALUES (?, ?)").run(BACKFILL_BEFORE, new Date().toISOString());
  const before = Date.parse((d.query("SELECT value FROM analytics_meta WHERE key = ?").get(BACKFILL_BEFORE) as { value: string }).value);

  const rows: ToolCallRecord[] = [];
  for await (const file of entryFiles(sessionsDir)) {
    const sessionId = relative(sessionsDir, file).split(sep).slice(0, -1).join("/");
    const caller = sessionId.startsWith("my-claw-app/") || sessionId.startsWith("cron/") ? "orchestrator" : "subagent";
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf-8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!TOOL_LINE.test(line)) continue;
      let entry: LoggedTool;
      try {
        entry = JSON.parse(line) as LoggedTool;
      } catch {
        continue;
      }
      if (entry.type !== "tool" || typeof entry.name !== "string" || typeof entry.ts !== "number" || entry.ts >= before) continue;
      const ok = entry.ok !== false;
      rows.push({
        sessionId,
        caller,
        tool: entry.name,
        ok,
        durationMs: typeof entry.durationMs === "number" ? entry.durationMs : 0,
        ...(ok ? {} : { error: String(entry.output ?? "") }),
        at: new Date(entry.ts).toISOString(),
      });
    }
  }

  d.transaction(() => {
    for (const row of rows) insert(d, row);
    d.query("INSERT OR REPLACE INTO analytics_meta (key, value) VALUES (?, ?)").run(BACKFILLED, new Date().toISOString());
  })();
  return rows.length;
}
