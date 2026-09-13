import { test, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { analyticsDb, pruneOldRecords, recordApiCall } from "../../src/analytics/usage-db.ts";
import { periodCutoff, reachesRollup, usageByCaller, usageByDay, usageByModel, usageBySession } from "../../src/analytics/usage-stats.ts";

/**
 * The four windows the statistics page offers, and which of them reach past the retention wall.
 *
 * A bounded period stops at most ninety days back and reads live rows alone; `all` adds the
 * permanent rollup, which holds exactly the rows the purge deleted. The two can never describe the
 * same call, which is why adding them is a total and not a double count.
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

function call(at: string, over: { sessionId?: string; model?: string; baseUrl?: string; caller?: "orchestrator" | "subagent" | "browser"; error?: string } = {}): void {
  const sessionId = over.sessionId ?? `s-${at}`;
  recordApiCall({
    sessionId,
    parentSessionId: sessionId,
    platform: "my-claw-app",
    model: over.model ?? "glm-5.2",
    baseUrl: over.baseUrl ?? "https://openrouter.ai/api/v1",
    streaming: true,
    caller: over.caller ?? "orchestrator",
    promptTokens: 1000,
    completionTokens: 10,
    totalTokens: 1010,
    cacheReadTokens: 400,
    cacheWriteTokens: 20,
    toolCalls: 0,
    iteration: 1,
    durationMs: 100,
    ...(over.error === undefined ? {} : { error: over.error }),
  });
  // `recordApiCall` stamps `now` and takes no date. Same connection, so the last rowid is the row
  // that was just written: addressing it by session id would move every earlier call of it too.
  analyticsDb().run("UPDATE api_calls SET timestamp = ? WHERE id = last_insert_rowid()", [at]);
}

/** Days back from now, as an ISO instant a row can be dated with. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000 + 3_600_000).toISOString();
}

function totalCalls(groups: Array<{ calls: number }>): number {
  return groups.reduce((sum, g) => sum + g.calls, 0);
}

test("a period is a lower bound on the timestamp, and nothing older reaches it", () => {
  call(daysAgo(1));
  call(daysAgo(10));
  call(daysAgo(45));
  call(daysAgo(200));

  expect(totalCalls(usageByModel("7d"))).toBe(1);
  expect(totalCalls(usageByModel("30d"))).toBe(2);
  expect(totalCalls(usageByModel("90d"))).toBe(3);
  expect(totalCalls(usageByModel("all"))).toBe(4);
});

test("the cutoff of a bounded period is the period, and `all` has none at all", () => {
  const now = Date.parse("2026-09-13T12:00:00.000Z");
  expect(periodCutoff("7d", now)).toBe("2026-09-06T12:00:00.000Z");
  expect(periodCutoff("30d", now)).toBe("2026-08-14T12:00:00.000Z");
  expect(periodCutoff("90d", now)).toBe("2026-06-15T12:00:00.000Z");
  expect(periodCutoff("all", now)).toBeNull();
  expect([reachesRollup("7d"), reachesRollup("30d"), reachesRollup("90d"), reachesRollup("all")]).toEqual([false, false, false, true]);
});

/**
 * The only reading that crosses the wall, and the one that must not double count.
 *
 * The purged rows leave `api_calls` and arrive in the rollup in the same transaction, so `all`
 * reads each of them exactly once whichever side it is on.
 */
test("`all` reads the rollup and the live rows, each call once", () => {
  call("2026-01-05T10:00:00.000Z");
  call("2026-01-06T10:00:00.000Z");
  call(daysAgo(2));
  expect(totalCalls(usageByModel("all"))).toBe(3);

  pruneOldRecords("2026-04-01T00:00:00.000Z");
  const groups = usageByModel("all");
  expect(totalCalls(groups)).toBe(3);
  expect(groups.map((g) => g.origin).sort()).toEqual(["live", "rollup"]);
  // And a bounded period is unaffected by the purge: it never reached those months anyway.
  expect(totalCalls(usageByModel("90d"))).toBe(1);
  expect(usageByModel("90d").every((g) => g.origin === "live")).toBe(true);
});

test("a bounded period never touches the rollup, even when the rollup holds the same model", () => {
  call("2026-01-05T10:00:00.000Z");
  pruneOldRecords("2026-04-01T00:00:00.000Z");
  call(daysAgo(1));

  expect(totalCalls(usageByModel("7d"))).toBe(1);
  expect(totalCalls(usageByCaller("7d"))).toBe(1);
  expect(totalCalls(usageByModel("all"))).toBe(2);
  expect(totalCalls(usageByCaller("all"))).toBe(2);
});

/**
 * The rollup key has no session and no day on it, so those two views stop where the per-call rows
 * stop. Reporting them over `all` as if they covered everything is exactly the lie the horizon on
 * the payload exists to prevent.
 */
test("the per-session and per-day views are bounded by the live rows, `all` included", () => {
  call("2026-01-05T10:00:00.000Z", { sessionId: "old-one" });
  call(daysAgo(1), { sessionId: "recent-one" });
  pruneOldRecords("2026-04-01T00:00:00.000Z");

  expect(usageBySession("all").map((g) => g.sessionId)).toEqual(["recent-one"]);
  expect(usageByDay("all")).toHaveLength(1);
  expect(usageBySession("all").every((g) => g.origin === "live")).toBe(true);
  expect(usageByDay("all").every((g) => g.origin === "live")).toBe(true);
  // The totals, meanwhile, still carry both.
  expect(totalCalls(usageByModel("all"))).toBe(2);
});

test("a session keeps its rows once its conversation is gone, and its first and last call with them", () => {
  call("2026-09-01T08:00:00.000Z", { sessionId: "my-claw-app/thread/o/ghost" });
  call("2026-09-02T08:00:00.000Z", { sessionId: "my-claw-app/thread/o/ghost" });
  const rows = usageBySession("all").filter((r) => r.sessionId === "my-claw-app/thread/o/ghost");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.calls).toBe(2);
  expect(rows[0]!.firstAt).toBe("2026-09-01T08:00:00.000Z");
  expect(rows[0]!.lastAt).toBe("2026-09-02T08:00:00.000Z");
});

