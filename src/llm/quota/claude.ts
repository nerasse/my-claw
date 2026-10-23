/**
 * The Claude subscription's own usage endpoint, the one Claude Code's `/usage` reads.
 *
 * Undocumented, so every field is optional here and an unknown shape is a failure rather than a
 * crash. The client User-Agent is not decoration: the endpoint rate-limits an unknown caller into
 * a persistent 429, which then looks exactly like a spent quota.
 *
 * `cedar_ember` is Claude's saved-reset inventory (Settings > Usage, "Reset for free"). It comes
 * back on the same request when asked for, and the claim is filed against the account's
 * organization, so a redemption needs the profile too -- docs/quota.md.
 */
import { claudeRelease } from "../anthropic-release.ts";
import { getJson, isAuthFailure, postJson } from "./http.ts";
import {
  clampPercent,
  isoOf,
  numberOf,
  recordOf,
  stringOf,
  type QuotaProbe,
  type QuotaRedemption,
  type QuotaResetCredits,
  type QuotaWindow,
} from "./types.ts";

const API = "https://api.anthropic.com";
const USAGE_URL = `${API}/api/oauth/usage`;
const RESET_INVENTORY_URL = `${API}/api/oauth/usage?cedar_ember=1&skip_spend=1`;
const PROFILE_URL = `${API}/api/oauth/profile`;
const RESET_PROGRAM = "cedar_ember";
/** Same bound the Claude Code client uses for its claim. */
const CLAIM_TIMEOUT_MS = 25_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The identity the reset inventory is gated on. Claude Code lists grants to its own client
 * (`external, cli`), not to the `sdk-cli` identity model requests use.
 */
function resetUserAgent(): string {
  return `claude-cli/${claudeRelease().version} (external, cli)`;
}

