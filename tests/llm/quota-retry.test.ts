/**
 * Which reset a failed run waits for. The provider's own windows decide; the error only opens
 * the question.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  isQuotaFailure,
  kindOfWindow,
  needsQuotaOracle,
  quotaWaitFrom,
  spentWindowOf,
  QUOTA_RETRY_BUFFER_MS,
} from "../../src/llm/quota/retry.ts";
import type { QuotaOutcome, QuotaSnapshot } from "../../src/llm/quota/types.ts";

function snapshot(windows: Array<{ label: string; usedPercent: number; resetAt?: string }>): QuotaOutcome {
  const body: QuotaSnapshot = {
    provider: "p",
    source: "claude",
    windows: windows.map((window, index) => ({ id: `w${index}`, ...window })),
    balances: [],
    extras: [],
    fetchedAt: new Date().toISOString(),
  };
  return { ok: true, snapshot: body };
}

const NOW = Date.parse("2026-10-23T00:00:00.000Z");

test("the earliest spent window sets the wait, plus the buffer", () => {
  const outcome = snapshot([
    { label: "Week", usedPercent: 58, resetAt: "2026-10-24T06:00:00.000Z" },
    { label: "5 h", usedPercent: 100, resetAt: "2026-10-23T00:30:00.000Z" },
  ]);
  const wait = quotaWaitFrom(outcome, NOW);
  assert.ok(wait);
  assert.equal(wait.at, new Date(Date.parse("2026-10-23T00:30:00.000Z") + QUOTA_RETRY_BUFFER_MS).toISOString());
  assert.deepEqual(wait.windows, ["5 h"]);
});

test("a window below the wall arms nothing", () => {
  const outcome = snapshot([{ label: "5 h", usedPercent: 98, resetAt: "2026-10-23T00:30:00.000Z" }]);
  assert.equal(quotaWaitFrom(outcome, NOW), undefined);
});

test("a reset already behind us arms nothing: the reading is stale, not the quota", () => {
  const outcome = snapshot([{ label: "5 h", usedPercent: 100, resetAt: "2026-10-22T23:00:00.000Z" }]);
  assert.equal(quotaWaitFrom(outcome, NOW), undefined);
});

test("two spent windows: the earliest reset is the attempt, not the latest", () => {
  const outcome = snapshot([
    { label: "5 h", usedPercent: 100, resetAt: "2026-10-23T01:00:00.000Z" },
    { label: "Week", usedPercent: 100, resetAt: "2026-10-29T00:00:00.000Z" },
  ]);
  const wait = quotaWaitFrom(outcome, NOW);
  assert.ok(wait);
  assert.equal(wait.at, new Date(Date.parse("2026-10-23T01:00:00.000Z") + QUOTA_RETRY_BUFFER_MS).toISOString());
  assert.deepEqual(wait.windows, ["5 h", "Week"]);
});

test("a failed or balance-only answer arms nothing", () => {
  assert.equal(quotaWaitFrom({ ok: false, code: "rate-limited", message: "429" }, NOW), undefined);
  const balance = snapshot([]);
  if (balance.ok) balance.snapshot.balances.push({ id: "credits", label: "Credits", currency: "USD", remaining: 0.03 });
  assert.equal(quotaWaitFrom(balance, NOW), undefined);
});

test("the error classification opens the question on 402, 429 and quota texts only", () => {
  const failure = (status: number | undefined, message: string): Error & { status?: number } => {
    const err = new Error(message) as Error & { status?: number };
    if (status !== undefined) err.status = status;
    return err;
  };
  assert.equal(isQuotaFailure(failure(429, "too many requests")), true);
  assert.equal(isQuotaFailure(failure(402, "payment required")), true);
  assert.equal(isQuotaFailure(failure(400, "You're out of credits")), true);
  assert.equal(isQuotaFailure(failure(400, "content exists risk")), false);
  assert.equal(isQuotaFailure(failure(400, "invalid request: messages[0].content.str")), false);
});

/**
 * Anthropic answers a full five-hour window with the exact sentence it uses for a per-minute
 * burst: `{"type":"rate_limit_error","message":"This request would exceed your account's rate
 * limit."}`. Measured 2026-10-31 in a career session on `claude-2`: the oracle had the 5 h window
 * at 100 % with a reset twenty-two minutes out, and the run still paid three transport retries
 * and 30 s + 60 s + 120 s of waits, then fell back. The sentence cannot settle this; the bar can.
 */
