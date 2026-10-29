/**
 * Arming a quota wait, for any session -- docs/quota-retry.md.
 *
 * The decision lived in the app adapter because that is where the tick runs. A sub-agent has no
 * app thread: its wait belongs to its own session on disk, and the only executor that can fire it
 * is whoever drives that child. Duplicating the decision there would have given two answers to
 * "when does this plan reopen" -- which is exactly the disagreement `docs/quota.md` forbids.
 *
 * So the decision is here, the ownership is not: this module answers "should a wait be armed, and
 * when", and never starts anything. The app adapter keeps the tick for conversations; the sub-agent
 * runner arms its own waits and says so, and its driver resumes it.
 *
 * `enabled` is the caller's switch and is checked here, because a wait nobody turned on must not be
 * armed by either path.
 */

import { isQuotaFailure, quotaWaitFrom, QUOTA_RETRY_MAX_ATTEMPTS } from "./retry.ts";
import type { QuotaOutcome } from "./types.ts";
import type { SessionQuotaRetry } from "../../sessions/store.ts";

export interface ArmedQuotaWait {
  at: string;
  attempts: number;
  windows: string[];
  error?: string;
}

export interface QuotaWaitDecision {
  /** The wait to store, or nothing when this failure earns none. */
  wait?: ArmedQuotaWait;
  /** Why nothing was armed, for the log: a read that fails silently is a bug that never surfaces. */
  skipped?: "not-a-quota" | "switch-off" | "no-reset" | "gave-up";
}

/**
 * Whether this failure arms a wait, and for when.
 *
 * The error alone never decides the reset: the provider's usage endpoint is the oracle, so a 429
 * that is a per-minute rate limit arms nothing even though its status looked the same. `switchOff`
 * is the caller's own read of `session.quotaRetry.enabled`, passed in rather than re-read, so the
 * two paths that own sessions cannot disagree about which one holds the switch.
 */
export async function decideQuotaWait(input: {
  /** One provider's usage, forced: the caller owns how it is reached (config here, a controller there). */
  readQuota: (provider: string) => Promise<QuotaOutcome>;
  err: unknown;
  switchOff: boolean;
  /** The attempts already spent on this wait, so both paths share one ceiling. */
  previousAttempts: number;
}): Promise<QuotaWaitDecision> {
  if (input.switchOff) return { skipped: "switch-off" };
  if (!isQuotaFailure(input.err)) return { skipped: "not-a-quota" };
  const provider = (input.err as { provider?: string } | undefined)?.provider;
  const outcome = provider ? await input.readQuota(provider).catch(() => undefined) : undefined;
  const wait = outcome ? quotaWaitFrom(outcome) : undefined;
  if (!wait) return { skipped: "no-reset" };
  const attempts = input.previousAttempts + 1;
  if (attempts > QUOTA_RETRY_MAX_ATTEMPTS) return { skipped: "gave-up" };
  const message = input.err instanceof Error ? input.err.message : String(input.err);
  return {
    wait: {
      ...wait,
      attempts,
      error: message.slice(0, 200),
    },
  };
}

/** The stored wait as a session holds it, or nothing when there is none left to fire. */
export function pendingWaitOf(retry: SessionQuotaRetry | undefined): ArmedQuotaWait | undefined {
  return retry?.enabled === true ? retry.pending : undefined;
}
