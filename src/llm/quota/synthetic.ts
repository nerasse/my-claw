/**
 * Synthetic sells one plan and meters it with a weekly credit bar that refills in small ticks
 * (2 % every 202 minutes), not with a wall that clears once. Two other quotas ride along: a
 * rolling request window and an hourly web-search allowance.
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
      ...(resetAt ? { resetAt } : {}),
    });
  } else {
    // The older shape counts requests directly. `renewsAt` sits five hours out, so this is the
    // same rolling window, told as a counter instead of a bar.
    const subscription = recordOf(body.subscription);
    const limit = numberOf(subscription?.limit);
    const requests = numberOf(subscription?.requests);
    if (limit && limit > 0 && requests !== undefined) {
      const resetAt = isoOf(subscription?.renewsAt);
      windows.push({
        id: "five_hour",
        label: "5 h",
        usedPercent: clampPercent((requests / limit) * 100),
        ...(resetAt ? { resetAt } : {}),
      });
    }
  }

  const weekly = recordOf(body.planWeeklyLimit) ?? recordOf(body.weeklyTokenLimit);
  const percentRemaining = numberOf(weekly?.percentRemaining);
  if (percentRemaining !== undefined) {
    const resetAt = isoOf(weekly?.nextRegenAt);
    windows.push({
      id: "weekly",
      label: "Week",
      usedPercent: clampPercent(100 - percentRemaining),
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