test("every group is split by model and by endpoint, because the same id on two hosts is two rates", () => {
  call(daysAgo(1), { model: "glm-5.2", baseUrl: "https://openrouter.ai/api/v1" });
  call(daysAgo(1), { model: "glm-5.2", baseUrl: "https://api.anthropic.com" });
  call(daysAgo(1), { model: "claude-opus-5", baseUrl: "https://api.anthropic.com" });

  const groups = usageByModel("7d");
  expect(groups).toHaveLength(3);
  expect(totalCalls(groups)).toBe(3);
});

test("errors and API time ride with the group, so reliability reads off the same rows as the money", () => {
  call(daysAgo(1));
  call(daysAgo(1), { error: "HTTP 500" });
  const group = usageByModel("7d")[0]!;
  expect(group.calls).toBe(2);
  expect(group.errors).toBe(1);
  expect(group.durationMs).toBe(200);
  expect(group.cacheReadTokens).toBe(800);
  expect(group.cacheWriteTokens).toBe(40);
});

test("the callers are split apart, and a bounded period holds the same split as `all`", () => {
  call(daysAgo(1), { caller: "orchestrator" });
  call(daysAgo(1), { caller: "subagent" });
  call(daysAgo(1), { caller: "browser" });
  call(daysAgo(1), { caller: "subagent" });

  const byCaller = new Map<string, number>();
  for (const row of usageByCaller("7d")) byCaller.set(row.caller, (byCaller.get(row.caller) ?? 0) + row.calls);
  expect([...byCaller.entries()].sort()).toEqual([["browser", 1], ["orchestrator", 1], ["subagent", 2]]);
});

test("a day is the date of the timestamp, and two calls of one day are one bucket", () => {
  call("2026-09-01T08:00:00.000Z");
  call("2026-09-01T20:00:00.000Z");
  call("2026-09-02T08:00:00.000Z");
  const days = usageByDay("all");
  expect(days.map((d) => d.date).sort()).toEqual(["2026-09-01", "2026-09-02"]);
  expect(totalCalls(days)).toBe(3);
});
