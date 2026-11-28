/**
 * What a provider says about its own limits, in one shape for every surface.
 *
 * `windows` are periodic allowances and carry a **used** percentage; `balances` are money or a
 * count of credits and never become a percentage. The two are not interchangeable: a balance with
 * 12 credits left says nothing about when a window refills, and a window at 100% says nothing
 * about a wallet.
 */
export type QuotaSource = "claude" | "codex" | "opencode-go" | "openrouter" | "synthetic" | "mistral";

export interface QuotaWindow {
  /** Stable within a source: `session`, `weekly_all`, `rolling`, `month`... */
  id: string;
  label: string;
  usedPercent: number;
  /** ISO 8601, absent when the provider does not say. */
  resetAt?: string;
  windowSeconds?: number;
}

export interface QuotaBalance {
  id: string;
  label: string;
  currency?: string;
  remaining?: number;
  total?: number;
  /** Credits, when the provider counts them instead of pricing them. */
  count?: number;
}

export interface QuotaExtra {
  label: string;
  value: string;
}

/** Reset credits a plan has banked: OpenAI's saved rate-limit resets, and Anthropic's limit
 *  resets (the `cedar_ember` grants). */
export interface QuotaResetCredits {
  available: number;
  /** ISO: the soonest credit to lapse, so the card can say which one to spend first. */
  nextExpiresAt?: string;
  /** What the grant clears, as the provider names it ("weekly", "5 h"). */
  clears?: string;
}

export interface QuotaSnapshot {
  provider: string;
  source: QuotaSource;
  plan?: string;
  email?: string;
  windows: QuotaWindow[];
  balances: QuotaBalance[];
  extras: QuotaExtra[];
  resets?: QuotaResetCredits;
  fetchedAt: string;
}

/** Why a provider cannot be read. `no-source` is the normal case, not an error. */
export type QuotaFailure = "no-source" | "not-signed-in" | "sign-in-expired" | "rate-limited" | "failed";

export type QuotaProbe =
  | { ok: true; snapshot: QuotaSnapshot }
  | { ok: false; code: QuotaFailure; message: string; retryAfterMs?: number };

/** The answer to a claim of one banked reset. */
export interface QuotaRedemption {
  ok: boolean;
  code?: string;
  message: string;
}

/** A probe answer plus what the cache knows: a stale snapshot is better than no card. */
export type QuotaOutcome =
  | { ok: true; snapshot: QuotaSnapshot; stale?: boolean }
  | { ok: false; code: QuotaFailure; message: string; retryAfterMs?: number };

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** A provider timestamp as ISO. Accepts an ISO string and epoch seconds. */
export function isoOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}