test("a bare rate_limit_error is ambiguous, and the oracle settles it", () => {
  const anthropic = Object.assign(
    new Error('Anthropic request failed: HTTP 429 — {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}'),
    { status: 429, provider: "claude-2" },
  );
  // Ambiguous: worth one probe, which is the whole reason the wall is recognised at all.
  assert.equal(needsQuotaOracle(anthropic), true);
  // And the same words with a spent bar behind them arm a wait, on that bar's own reset.
  const wait = quotaWaitFrom(
    snapshot([{ label: "5 h", usedPercent: 100, resetAt: "2026-10-23T00:30:00.000Z" }]),
    NOW,
  );
  assert.ok(wait);
  assert.deepEqual(wait.windows, ["5 h"]);
});

test("a phrase that already names a spent plan needs no probe", () => {
  const failed = (status: number, message: string): Error & { status?: number } =>
    Object.assign(new Error(message), { status });
  assert.equal(needsQuotaOracle(failed(429, "usage_limit_reached")), false);
  assert.equal(needsQuotaOracle(failed(429, "quota exhausted")), false);
  assert.equal(needsQuotaOracle(failed(402, "payment required")), false);
  assert.equal(needsQuotaOracle(failed(400, "You're out of credits")), false);
  // Not a quota at all: the ordinary transport backoff owns it, no probe.
  assert.equal(needsQuotaOracle(failed(500, "internal server error")), false);
  assert.equal(needsQuotaOracle(failed(500, "overloaded")), false);
});

/**
 * A plan is not one bar, and the three periods reopen on completely different clocks. OpenCode Go
 * publishes all three; Codex and Claude name theirs by duration or by kind; Synthetic has a week
 * and a five-hour readout. The wait must reason about which of them is full.
 */
test("every period is recognised, from the duration or from the name", () => {
  assert.equal(kindOfWindow({ id: "session", label: "5 h" }), "5h");
  assert.equal(kindOfWindow({ id: "rolling", label: "5 h", windowSeconds: 18_000 }), "5h");
  assert.equal(kindOfWindow({ id: "weekly", label: "Week" }), "week");
  assert.equal(kindOfWindow({ id: "week", label: "Week · all models" }), "week");
  assert.equal(kindOfWindow({ id: "604800", label: "Week", windowSeconds: 604_800 }), "week");
  assert.equal(kindOfWindow({ id: "monthly", label: "Month" }), "month");
  assert.equal(kindOfWindow({ id: "2628000", label: "Month", windowSeconds: 2_628_000 }), "month");
  assert.equal(kindOfWindow({ id: "daily", label: "Day", windowSeconds: 86_400 }), "day");
  // A bar the source names nothing useful about is still a bar, just not a period we know.
  assert.equal(kindOfWindow({ id: "key-limit", label: "Key limit" }), "other");
  assert.equal(kindOfWindow({ id: "feature:Spark", label: "Spark" }), "other");
});

/**
 * The narrowest spent bar is the one a single call hit: a plan at 100 % on its 5 h and 11 % on its
 * week does not refuse for the week. Reading the widest instead would tell the reader that a bar
 * months out is what blocked them.
 */
test("a monthly wall is a wall too, and the narrowest spent bar is the one named", () => {
  const month = snapshot([
    { label: "5 h", usedPercent: 12, resetAt: "2026-10-23T02:00:00.000Z" },
    { label: "Week", usedPercent: 40, resetAt: "2026-10-27T00:00:00.000Z" },
    { label: "Month", usedPercent: 100, resetAt: "2026-11-15T00:00:00.000Z" },
  ]);
  const spent = spentWindowOf(month);
  assert.ok(spent);
  assert.equal(spent.label, "Month");
  const wait = quotaWaitFrom(month, NOW);
  assert.ok(wait);
  assert.equal(wait.at, new Date(Date.parse("2026-11-15T00:00:00.000Z") + QUOTA_RETRY_BUFFER_MS).toISOString());
  assert.deepEqual(wait.windows, ["Month"]);
});

test("the five-hour bar refuses first when several are full", () => {
  const spent = spentWindowOf(
    snapshot([
      { label: "Week", usedPercent: 100, resetAt: "2026-10-29T00:00:00.000Z" },
      { label: "5 h", usedPercent: 100, resetAt: "2026-10-23T00:30:00.000Z" },
    ]),
  );
  assert.equal(spent?.label, "5 h");
});

test("nothing at the wall names no window: a burst limit is not a plan", () => {
  assert.equal(
    spentWindowOf(
      snapshot([
        { label: "5 h", usedPercent: 40, resetAt: "2026-10-23T02:00:00.000Z" },
        { label: "Week", usedPercent: 11, resetAt: "2026-10-29T00:00:00.000Z" },
      ]),
    ),
    undefined,
  );
});