function headers(token: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": resetUserAgent(),
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function labelFor(kind: string, scope: string | undefined): string {
  if (kind === "session") return "5 h";
  if (kind === "weekly_all") return "Week · all models";
  if (kind === "weekly_scoped") return scope ? `Week · ${scope}` : "Week · scoped";
  return kind.replaceAll("_", " ");
}

/**
 * What a scoped weekly limit is scoped to.
 *
 * The shape moved: `scope` is an object now (`{ model: { display_name }, surface }`), and a plain
 * string before that. Read as a string it came back undefined and every scoped weekly limit drew
 * itself as "Week", so a plan showed two identical rows and the one it was actually about was
 * lost (2026-10-23).
 */
function scopeName(value: unknown): string | undefined {
  const record = recordOf(value);
  if (!record) return stringOf(value);
  const model = recordOf(record.model);
  return stringOf(model?.display_name) ?? stringOf(model?.id) ?? stringOf(record.surface);
}

function windowOf(entry: Record<string, unknown>, fallbackId: string): QuotaWindow | undefined {
  const percent = numberOf(entry.percent) ?? numberOf(entry.utilization);
  if (percent === undefined) return undefined;
  const kind = stringOf(entry.kind) ?? fallbackId;
  const scope = scopeName(entry.scope);
  const windowSeconds = numberOf(entry.window_seconds);
  const resetAt = isoOf(entry.resets_at);
  return {
    id: scope ? `${kind}:${scope}` : kind,
    label: labelFor(kind, scope),
    usedPercent: clampPercent(percent),
    ...(resetAt ? { resetAt } : {}),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
  };
}

interface ClaudeGrant {
  id: string;
  resetsLeft: number;
  label?: string;
  startsAt?: string;
  endsAt?: string;
  paused: boolean;
  clears: string[];
}

interface ClaudeResetBlock {
  nextGrantId?: string;
  grants: ClaudeGrant[];
}

function grantOf(value: unknown): ClaudeGrant | undefined {
  const grant = recordOf(value);
  const id = stringOf(grant?.id);
  const resetsLeft = numberOf(grant?.resets_left);
  if (!grant || !id || resetsLeft === undefined || resetsLeft <= 0) return undefined;
  const startsAt = isoOf(grant.starts_at);
  const endsAt = isoOf(grant.ends_at);
  return {
    id,
    resetsLeft,
    ...(stringOf(grant.label) ? { label: stringOf(grant.label)! } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    paused: grant.paused === true,
    clears: Array.isArray(grant.clears) ? grant.clears.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

function resetBlockOf(value: unknown): ClaudeResetBlock | undefined {
  const block = recordOf(value);
  if (!block) return undefined;
  const grants: ClaudeGrant[] = [];
  for (const raw of Array.isArray(block.grants) ? block.grants : []) {
    const grant = grantOf(raw);
    if (grant) grants.push(grant);
  }
  const nextGrantId = stringOf(block.next_grant_id);
  return { ...(nextGrantId ? { nextGrantId } : {}), grants };
}

/** Started, not paused, not expired, with something left to spend. */
function activeGrants(block: ClaudeResetBlock, now = Date.now()): ClaudeGrant[] {
  return block.grants.filter((grant) => {
    if (grant.paused || grant.resetsLeft <= 0) return false;
    if (grant.startsAt && Date.parse(grant.startsAt) > now) return false;
    if (grant.endsAt && Date.parse(grant.endsAt) <= now) return false;
    return true;
  });
}

function clearsLabel(grants: ClaudeGrant[]): string | undefined {
  const windows = new Set<string>();
  for (const grant of grants) {
    for (const window of grant.clears) {
      windows.add(window === "five_hour" ? "5 h" : window === "seven_day" ? "weekly" : window.replaceAll("_", " "));
    }
  }
  return windows.size > 0 ? [...windows].join(" + ") : undefined;
}

function resetCreditsOf(block: ClaudeResetBlock, now = Date.now()): QuotaResetCredits | undefined {
  const active = activeGrants(block, now);
  const available = active.reduce((sum, grant) => sum + grant.resetsLeft, 0);
  if (available <= 0) return undefined;
  const expiries = active
    .map((grant) => grant.endsAt)
    .filter((expiry): expiry is string => Boolean(expiry))
    .sort();
  const clears = clearsLabel(active);
  return {
    available,
    ...(expiries[0] ? { nextExpiresAt: expiries[0] } : {}),
    ...(clears ? { clears } : {}),
  };
}

/**
 * The windows, plus the reset inventory when the endpoint answers it. A 400/403 on the extended
 * query falls back to the plain one: unsupported reset queries must not cost the usage windows.
 */
export async function claudeQuota(provider: string, token: string): Promise<QuotaProbe> {
  let response = await getJson(RESET_INVENTORY_URL, headers(token));
  if (!response.ok && (response.status === 400 || response.status === 403)) {
    response = await getJson(USAGE_URL, headers(token));
  }
  if (!response.ok) {
    return {
      ok: false,
      code: response.status === 429 ? "rate-limited" : isAuthFailure(response.status) ? "sign-in-expired" : "failed",
      message: response.message,
      ...(response.retryAfterMs === undefined ? {} : { retryAfterMs: response.retryAfterMs }),
    };
  }

  const body = recordOf(response.data);
  if (!body) return { ok: false, code: "failed", message: "unexpected response" };

  const windows: QuotaWindow[] = [];
  if (Array.isArray(body.limits)) {
    for (const entry of body.limits) {
      const record = recordOf(entry);
      const window = record ? windowOf(record, "window") : undefined;
      if (window) windows.push(window);
    }
  }
  // An older shape, and the one every community tool started from.
  for (const [key, id] of [["five_hour", "session"], ["seven_day", "weekly_all"]] as const) {
    if (windows.some((window) => window.id === id)) continue;
    const record = recordOf(body[key]);
    const window = record ? windowOf(record, id) : undefined;
    if (window) windows.push({ ...window, id, label: id === "session" ? "5 h" : "Week · all models" });
  }

  const extra = recordOf(body.extra_usage);
  if (extra?.is_enabled === true) {
    const percent = numberOf(extra.utilization);
    if (percent !== undefined) {
      windows.push({ id: "extra", label: "Extra usage", usedPercent: clampPercent(percent) });
    }
  }

  if (windows.length === 0) return { ok: false, code: "failed", message: "unexpected response" };
  const block = resetBlockOf(body.cedar_ember);
  const resets = block ? resetCreditsOf(block) : undefined;
  return {
    ok: true,
    snapshot: {
      provider,
      source: "claude",
      windows,
      balances: [],
      extras: [],
      ...(resets ? { resets } : {}),
      fetchedAt: new Date().toISOString(),
    },
  };
}

/**
 * Spends one saved reset. The grant, the eligibility and the cooldown are the provider's; we
 * spend the one it names, or the one that lapses first.
 *
 * An unreadable answer to the claim is `unknown`, never a retry: the request may have run, and a
 * second one would spend a second reset.
 */
export async function consumeClaudeReset(token: string): Promise<QuotaRedemption> {
  const inventory = await getJson(RESET_INVENTORY_URL, headers(token));
  if (!inventory.ok) {
    return {
      ok: false,
      code: inventory.status === 429 ? "rate-limited" : isAuthFailure(inventory.status) ? "sign-in-expired" : "unavailable",
      message: inventory.message,
    };
  }
  const block = resetBlockOf(recordOf(inventory.data)?.cedar_ember);
  if (!block) return { ok: false, code: "unavailable", message: "Reset inventory is unavailable." };

  // Every active grant is offered, whatever its `use_requires_limit` says: the provider decides,
  // and a refusal costs nothing. Spending a reset at 80% is the owner's call, not ours.
  const candidates = activeGrants(block, Date.now());
  const target =
    candidates.find((grant) => grant.id === block.nextGrantId) ??
    candidates.sort((left, right) => Date.parse(left.endsAt ?? "9999-12-31") - Date.parse(right.endsAt ?? "9999-12-31"))[0];
  if (!target) return { ok: false, code: "no-credit", message: "No reset is available." };

  const profile = await getJson(PROFILE_URL, headers(token));
  const organization = recordOf(recordOf(profile.ok ? profile.data : undefined)?.organization);
  const organizationId = stringOf(organization?.uuid);
  if (!organizationId || !UUID_RE.test(organizationId)) {
    return { ok: false, code: "failed", message: "Could not read the account organization." };
  }

  const claim = await postJson(
    `${API}/api/organizations/${encodeURIComponent(organizationId.toLowerCase())}/reset_rate_limits`,
    headers(token, true),
    { program: RESET_PROGRAM, grant_id: target.id, request_id: crypto.randomUUID() },
    CLAIM_TIMEOUT_MS,
  );
  if (!claim.ok) {
    if (claim.status === 429) return { ok: false, code: "rate-limited", message: "The provider is rate-limiting the reset request." };
    if (isAuthFailure(claim.status)) return { ok: false, code: "sign-in-expired", message: "The sign-in was refused." };
    // A 5xx, a timeout or an unreadable body: the claim may have run.
    return { ok: false, code: "unknown", message: "The reset may or may not have been applied; check the usage page before trying again." };
  }

  switch (stringOf(recordOf(claim.data)?.result)) {
    case "reset":
      return { ok: true, message: "Usage reset." };
    case "already_used":
      return { ok: false, code: "already-used", message: "That reset was already used." };
    case "not_limited":
      return { ok: false, code: "not-limited", message: "No window is full: nothing to reset." };
    case "cooldown":
      return { ok: false, code: "cooldown", message: "A reset was used recently; try again later." };
    case "ineligible":
      return { ok: false, code: "ineligible", message: "This account is not eligible for a reset." };
    case "unavailable":
      return { ok: false, code: "unavailable", message: "The reset service is unavailable." };
    default:
      return { ok: false, code: "unknown", message: "The reset may or may not have been applied; check the usage page before trying again." };
  }
}
