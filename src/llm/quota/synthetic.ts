/**
 * Synthetic meters a plan with one weekly credit bar that refills in small ticks (2 % every 202
 * minutes), not with a wall that clears once. Its own rate-limit page says so: "Synthetic only uses
 * weekly limits. Unlike other services, there aren't additional five-hour or monthly limits."
 *
 * Two older fields ride along and only one of them is a limit. `rollingFiveHourLimit` was the
 * five-hour window before the pricing change and still answers older subscriptions, so it is read
 * when it is actually there. The `subscription` counter is not read at all: it renews five hours
 * out but never counts anything down (eleven billed completions left it at 0 of 500), so a window
 * drawn from it is a bar that can never move and a countdown that means nothing.
 *
 * `percentRemaining` is what is left, so the card's number is its complement. `nextRegenAt` is the
 * next tick, not the end of the week: on an empty bar it is exactly the moment a retry can go
 * through, which is what the quota-retry waiter needs.
 *
 * The endpoint itself says nothing about plan name or identity, and `/quotas` calls are free.
 */
import { getJson, isAuthFailure } from "./http.ts";
import { clampPercent, isoOf, numberOf, recordOf, type QuotaExtra, type QuotaProbe, type QuotaWindow } from "./types.ts";

const QUOTA_URL = "https://api.synthetic.new/v2/quotas";

export async function syntheticQuota(provider: string, apiKey: string): Promise<QuotaProbe> {
  const response = await getJson(QUOTA_URL, { authorization: `Bearer ${apiKey}` });
  if (!response.ok) {
    return {
      ok: false,
      code: response.status === 429 ? "rate-limited" : isAuthFailure(response.status) ? "not-signed-in" : "failed",
      message: response.message,
      ...(response.retryAfterMs === undefined ? {} : { retryAfterMs: response.retryAfterMs }),
    };
  }

  const body = recordOf(response.data);
  if (!body) return { ok: false, code: "failed", message: "unexpected response" };

  const windows: QuotaWindow[] = [];
  const extras: QuotaExtra[] = [];

  const rolling = recordOf(body.rollingFiveHourLimit);
  const max = numberOf(rolling?.max);
  const remaining = numberOf(rolling?.remaining);
  if (max && max > 0 && remaining !== undefined) {
    const resetAt = isoOf(rolling?.nextTickAt);
    windows.push({
      id: "five_hour",
      label: "5 h",
      usedPercent: clampPercent(((max - remaining) / max) * 100),
      windowSeconds: 18_000,
      ...(resetAt ? { resetAt } : {}),
    });
  }

  const weekly = recordOf(body.planWeeklyLimit) ?? recordOf(body.weeklyTokenLimit);
  const percentRemaining = numberOf(weekly?.percentRemaining);
  if (percentRemaining !== undefined) {
    const resetAt = isoOf(weekly?.nextRegenAt);
    windows.push({
      id: "weekly",
      label: "Week",
      usedPercent: clampPercent(100 - percentRemaining),
      windowSeconds: 604_800,
      ...(resetAt ? { resetAt } : {}),
    });
  }

  if (windows.length === 0) return { ok: false, code: "failed", message: "unexpected response" };

  const search = recordOf(recordOf(body.search)?.hourly);
  const searchLimit = numberOf(search?.limit);
  const searchRequests = numberOf(search?.requests);
  if (searchLimit && searchLimit > 0 && searchRequests !== undefined) {
    extras.push({ label: "Search", value: `${Math.max(0, searchLimit - searchRequests)} / ${searchLimit} per hour` });
  }
  const regen = numberOf(weekly?.nextRegenPercent);
  if (regen !== undefined) extras.push({ label: "Regen", value: `+${regen} % per tick` });
  if (recordOf(rolling)?.limited === true) extras.push({ label: "Limit reached", value: "5 h" });

  return {
    ok: true,
    snapshot: {
      provider,
      source: "synthetic",
      windows,
      balances: [],
      extras,
      fetchedAt: new Date().toISOString(),
    },
  };
}
