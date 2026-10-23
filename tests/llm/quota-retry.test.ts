/**
 * Which reset a failed run waits for. The provider's own windows decide; the error only opens
 * the question.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { isQuotaFailure, quotaWaitFrom, QUOTA_RETRY_BUFFER_MS } from "../../src/llm/quota/retry.ts";
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
