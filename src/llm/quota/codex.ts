/**
 * The ChatGPT plan's own usage endpoint, the one the Codex app shows.
 *
 * The endpoint does not name its windows: it puts them in `primary_window` and `secondary_window`
 * and lets the reader infer. They are identified here by `limit_window_seconds`, because the slots
 * are not a contract: the 5-hour bucket is 18000 s and the weekly one 604800 s, and a plan that
 * drops one of them does not renumber the other.
 */
import { CODEX_BASE_URL } from "../codex-auth.ts";
import { getJson, isAuthFailure, postJson } from "./http.ts";
import type { QuotaRedemption } from "./types.ts";
import {
  clampPercent,
  isoOf,
  numberOf,
  recordOf,
  stringOf,
  type QuotaBalance,
  type QuotaExtra,
  type QuotaResetCredits,
  type QuotaProbe,
  type QuotaWindow,
} from "./types.ts";

const USAGE_URL = `${CODEX_BASE_URL}/wham/usage`;
const RESET_CREDITS_URL = `${CODEX_BASE_URL}/wham/rate-limit-reset-credits`;
const USER_AGENT = "my-claw-quota/1.0";
/** The identity read is optional; it must not hold the numbers up. */
const CREDITS_TIMEOUT_MS = 4_000;

/** The durations the endpoint uses; 18000 = 5 h, 604800 = week, 2628000 = month. */
export function labelForDuration(seconds: number | undefined): string | undefined {
  if (seconds === 18_000) return "5 h";
  if (seconds === 604_800) return "Week";
  if (seconds === 2_628_000) return "Month";
  return undefined;
}

function windowOf(entry: unknown, index: number): QuotaWindow | undefined {
  const record = recordOf(entry);
  if (!record) return undefined;
  const percent = numberOf(record.used_percent);
  if (percent === undefined) return undefined;
  const seconds = numberOf(record.limit_window_seconds);
  const label = labelForDuration(seconds) ?? `Window ${index + 1}`;
  const resetAt = isoOf(record.reset_at);
  return {
    id: seconds === undefined ? `window-${index + 1}` : `${seconds}`,
    label,
    usedPercent: clampPercent(percent),
    ...(resetAt ? { resetAt } : {}),
    ...(seconds === undefined ? {} : { windowSeconds: seconds }),
  };
}

export async function codexQuota(
  provider: string,
  token: { accessToken: string; accountId: string },
): Promise<QuotaProbe> {
  const headers = {
    authorization: `Bearer ${token.accessToken}`,
    "chatgpt-account-id": token.accountId,
    "user-agent": USER_AGENT,
  };
  const [response, creditsResponse] = await Promise.all([
    getJson(USAGE_URL, headers),
    getJson(RESET_CREDITS_URL, headers, CREDITS_TIMEOUT_MS),
  ]);
  if (!response.ok) {
    return {
      ok: false,
      code: response.status === 429 ? "rate-limited" : isAuthFailure(response.status) ? "sign-in-expired" : "failed",
      message: response.message,
      ...(response.retryAfterMs === undefined ? {} : { retryAfterMs: response.retryAfterMs }),
    };
  }

  const body = recordOf(response.data);
  const rateLimit = recordOf(body?.rate_limit);
  if (!body || !rateLimit) return { ok: false, code: "failed", message: "unexpected response" };

  const windows: QuotaWindow[] = [];
  for (const [slot, entry] of [rateLimit.primary_window, rateLimit.secondary_window].entries()) {
    const window = windowOf(entry, slot);
    if (window) windows.push(window);
  }
  // A metered feature has its own allowance (Codex Spark and friends); it is a window like any.
  if (Array.isArray(body.additional_rate_limits)) {
    for (const entry of body.additional_rate_limits) {
      const record = recordOf(entry);
      const name = stringOf(record?.limit_name);
      const nested = recordOf(record?.rate_limit);
      const window = windowOf(nested?.primary_window, windows.length);
      if (window) windows.push(name ? { ...window, id: `feature:${name}`, label: name } : window);
    }
  }

  if (windows.length === 0) return { ok: false, code: "failed", message: "unexpected response" };

  const balances: QuotaBalance[] = [];
  const credits = recordOf(body.credits);
  const balance = stringOf(credits?.balance);
  const creditCount = balance === undefined ? undefined : Number(balance);
  if (credits && credits.unlimited !== true && creditCount !== undefined && Number.isFinite(creditCount)) {
    balances.push({ id: "credits", label: "Credits", count: creditCount });
  }

  const extras: QuotaExtra[] = [];
  const plan = stringOf(body.plan_type);
  if (plan) extras.push({ label: "Plan", value: plan });
  const email = stringOf(body.email);
  const resets = resetCreditsOf(
    creditsResponse,
    numberOf(recordOf(body.rate_limit_reset_credits)?.available_count),
  );
  if (credits?.unlimited === true) extras.push({ label: "Credits", value: "unlimited" });

  return {
    ok: true,
    snapshot: {
      provider,
      source: "codex",
      ...(plan ? { plan } : {}),
      ...(email ? { email } : {}),
      windows,
      balances,
      extras,
      ...(resets ? { resets } : {}),
      fetchedAt: new Date().toISOString(),
    },
  };
}

