/**
 * What a spent quota means for the session that died on it -- docs/quota-retry.md.
 *
 * The rule is the same for every provider: the usage endpoint is the oracle, never the error
 * string. A 429 that is a per-minute rate limit shows every window below full and arms nothing;
 * a real wall shows a window at 100% and names the second it resets. That is the only reason
 * OpenCode Go is waitable at all: its 429 body says nothing, its usage endpoint says everything.
 *
 * A plan is not one bar. Claude has a five-hour session and a week, OpenCode Go adds a month,
 * Codex names its windows by duration alone, Synthetic has a weekly credit bar and its
 * five-hour readout. Any of them can be the one that refused the call, and they reopen on
 * completely different clocks -- so the wait has to be reasoned about per window, never as "the
 * quota".
 */
import { isQuotaSpent } from "../outage.ts";
import type { QuotaOutcome, QuotaWindow } from "./types.ts";

/** The provider resets at its own second; one minute of slack keeps us off the edge. */
export const QUOTA_RETRY_BUFFER_MS = 60_000;

/** A window this full is what the provider refused the call for. */
const SPENT = 99;

/** Guards a loop: a provider that keeps answering 429 across resets stops being retried here. */
export const QUOTA_RETRY_MAX_ATTEMPTS = 8;

/**
 * A wall the oracle cannot put a clock on is checked again, not abandoned.
 *
 * Not every spent plan publishes a reset: a balance can be empty with no date, a gateway can
 * refuse with no usage endpoint at all, and the usage read itself can fail exactly when the
 * account is out. Waiting only on a published reset meant the switch did nothing in all three
 * cases -- the run failed, Continue failed again, and the owner had no way to leave it parked
 * (2026-11-10). So those walls get a probe: one cheap call, growing, until the plan answers.
 *
 * Base is the first gap; every probe after it doubles up to the cap, which keeps an all-day
 * outage at two calls an hour rather than twelve.
 */
export const QUOTA_PROBE_BASE_MS = 5 * 60_000;
export const QUOTA_PROBE_MAX_MS = 30 * 60_000;
/** Probes are cheap and a plan can reopen any hour of the day; this only stops a runaway. */
export const QUOTA_RETRY_MAX_PROBES = 12;

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
 * Whether this failure's text is ambiguous about being a wall.
 *
 * The oracle is consulted only here, because a probe is a request. The phrases that already say
 * "the plan ran out" decide on their own, and a 402 is a wall whatever else it says. Everything
 * else -- the bare `rate_limit_error`, a 429 with no body, an unknown gateway -- is exactly the
 * case a sentence cannot settle: Anthropic answers a full five-hour window with
 * `{"type":"rate_limit_error","message":"This request would exceed your account's rate limit."}`,
 * word for word what a per-minute burst limit says (measured 2026-10-31, five-hour window at
 * 100%, twenty-two minutes to reset).
 *
 * A 429 that is genuinely a per-minute limit costs one probe and comes back with every window
 * below full: the answer is "not a wall", and the run keeps its ordinary backoff.
 */
export function needsQuotaOracle(err: unknown): boolean {
  if (isQuotaSpent(err)) return false;
  const status = (err as { status?: number } | undefined)?.status;
  if (status === 402) return false;
  if (BALANCE_SPENT.test(String((err as Error | undefined)?.message ?? err ?? ""))) return false;
  return isQuotaFailure(err);
}

/**
 * The kinds of window a plan can have, widest first.
 *
 * Read from the duration when the provider publishes one, from the id or the label when it does
 * not. A provider that names neither keeps its window as `other`: it is still a bar, it just
 * cannot be reasoned about as a period.
 */
export type QuotaWindowKind = "5h" | "day" | "week" | "month" | "other";

