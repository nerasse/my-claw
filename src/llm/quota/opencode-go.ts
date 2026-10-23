/**
 * OpenCode Go publishes its three windows on the endpoint its own console reads: a rolling 5-hour
 * window, a week and a month. `status` is `ok` or `rate-limited`; the percentage is relative to
 * each window's own cap (20 % of the monthly allowance for the 5-hour one, 50 % for the week), so
 * the numbers are shown as they come and never summed.
 */
import { getJson, isAuthFailure } from "./http.ts";
import { clampPercent, isoOf, numberOf, recordOf, stringOf, type QuotaProbe, type QuotaWindow } from "./types.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
/**
 * The only place a Go key names whose plan it is. The usage endpoint answers percentages and
 * nothing else; the console's member list carries the email, and a Go workspace has one member.
 */
const MEMBERS_URL = "https://opencode.ai/console/api/v1/budgets/members";
const IDENTITY_TIMEOUT_MS = 4_000;

const WINDOWS: ReadonlyArray<{ key: string; id: string; label: string }> = [
  { key: "rolling", id: "rolling", label: "5 h" },
  { key: "weekly", id: "weekly", label: "Week" },
  { key: "monthly", id: "monthly", label: "Month" },
];

export async function opencodeGoQuota(provider: string, apiKey: string): Promise<QuotaProbe> {
  const [response, members] = await Promise.all([
    getJson(USAGE_URL, { authorization: `Bearer ${apiKey}` }),
    // Best effort, and on its own budget: an identity the key may not read must not hold up the
    // numbers the card is actually about.
    getJson(MEMBERS_URL, { authorization: `Bearer ${apiKey}` }, IDENTITY_TIMEOUT_MS),
  ]);
  if (!response.ok) {
    return {
      ok: false,
      code: response.status === 429 ? "rate-limited" : isAuthFailure(response.status) ? "not-signed-in" : "failed",
      message: response.message,
      ...(response.retryAfterMs === undefined ? {} : { retryAfterMs: response.retryAfterMs }),
    };
  }

  const usage = recordOf(recordOf(response.data)?.usage);
  if (!usage) return { ok: false, code: "failed", message: "unexpected response" };

  const windows: QuotaWindow[] = [];
  const limited: string[] = [];
  for (const { key, id, label } of WINDOWS) {
    const entry = recordOf(usage[key]);
    if (!entry) continue;
    const percent = numberOf(entry.percent);
    if (percent === undefined) continue;
    const resetAt = isoOf(entry.resetsAt) ?? isoOf(entry.resets_at);
    if (stringOf(entry.status) === "rate-limited") limited.push(label);
    windows.push({
      id,
      label,
      usedPercent: clampPercent(percent),
      ...(resetAt ? { resetAt } : {}),
    });
  }

  if (windows.length === 0) return { ok: false, code: "failed", message: "unexpected response" };
  const email = emailOf(members);
  return {
    ok: true,
    snapshot: {
      provider,
      source: "opencode-go",
      ...(email ? { email } : {}),
      windows,
      balances: [],
      extras: limited.length > 0 ? [{ label: "Limit reached", value: limited.join(", ") }] : [],
      fetchedAt: new Date().toISOString(),
    },
  };
}

/** A member list answers an email only when there is one member: the key does not say which is its own. */
function emailOf(members: Awaited<ReturnType<typeof getJson>>): string | undefined {
  if (!members.ok || !Array.isArray(members.data)) return undefined;
  const emails = members.data
    .map((entry) => stringOf(recordOf(entry)?.email))
    .filter((email): email is string => Boolean(email));
  return emails.length === 1 ? emails[0] : undefined;
}
