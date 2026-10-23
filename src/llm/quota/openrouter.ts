/**
 * OpenRouter prices every call, so its "quota" is a wallet plus the key's own cap.
 *
 * `/credits` is documented as answering management keys only and answers an ordinary key anyway;
 * `/key` is the per-key view. The two are read together and either one failing leaves the other's
 * half on the card: a balance that disappears because one endpoint hiccuped is worse than a card
 * with one row missing.
 */
import { getJson, isAuthFailure } from "./http.ts";
import {
  clampPercent,
  numberOf,
  recordOf,
  stringOf,
  type QuotaBalance,
  type QuotaExtra,
  type QuotaProbe,
  type QuotaWindow,
} from "./types.ts";

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export async function openrouterQuota(
  provider: string,
  apiKey: string,
  baseUrl = DEFAULT_BASE,
): Promise<QuotaProbe> {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${apiKey}` };
  const [keyResponse, creditsResponse] = await Promise.all([
    getJson(`${base}/key`, headers),
    getJson(`${base}/credits`, headers),
  ]);

  if (!keyResponse.ok && !creditsResponse.ok) {
    const failure = keyResponse.ok ? creditsResponse : keyResponse;
    const status = failure.ok ? undefined : failure.status;
    return {
      ok: false,
      code: status === 429 ? "rate-limited" : isAuthFailure(status) ? "not-signed-in" : "failed",
      message: failure.ok ? "failed" : failure.message,
      ...(failure.ok || failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    };
  }

  const balances: QuotaBalance[] = [];
  const extras: QuotaExtra[] = [];
  const windows: QuotaWindow[] = [];

  if (creditsResponse.ok) {
    const credits = recordOf(recordOf(creditsResponse.data)?.data);
    const total = numberOf(credits?.total_credits);
    const used = numberOf(credits?.total_usage);
    if (total !== undefined && used !== undefined) {
      balances.push({
        id: "credits",
        label: "Credits",
        currency: "USD",
        remaining: Math.round((total - used) * 100) / 100,
        total,
      });
    }
  }

  if (keyResponse.ok) {
    const key = recordOf(recordOf(keyResponse.data)?.data);
    const usage = numberOf(key?.usage);
    const limit = numberOf(key?.limit);
    const label = stringOf(key?.label);
    if (label) extras.push({ label: "Key", value: label });
    if (usage !== undefined) extras.push({ label: "Key usage", value: usd(usage) });
    const weekly = numberOf(key?.usage_weekly);
    if (weekly !== undefined) extras.push({ label: "This week", value: usd(weekly) });
    const monthly = numberOf(key?.usage_monthly);
    if (monthly !== undefined) extras.push({ label: "This month", value: usd(monthly) });
    if (limit !== undefined && limit > 0 && usage !== undefined) {
      windows.push({
        id: "key-limit",
        label: "Key limit",
        usedPercent: clampPercent((usage / limit) * 100),
      });
    }
    if (key?.is_free_tier === true) extras.push({ label: "Tier", value: "free" });
  }

  return {
    ok: true,
    snapshot: {
      provider,
      source: "openrouter",
      windows,
      balances,
      extras,
      fetchedAt: new Date().toISOString(),
    },
  };
}
