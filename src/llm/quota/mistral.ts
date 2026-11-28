/**
 * Mistral's two purses, read from the billing API the Vibe CLI itself uses.
 *
 * `GET /v1/billing/budget` answers both pools at once: `vibe_budget` is the monthly Vibe Code
 * allowance (510 EUR on this plan, 3.77 % used on 2026-11-28), `api_budget` is the separate API
 * credit the same subscription grants (51 EUR). They are not interchangeable -- a key whose own
 * spending limit is 0 answers `402 billing_spend_limit_api_key` on a plain API call while a Vibe
 * call with `metadata.call_source: "vibe_code"` goes through on the Vibe pool -- so the card shows
 * them apart rather than summing them.
 *
 * `GET /v1/billing/subscription` names the plan, and `payg_enabled` says whether spending can
 * continue past the allowance. Both are optional on self-hosted platforms: a failure there must
 * not cost the budget read.
 */
import { getJson, isAuthFailure } from "./http.ts";
import { clampPercent, isoOf, numberOf, recordOf, type QuotaBalance, type QuotaProbe, type QuotaWindow } from "./types.ts";

const API_BASE = "https://api.mistral.ai/v1";
const BUDGET_URL = `${API_BASE}/billing/budget`;
const SUBSCRIPTION_URL = `${API_BASE}/billing/subscription`;
const IDENTITY_URL = `${API_BASE}/users/me`;
const IDENTITY_TIMEOUT_MS = 4_000;

interface BudgetDetail {
  usedPercent: number;
  total?: number;
  currency?: string;
  resetAt?: string;
  payg?: boolean;
}

function budgetDetail(value: unknown): BudgetDetail | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  const used = numberOf(record["usage_percentage"]);
  if (used === undefined) return undefined;
  const total = numberOf(record["initial_budget"]);
  const resetAt = isoOf(record["reset_at"]);
  return {
    usedPercent: clampPercent(used),
    ...(total === undefined ? {} : { total }),
    ...(typeof record["currency"] === "string" ? { currency: record["currency"] } : {}),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(typeof record["payg_enabled"] === "boolean" ? { payg: record["payg_enabled"] } : {}),
  };
}

function nameOf(value: unknown): string | undefined {
  const name = recordOf(value)?.["name"];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function balanceOf(id: string, label: string, detail: BudgetDetail | undefined): QuotaBalance | undefined {
  if (!detail || detail.total === undefined) return undefined;
  return {
    id,
    label,
    ...(detail.currency === undefined ? {} : { currency: detail.currency }),
    remaining: Math.max(0, detail.total * (1 - detail.usedPercent / 100)),
    total: detail.total,
  };
}

export async function mistralQuota(provider: string, apiKey: string): Promise<QuotaProbe> {
  const [budget, subscription, identity] = await Promise.all([
    getJson(BUDGET_URL, { authorization: `Bearer ${apiKey}` }),
    // Best effort on its own shorter budget: the plan name is decoration, the budget is the card.
    getJson(SUBSCRIPTION_URL, { authorization: `Bearer ${apiKey}` }, IDENTITY_TIMEOUT_MS),
    // The key itself names nobody in the budget answer; `/users/me` is where the account's email
    // and its workspace live, the same way the OpenCode card finds its member.
    getJson(IDENTITY_URL, { authorization: `Bearer ${apiKey}` }, IDENTITY_TIMEOUT_MS),
  ]);
  if (!budget.ok) {
    return {
      ok: false,
      code: budget.status === 429 ? "rate-limited" : isAuthFailure(budget.status) ? "not-signed-in" : "failed",
      // A keyed provider has no sign-in page: the card must not tell the owner to sign in.
      message: isAuthFailure(budget.status) ? "the Mistral API key was refused" : budget.message,
      ...(budget.retryAfterMs === undefined ? {} : { retryAfterMs: budget.retryAfterMs }),
    };
  }

  const body = recordOf(budget.data);
  if (!body) return { ok: false, code: "failed", message: "unexpected response" };
  const vibe = budgetDetail(body["vibe_budget"]);
  const api = budgetDetail(body["api_budget"]) ?? budgetDetail(body);
  if (!vibe && !api) return { ok: false, code: "failed", message: "no budget in the response" };

  const plan = subscription.ok ? recordOf(subscription.data) : undefined;
  const planName = typeof plan?.["plan_name"] === "string" ? plan["plan_name"] : undefined;
  const account = identity.ok ? recordOf(identity.data) : undefined;
  const email = typeof account?.["email"] === "string" ? account["email"] : undefined;
  const workspace = nameOf(account?.["workspace"]);
  const organization = nameOf(account?.["organization"]);

  const windows: QuotaWindow[] = [];
  if (vibe) {
    windows.push({
      id: "vibe",
      label: "Vibe",
      usedPercent: vibe.usedPercent,
      windowSeconds: 2_628_000,
      ...(vibe.resetAt === undefined ? {} : { resetAt: vibe.resetAt }),
    });
  }

  const balances = [
    balanceOf("vibe", "Vibe credits", vibe),
    balanceOf("api", "API credits", api),
  ].filter((balance): balance is QuotaBalance => balance !== undefined);

  const payg = plan?.["vibe_payg_enabled"] ?? plan?.["payg_enabled"] ?? vibe?.payg ?? api?.payg;
  const extras = [
    ...(organization === undefined ? [] : [{ label: "Organization", value: organization }]),
    ...(workspace === undefined ? [] : [{ label: "Workspace", value: workspace }]),
    ...(payg === true ? [{ label: "Pay as you go", value: "on" }] : []),
  ];
  return {
    ok: true,
    snapshot: {
      provider,
      source: "mistral",
      ...(planName === undefined ? {} : { plan: planName }),
      ...(email === undefined ? {} : { email }),
      windows,
      balances,
      extras,
      fetchedAt: new Date().toISOString(),
    },
  };
}
