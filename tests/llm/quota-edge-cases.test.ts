/**
 * Edge cases of arming a quota wait, after the 2026-11-23 incident: a compaction wall on Anthropic
 * parked a thread behind its weekly while a ChatGPT week reopened first. The route is the question,
 * so these pin down what the arm does with duplicates, failed reads, past resets and an error that
 * names no provider at all.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { decideQuotaWait } from "../../src/llm/quota/arm.ts";
import { QUOTA_RETRY_BUFFER_MS, QUOTA_RETRY_MAX_ATTEMPTS, QUOTA_RETRY_MAX_PROBES } from "../../src/llm/quota/retry.ts";
import type { QuotaOutcome, QuotaSnapshot } from "../../src/llm/quota/types.ts";

function snapshot(provider: string, windows: Array<{ label: string; usedPercent: number; resetAt?: string }>): QuotaOutcome {
  const body: QuotaSnapshot = {
    provider,
    source: "claude",
    windows: windows.map((window, index) => ({ id: `w${index}`, ...window })),
    balances: [],
    extras: [],
    fetchedAt: new Date().toISOString(),
  };
  return { ok: true, snapshot: body };
}

function quotaError(extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("HTTP 429 — quota exhausted"), { status: 429, ...extra });
}

test("duplicate providers are asked once, and the error's own provider joins the set", async () => {
  const asked: string[] = [];
  const decision = await decideQuotaWait({
    readQuota: async (provider) => {
      asked.push(provider);
      return snapshot(provider, [{ label: "Week", usedPercent: 100, resetAt: new Date(Date.now() + 60_000).toISOString() }]);
    },
    err: quotaError({ provider: "c", providers: ["a", "b", "a", ""] }),
    switchOff: false,
    previousAttempts: 0,
  });
  assert.deepEqual(asked, ["a", "b", "c"]);
  assert.ok(decision.wait);
});

test("a read that fails next to a spent account with a reset still waits for that reset", async () => {
  const reset = new Date(Date.now() + 120_000).toISOString();
  const decision = await decideQuotaWait({
    readQuota: async (provider) => {
      if (provider === "broken") throw new Error("HTTP 500 from the usage endpoint");
      return snapshot(provider, [{ label: "5 h", usedPercent: 100, resetAt: reset }]);
    },
    err: quotaError({ provider: "broken", providers: ["broken", "spent"] }),
    switchOff: false,
    previousAttempts: 0,
  });
  assert.ok(decision.wait);
  assert.equal(decision.wait.probe, undefined);
  assert.equal(decision.wait.provider, "spent");
  assert.equal(decision.wait.at, new Date(Date.parse(reset) + QUOTA_RETRY_BUFFER_MS).toISOString());
});

test("a reset already past is not a wait, it is a probe", async () => {
  const decision = await decideQuotaWait({
    readQuota: async (provider) =>
      snapshot(provider, [{ label: "Week", usedPercent: 100, resetAt: new Date(Date.now() - 3_600_000).toISOString() }]),
    err: quotaError({ provider: "claude-2" }),
    switchOff: false,
    previousAttempts: 0,
  });
  assert.ok(decision.wait);
  assert.equal(decision.wait.probe, true, "a clock that already passed cannot be a promise");
  assert.equal(decision.wait.provider, "claude-2");
});

test("the earliest of four accounts wins, and the wait names it", async () => {
  const hour = 3_600_000;
  const now = Date.now();
  const resets: Record<string, string> = {
    anthropic: new Date(now + 3 * hour).toISOString(),
    "chatgpt-2": new Date(now + hour / 2).toISOString(),
    "chatgpt-3": new Date(now + hour / 3).toISOString(),
    "chatgpt-4": new Date(now + 2 * hour).toISOString(),
  };
  const decision = await decideQuotaWait({
    readQuota: async (provider) =>
      snapshot(provider, [{ label: "Week", usedPercent: 100, resetAt: resets[provider]! }]),
    err: quotaError({ provider: "anthropic", providers: ["anthropic", "chatgpt-2", "chatgpt-3", "chatgpt-4"] }),
    switchOff: false,
    previousAttempts: 0,
  });
  assert.ok(decision.wait);
  assert.equal(decision.wait.provider, "chatgpt-3");
  assert.equal(decision.wait.at, new Date(Date.parse(resets["chatgpt-3"]!) + QUOTA_RETRY_BUFFER_MS).toISOString());
  assert.deepEqual(decision.wait.windows, ["Week"]);
});

test("an error that names no provider still probes, without inventing a name", async () => {
  const decision = await decideQuotaWait({
    readQuota: async () => {
      throw new Error("nothing to read");
    },
    err: Object.assign(new Error("HTTP 429 — rate limited"), { status: 429 }),
    switchOff: false,
    previousAttempts: 0,
  });
  assert.ok(decision.wait);
  assert.equal(decision.wait.probe, true);
  assert.equal(decision.wait.provider, undefined);
});

test("a reset wait and a probe keep their own ceilings", async () => {
  const reset = new Date(Date.now() + 60_000).toISOString();
  const spent = await decideQuotaWait({
    readQuota: async (provider) => snapshot(provider, [{ label: "Week", usedPercent: 100, resetAt: reset }]),
    err: quotaError({ provider: "claude-2" }),
    switchOff: false,
    previousAttempts: QUOTA_RETRY_MAX_ATTEMPTS - 1,
  });
  assert.ok(spent.wait, "the last reset attempt is still armed");

  const tooMany = await decideQuotaWait({
    readQuota: async (provider) => snapshot(provider, [{ label: "Week", usedPercent: 100, resetAt: reset }]),
    err: quotaError({ provider: "claude-2" }),
    switchOff: false,
    previousAttempts: QUOTA_RETRY_MAX_ATTEMPTS,
  });
  assert.equal(tooMany.wait, undefined);
  assert.equal(tooMany.skipped, "gave-up");

  const probe = await decideQuotaWait({
    readQuota: async (provider) => snapshot(provider, [{ label: "Week", usedPercent: 100 }]),
    err: quotaError({ provider: "claude-2" }),
    switchOff: false,
    previousAttempts: QUOTA_RETRY_MAX_PROBES - 1,
  });
  assert.equal(probe.wait?.probe, true, "a probe is cheap, its ceiling is higher");
});