const KIND_SECONDS: ReadonlyArray<{ kind: QuotaWindowKind; seconds: number; slack: number }> = [
  // Five hours, a day, a week, a month: the four periods plans actually use. The slack absorbs
  // the providers that measure a month as 30 days and the ones that use a calendar month.
  { kind: "5h", seconds: 18_000, slack: 1_800 },
  { kind: "day", seconds: 86_400, slack: 3_600 },
  { kind: "week", seconds: 604_800, slack: 7_200 },
  { kind: "month", seconds: 2_628_000, slack: 86_400 },
];

/** The id/label spellings, for the sources that publish no duration (Claude, OpenCode Go). */
const KIND_NAMES: ReadonlyArray<{ kind: QuotaWindowKind; pattern: RegExp }> = [
  { kind: "5h", pattern: /^(?:5 ?h|session|five[_ ]?hour|rolling)$/i },
  { kind: "day", pattern: /^(?:day|daily|24 ?h|one[_ ]?day)$/i },
  { kind: "week", pattern: /^(?:week|weekly)(?:[:\s·-]|$)/i },
  { kind: "month", pattern: /^(?:month|monthly)(?:[:\s·-]|$)/i },
];

export function kindOfWindow(window: Pick<QuotaWindow, "id" | "label" | "windowSeconds">): QuotaWindowKind {
  if (window.windowSeconds !== undefined) {
    for (const entry of KIND_SECONDS) {
      if (Math.abs(window.windowSeconds - entry.seconds) <= entry.slack) return entry.kind;
    }
    return "other";
  }
  for (const probe of [window.id, window.label]) {
    for (const entry of KIND_NAMES) {
      if (entry.pattern.test(probe)) return entry.kind;
    }
  }
  return "other";
}

/**
 * When a probe wait comes due, from how many attempts the conversation has already spent.
 *
 * 5 min, 10, 20, then every 30: the first look is soon enough to catch a burst that was simply
 * misreported, and the later ones cost nothing while a plan sits empty for hours.
 */
export function probeWaitFrom(attempts: number, now: number = Date.now()): { at: string; windows: string[] } {
  const steps = Math.max(1, attempts) - 1;
  const gap = Math.min(QUOTA_PROBE_BASE_MS * 2 ** Math.min(steps, 10), QUOTA_PROBE_MAX_MS);
  return { at: new Date(now + gap).toISOString(), windows: [] };
}

/** The period a kind stands for, for the message the reader gets. */
export function labelOfKind(kind: QuotaWindowKind): string {
  if (kind === "5h") return "5 h";
  if (kind === "day") return "day";
  if (kind === "week") return "week";
  if (kind === "month") return "month";
  return "window";
}

/**
 * Which window the provider refused the call for.
 *
 * The narrowest spent one, because that is the one a single call hits first: a plan full on its
 * five-hour session and at 11 % on its week does not refuse for the week. When nothing is at 100 %
 * this answers nothing -- and that is the answer that matters, because it is what separates a
 * per-minute rate limit from a wall.
 *
 * A window the provider reports as spent but with no reset is still reported: the caller decides
 * whether a wall without a second is worth waiting for, and it is not.
 */
export function spentWindowOf(outcome: QuotaOutcome): QuotaWindow | undefined {
  if (!outcome.ok) return undefined;
  const spent = outcome.snapshot.windows.filter((window) => window.usedPercent >= SPENT);
  if (spent.length === 0) return undefined;
  const rank: Record<QuotaWindowKind, number> = { "5h": 0, day: 1, week: 2, month: 3, other: 4 };
  return [...spent].sort((left, right) => rank[kindOfWindow(left)] - rank[kindOfWindow(right)])[0];
}

/**
 * When to try again, from the provider's own windows: the earliest reset among the spent ones.
 *
 * Earliest, not latest: a plan can be full on its 5-hour window and comfortable on its week, and
 * waiting for the week would park the conversation for days over a bucket that refills tonight. If
 * another window turns out to be blocking too, the next attempt fails the same way and re-arms on
 * the new answer -- one wasted call, against a wait the owner did not ask for.
 *
 * The whole spent set travels with the wait, labelled by kind, so the pill can say *which* bars
 * are full instead of naming one window that may not be the one the reader is thinking of.
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
