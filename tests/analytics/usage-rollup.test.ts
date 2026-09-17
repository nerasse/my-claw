import { test, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { analyticsDb, recordApiCall, usageHorizon } from "../../src/analytics/usage-db.ts";
import { usageByModel, usageBySession } from "../../src/analytics/usage-stats.ts";

/**
 * Every call stays, and the rollup an earlier policy wrote keeps counting.
 *
 * A ninety-day purge used to fold older rows into `usage_monthly` and delete them. The rollup key
 * is (month, model, base_url, platform, caller): no session, no day. So the conversations tab and
 * the daily graph stopped at the wall while the totals kept counting rows no ranking could show,
 * and the owner watched old conversations leave the page (2026-09-17: "il faut rien perdre").
 * Nothing sweeps any more: a call recorded today is still a row in ten years, with its session,
 * and a global reading is the table itself.
 *
 * What an earlier purge already folded is not recoverable -- the rows that carried a session are
 * gone -- so the rollup still has to be read. This file proves it is added to the live rows and
 * counted exactly once, and that an old call keeps the session the ranking needs.
 */

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
});

/** One recorded call, dated afterwards: `recordApiCall` stamps `now` and takes no date. */
function sow(sessionId: string, at: string): void {
  recordApiCall({
    sessionId,
    platform: "my-claw-app",
    model: "glm-5.2",
    baseUrl: "https://openrouter.ai/api/v1",
    streaming: true,
    caller: "orchestrator",
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
    toolCalls: 0,
    iteration: 1,
    durationMs: 5,
  });
  analyticsDb().run("UPDATE api_calls SET timestamp = ? WHERE session_id = ?", [at, sessionId]);
}

/** A month the old purge folded, written the way the rollup holds it: no session anywhere. */
function fold(month: string): void {
  analyticsDb().run(
    `INSERT INTO usage_monthly (
       month, model, base_url, platform, caller, calls, prompt_tokens, completion_tokens,
       cache_read_tokens, cache_write_tokens, billed_usd, reference_usd, unpriced_calls, errors, duration_ms
     ) VALUES (?, 'glm-5.2', 'https://openrouter.ai/api/v1', 'matrix', 'orchestrator', 12, 1200, 120, 0, 0, 0, 0.04, 0, 0, 900)`,
    [month],
  );
}

const OLD = new Date(Date.now() - 300 * 86_400_000).toISOString();

test("an old call keeps the session the ranking reads", () => {
  sow("kept-session", OLD);
  const rows = usageBySession("all", {});
  expect(rows.some((row) => row.sessionId === "kept-session")).toBe(true);
  // The detail horizon is the first recorded row now, not a wall: a report says "since here"
  // because that is where the history starts, not because the rest was thrown away.
  expect(usageHorizon().detailSince).toBe(OLD);
});

test("a rolled-up month still counts beside the live rows", () => {
  fold("2026-06");
  sow("live-session", new Date().toISOString());
  const calls = usageByModel("all", {}).reduce((sum, group) => sum + group.calls, 0);
  expect(calls).toBe(13);
  // The ranking cannot name the rolled month -- no session was written down with it -- which is
  // exactly why nothing sweeps any more.
  const ranked = usageBySession("all", {}).reduce((sum, row) => sum + row.calls, 0);
  expect(ranked).toBe(1);
});

test("nothing in the analytics module can condemn a row", async () => {
  // The decision is a removal, so what has to be locked is the absence: a purge coming back under
  // any name would start eating conversations out of the ranking again, and no test of a reader
  // could see it coming (the sweep ran at boot, in the entry point).
  const module = await import("../../src/analytics/usage-db.ts");
  const verdicts = Object.keys(module).filter((name) => /prune|purge|sweep|condemn|retention/i.test(name));
  expect(verdicts).toEqual([]);
});