/** The banked credits the plan still holds, with the soonest one to lapse. */
function resetCreditsOf(
  response: Awaited<ReturnType<typeof getJson>>,
  fallbackCount: number | undefined,
): QuotaResetCredits | undefined {
  const available = response.ok ? availableCredits(response.data) : [];
  const count = available.length > 0 ? available.length : (fallbackCount ?? 0);
  if (count <= 0) return undefined;
  const expiries = available
    .map((credit) => isoOf(credit.expires_at))
    .filter((expiry): expiry is string => Boolean(expiry))
    .sort();
  // No eligibility of our own: the provider is the one that decides, and a refusal leaves the
  // credit untouched. A full window is therefore not a condition we impose -- spending one at
  // 80% is the owner's call.
  return { available: count, ...(expiries[0] ? { nextExpiresAt: expiries[0] } : {}) };
}

function availableCredits(data: unknown): Array<Record<string, unknown>> {
  const body = recordOf(data);
  if (!Array.isArray(body?.credits)) return [];
  return body.credits
    .map((entry) => recordOf(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined && entry.status === "available");
}

/**
 * Spends one banked reset. The provider decides eligibility, not us: a window must be full, and
 * the same account has been seen refused with every window full (openai/codex#46854), so the code
 * it answers is what the card says rather than a claim we invented.
 *
 * The soonest expiring credit is the one spent: the only reason to hold two is not to lose one.
 */
export async function consumeCodexReset(
  provider: string,
  token: { accessToken: string; accountId: string },
): Promise<QuotaRedemption> {
  const headers = {
    authorization: `Bearer ${token.accessToken}`,
    "chatgpt-account-id": token.accountId,
    "user-agent": USER_AGENT,
  };
  const list = await getJson(RESET_CREDITS_URL, headers);
  if (!list.ok) {
    return { ok: false, code: list.status === 429 ? "rate-limited" : "failed", message: list.message };
  }
  const credits = availableCredits(list.data)
    .map((credit) => ({ credit, expiry: isoOf(credit.expires_at) ? Date.parse(isoOf(credit.expires_at)!) : Number.POSITIVE_INFINITY }))
    .sort((left, right) => left.expiry - right.expiry);
  const target = credits[0]?.credit;
  const creditId = stringOf(target?.id);
  if (!creditId) return { ok: false, code: "no-credit", message: "No reset credit is available." };

  const response = await postJson(`${RESET_CREDITS_URL}/consume`, headers, {
    credit_id: creditId,
    redeem_request_id: crypto.randomUUID(),
  });
  if (response.ok) return { ok: true, message: "Reset applied." };

  const detail = recordOf(recordOf(response.data)?.detail);
  const code = stringOf(detail?.code);
  if (code === "rate_limit_reset_ineligible") {
    return { ok: false, code: "ineligible", message: "No window is full: nothing to reset." };
  }
  if (code === "noCredit") return { ok: false, code: "no-credit", message: "No reset credit is available." };
  return { ok: false, code: code ?? `http-${response.status}`, message: response.message };
}
