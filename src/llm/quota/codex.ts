/**
 * The ChatGPT plan's own usage endpoint, the one the Codex app shows.
 *
 * The endpoint does not name its windows: it puts them in `primary_window` and `secondary_window`
 * and lets the reader infer. They are identified here by `limit_window_seconds`, because the slots
 * are not a contract: the 5-hour bucket is 18000 s and the weekly one 604800 s, and a plan that
 * drops one of them does not renumber the other.
 */
import { CODEX_BASE_URL } from "../codex-auth.ts";
import { getJson, isAuthFailure } from "./http.ts";
import {
  clampPercent,
  isoOf,
  numberOf,
  recordOf,
  stringOf,
  type QuotaBalance,
  type QuotaExtra,
  type QuotaProbe,
  type QuotaWindow,
} from "./types.ts";

const USAGE_URL = `${CODEX_BASE_URL}/wham/usage`;
const USER_AGENT = "my-claw-quota/1.0";

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
  const response = await getJson(USAGE_URL, {
    authorization: `Bearer ${token.accessToken}`,
    "chatgpt-account-id": token.accountId,
    "user-agent": USER_AGENT,
  });
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
  const resets = numberOf(recordOf(body.rate_limit_reset_credits)?.available_count);
  if (resets !== undefined && resets > 0) extras.push({ label: "Banked resets", value: String(resets) });
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
      fetchedAt: new Date().toISOString(),
    },
  };
}
