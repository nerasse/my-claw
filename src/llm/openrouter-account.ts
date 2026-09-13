/**
 * What OpenRouter says the key has spent, and what is left on it.
 *
 * The one figure in this system that comes from a provider's own ledger rather than from a price
 * table. It is an account-wide total, not a per-call breakdown: `/api/v1/generation?id=` answers
 * 404 for the ids we could keep, and `/api/v1/activity` answers 403 to this key, so reconciling
 * call by call is not on offer. Reconciling by amount is -- see docs/status-command.md.
 *
 * Read from a cache the report never waits on, for the same reason the provider names are
 * (`cachedOpenRouterProviderName`): a status page may not hang on a third party, and may not fail
 * because one is down.
 */

import type { LlmProviderConfig } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { isOpenRouterBaseUrl } from "./openrouter-endpoints.ts";

const API_BASE = "https://openrouter.ai/api/v1";

/**
 * How long a reading stands. The page is redrawn on every recorded call, so a shorter window turns
 * one active conversation into a poll; a longer one lets the figure drift away from the delta it is
 * there to explain. Five minutes is under a minute of spend at any rate this instance runs at, and
 * caps an open page at twelve calls an hour.
 */
const ACCOUNT_TTL_MS = 5 * 60_000;

/** A failure is remembered too, briefly: an API that is down must not be asked once per redraw. */
const FAILURE_TTL_MS = 60_000;

/** Short on purpose: nothing waits on this, but a socket that never answers must not hold the slot. */
const FETCH_TIMEOUT_MS = 3_000;

export interface OpenRouterAccount {
  /** What this key has spent, as OpenRouter counts it, since the key was created. */
  usageUsd: number;
  /** Credits bought minus credits spent. Absent when `/credits` declined and `/key` did not. */
  balanceUsd?: number;
}

/** `null` is a failure we remember; a fresh entry is answered from here and never refetched. */
interface Cached {
  at: number;
  value: OpenRouterAccount | null;
}

let cache: Cached | undefined;
let inFlight: Promise<void> | undefined;

function fresh(entry: Cached | undefined): entry is Cached {
  if (!entry) return false;
  return Date.now() - entry.at < (entry.value === null ? FAILURE_TTL_MS : ACCOUNT_TTL_MS);
}

/**
 * The key the OpenRouter catalogue is read with, by the path the catalogue reads it: the provider
 * whose base URL is OpenRouter, and the environment variable it names. No second place to configure
 * one -- a key declared twice is a key that rotates in one of the two.
 */
export function openRouterApiKey(providers: Record<string, LlmProviderConfig> | undefined): string | undefined {
  for (const provider of Object.values(providers ?? {})) {
    if (!isOpenRouterBaseUrl(provider.baseUrl) || !provider.apiKeyEnv) continue;
    const key = process.env[provider.apiKeyEnv];
    if (key) return key;
  }
  return undefined;
}

/**
 * The account figures if they are in memory and fresh, never reaching the network.
 *
 * A cold cache and an unreachable API answer the same thing, and the line says so the same way:
 * both are "we do not have the provider's number right now", and neither is worth a second wording
 * on a page that is redrawn every time the conversation moves.
 */
export function cachedOpenRouterAccount(): OpenRouterAccount | undefined {
  return fresh(cache) ? cache.value ?? undefined : undefined;
}

/** Start a refresh when the cache is stale and none is running. Never awaited by a caller. */
export function warmOpenRouterAccount(apiKey: string): void {
  if (fresh(cache) || inFlight) return;
  void refreshOpenRouterAccount(apiKey);
}

async function getJson(path: string, apiKey: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function numberOf(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Ask OpenRouter what the key has spent and what it has left, and cache the answer.
 *
 * `/key` is the reading that matters and `/credits` only decorates it, so the two are asked
 * together and judged apart: no usage is a failure, no balance is a line with one less number on
 * it. Exported for the tests, which drive it directly rather than racing a background warm.
 */
export async function refreshOpenRouterAccount(apiKey: string): Promise<void> {
  const run = (async (): Promise<void> => {
    const [key, credits] = await Promise.allSettled([getJson("/key", apiKey), getJson("/credits", apiKey)]);
    if (key.status === "rejected") {
      void log("warn", "openrouter account lookup failed", { error: String(key.reason) });
      cache = { at: Date.now(), value: null };
      return;
    }
    const usageUsd = numberOf((key.value as { data?: { usage?: unknown } }).data?.usage);
    if (usageUsd === undefined) {
      void log("warn", "openrouter account lookup returned no usage");
      cache = { at: Date.now(), value: null };
      return;
    }
    const balanceRaw = credits.status === "fulfilled" ? (credits.value as { data?: { total_credits?: unknown; total_usage?: unknown } }).data : undefined;
    const total = numberOf(balanceRaw?.total_credits);
    const spent = numberOf(balanceRaw?.total_usage);
    cache = {
      at: Date.now(),
      value: { usageUsd, ...(total === undefined || spent === undefined ? {} : { balanceUsd: total - spent }) },
    };
  })();
  inFlight = run.finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/** Test seam: module state outlives a file, and a key's figures must not reach another one. */
export function resetOpenRouterAccount(): void {
  cache = undefined;
  inFlight = undefined;
}
