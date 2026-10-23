/**
 * What a spent quota means for the session that died on it -- docs/quota-retry.md.
 *
 * The rule is the same for every provider: the usage endpoint is the oracle, never the error
 * string. A 429 that is a per-minute rate limit shows every window below full and arms nothing;
 * a real wall shows a window at 100% and names the second it resets. That is the only reason
 * OpenCode Go is waitable at all: its 429 body says nothing, its usage endpoint says everything.
 */
import { isQuotaSpent } from "../outage.ts";
import type { QuotaOutcome } from "./types.ts";

/** The provider resets at its own second; one minute of slack keeps us off the edge. */
export const QUOTA_RETRY_BUFFER_MS = 60_000;

/** A window this full is what the provider refused the call for. */
const SPENT = 99;

/** Guards a loop: a provider that keeps answering 429 across resets stops being retried here. */
export const QUOTA_RETRY_MAX_ATTEMPTS = 8;

/** A balance the provider will not draw on: a wall, even when the status is a 400. */
const BALANCE_SPENT = /out of credits|insufficient (?:credits|balance|funds)|credit balance is too low|out of extra usage/i;

/** Worth asking the oracle about. It decides; this only filters the noise. */
export function isQuotaFailure(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  if (status === 402 || status === 429) return true;
  if (isQuotaSpent(err)) return true;
  return BALANCE_SPENT.test(String((err as Error | undefined)?.message ?? err ?? ""));
}

/**
 * When to try again, from the provider's own windows: the earliest reset among the spent ones.
 *
 * Earliest, not latest: a plan can be full on its 5-hour window and comfortable on its week, and
 * waiting for the week would park the conversation for days over a bucket that refills tonight. If
 * another window turns out to be blocking too, the next attempt fails the same way and re-arms on
 * the new answer -- one wasted call, against a wait the owner did not ask for.
 */
export function quotaWaitFrom(
  outcome: QuotaOutcome,
  now: number = Date.now(),
): { at: string; windows: string[] } | undefined {
  if (!outcome.ok) return undefined;
  const spent = outcome.snapshot.windows.filter((window) => window.usedPercent >= SPENT && window.resetAt);
  const future = spent
    .map((window) => ({ window, at: Date.parse(window.resetAt!) }))
    .filter((entry) => Number.isFinite(entry.at) && entry.at > now);
  if (future.length === 0) return undefined;
  const earliest = Math.min(...future.map((entry) => entry.at));
  const windows = [...new Set(spent.map((window) => window.label))];
  return { at: new Date(earliest + QUOTA_RETRY_BUFFER_MS).toISOString(), windows };
}
