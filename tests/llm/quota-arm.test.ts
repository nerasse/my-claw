/**
 * When a failed run earns a wait, and for when -- docs/quota-retry.md.
 *
 * Two answers hide behind "the switch is on": a published reset, which is a promise the wait can
 * keep, and a spent plan with no clock, which is only a guess and gets a probe instead. The bug
 * this pins down is the third case that used to exist: nothing armed at all, so the switch did
 * nothing on exactly the accounts that had no quota (2026-11-10).
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { decideQuotaWait } from "../../src/llm/quota/arm.ts";
import {
  QUOTA_PROBE_BASE_MS,
  QUOTA_PROBE_MAX_MS,
  QUOTA_RETRY_BUFFER_MS,
  QUOTA_RETRY_MAX_ATTEMPTS,
  QUOTA_RETRY_MAX_PROBES,
  probeWaitFrom,
} from "../../src/llm/quota/retry.ts";
import type { QuotaOutcome, QuotaSnapshot } from "../../src/llm/quota/types.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
/** A reset the oracle publishes, far enough out that the real clock in `quotaWaitFrom` sees it. */
const RESET = new Date(Date.now() + 3_600_000).toISOString();

function snapshot(windows: Array<{ label: string; usedPercent: number; resetAt?: string }>): QuotaOutcome {
  const body: QuotaSnapshot = {
    provider: "claude-2",
    source: "claude",
    windows: windows.map((window, index) => ({ id: `w${index}`, ...window })),
    balances: [],
    extras: [],
    fetchedAt: new Date().toISOString(),
  };
  return { ok: true, snapshot: body };
}

const QUOTA_ERROR = () =>
  Object.assign(new Error("HTTP 429 — quota exhausted"), { status: 429, provider: "claude-2" });

const decide = (outcome: QuotaOutcome | Error, previousAttempts = 0) =>
  decideQuotaWait({
    readQuota: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    err: QUOTA_ERROR(),
    switchOff: false,
    previousAttempts,
  });

test("a published reset is the wait, as it always was", async () => {
  const decision = await decide(snapshot([{ label: "5 h", usedPercent: 100, resetAt: RESET }]));
  assert.ok(decision.wait);
  assert.equal(decision.wait.probe, undefined);
  assert.equal(decision.wait.at, new Date(Date.parse(RESET) + QUOTA_RETRY_BUFFER_MS).toISOString());
  assert.equal(decision.wait.attempts, 1);
});

test("a spent bar with no reset gets a probe instead of nothing", async () => {
  const decision = await decide(snapshot([{ label: "5 h", usedPercent: 100 }]));
  assert.ok(decision.wait, "the wall is waited on even with no clock");
  assert.equal(decision.wait.probe, true);
  assert.deepEqual(decision.wait.windows, []);
  assert.equal(decision.wait.attempts, 1);
});

test("a usage read that fails is not an answer of room: it is probed", async () => {
  const decision = await decide(new Error("HTTP 500 from the usage endpoint"));
  assert.equal(decision.wait?.probe, true);
});

test("a provider with no usage source at all is probed, not dismissed", async () => {
  const noProvider = await decideQuotaWait({
    readQuota: async () => {
      throw new Error("nothing to read");
    },
    err: Object.assign(new Error("HTTP 429 — rate limited"), { status: 429 }),
    switchOff: false,
    previousAttempts: 0,
  });
  assert.equal(noProvider.wait?.probe, true);
});

test("every bar with room is a burst limit wearing a quota's clothes, and arms nothing", async () => {
  const decision = await decide(
    snapshot([
      { label: "5 h", usedPercent: 40, resetAt: "2026-11-10T13:00:00.000Z" },
      { label: "Week", usedPercent: 61, resetAt: "2026-11-14T13:00:00.000Z" },
    ]),
  );
  assert.equal(decision.wait, undefined);
  assert.equal(decision.skipped, "not-a-quota");
});

test("the switch off still means nothing is armed, whatever the oracle says", async () => {
  const decision = await decideQuotaWait({
    readQuota: async () => snapshot([{ label: "5 h", usedPercent: 100 }]),
    err: QUOTA_ERROR(),
    switchOff: true,
    previousAttempts: 0,
  });
  assert.equal(decision.wait, undefined);
  assert.equal(decision.skipped, "switch-off");
});

test("an error that is not quota-shaped never probes", async () => {
  const decision = await decideQuotaWait({
    readQuota: async () => snapshot([{ label: "5 h", usedPercent: 100 }]),
    err: new Error("fetch failed: ECONNRESET"),
    switchOff: false,
    previousAttempts: 0,
  });
  assert.equal(decision.wait, undefined);
  assert.equal(decision.skipped, "not-a-quota");
});

test("reset waits keep their eight attempts; probes are cheap and allowed a dozen", async () => {
  const reset = await decide(snapshot([{ label: "5 h", usedPercent: 100, resetAt: RESET }]), QUOTA_RETRY_MAX_ATTEMPTS);
  assert.equal(reset.wait, undefined);
  assert.equal(reset.skipped, "gave-up");

  const probe = await decide(snapshot([{ label: "5 h", usedPercent: 100 }]), QUOTA_RETRY_MAX_ATTEMPTS);
  assert.equal(probe.wait?.probe, true, "a spent plan with no clock is still worth checking");

  const spent = await decide(snapshot([{ label: "5 h", usedPercent: 100 }]), QUOTA_RETRY_MAX_PROBES);
  assert.equal(spent.wait, undefined);
  assert.equal(spent.skipped, "gave-up");
});

test("probe gaps start soon and grow to the cap", () => {
  const gap = (attempts: number) => Date.parse(probeWaitFrom(attempts, NOW).at) - NOW;
  assert.equal(gap(1), QUOTA_PROBE_BASE_MS);
  assert.equal(gap(2), QUOTA_PROBE_BASE_MS * 2);
  assert.equal(gap(3), QUOTA_PROBE_BASE_MS * 4);
  assert.equal(gap(9), QUOTA_PROBE_MAX_MS);
  assert.equal(gap(QUOTA_RETRY_MAX_PROBES), QUOTA_PROBE_MAX_MS);
});
