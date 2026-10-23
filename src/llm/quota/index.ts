/**
 * The one way to ask a provider what is left.
 *
 * Dispatch, credentials, cache and backoff live here; the four adapters only speak HTTP and shape
 * an answer. A probe is idempotent and read-only, so it is safe to call from a page, from a run
 * that just died, or from both at once: concurrent calls are collapsed into one request.
 */
import { refreshEnvFile, type LlmProviderConfig, type MyClawConfig } from "../../core/config.ts";
import { getCodexAccessToken } from "../codex-auth.ts";
import { loadClaudeToken } from "../claude-auth.ts";
import { claudeQuota, consumeClaudeReset } from "./claude.ts";
import { codexQuota, consumeCodexReset } from "./codex.ts";
import { opencodeGoQuota } from "./opencode-go.ts";
import { openrouterQuota } from "./openrouter.ts";
import type { QuotaFailure, QuotaOutcome, QuotaProbe, QuotaRedemption, QuotaSource } from "./types.ts";

export type { QuotaBalance, QuotaExtra, QuotaFailure, QuotaOutcome, QuotaRedemption, QuotaResetCredits, QuotaSnapshot, QuotaSource, QuotaWindow } from "./types.ts";

/** How long a snapshot is trusted before the next read. The Claude bucket is the touchiest. */
export const QUOTA_TTL_MS: Record<QuotaSource, number> = {
  claude: 300_000,
  codex: 120_000,
  "opencode-go": 120_000,
  openrouter: 120_000,
};

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

interface CacheEntry {
  /** When the last attempt answered, success or not. */
  at: number;
  outcome: QuotaOutcome;
  /** The last snapshot that worked, still worth showing when a later read fails. */
  good?: Extract<QuotaOutcome, { ok: true }>;
  failures: number;
  blockedUntil: number;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<QuotaOutcome>>();

/** Test seam: module state outlives a test file. */
export function resetQuotaCache(): void {
  cache.clear();
  pending.clear();
}

function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Which adapter reads this provider, or nothing.
 *
 * The two subscriptions are recognised by their transport type; the two key-based services by the
 * endpoint they already point at. A custom provider on a compatible base URL is not assumed to
 * speak the same usage API: only the hosts that publish one are matched.
 */
export function quotaSourceOf(provider: LlmProviderConfig | undefined): QuotaSource | undefined {
  if (!provider) return undefined;
  if (provider.type === "anthropic") return "claude";
  if (provider.type === "codex") return "codex";
  const host = hostOf(provider.baseUrl);
  if (host === "opencode.ai" && provider.baseUrl?.includes("/zen/go")) return "opencode-go";
  if (host === "openrouter.ai") return "openrouter";
  return undefined;
}

function apiKeyFor(provider: LlmProviderConfig): string | undefined {
  refreshEnvFile();
  return provider.apiKeyEnv ? process.env[provider.apiKeyEnv] || undefined : undefined;
}

async function probe(provider: string, config: LlmProviderConfig, source: QuotaSource): Promise<QuotaOutcome> {
  if (source === "claude") {
    const token = await loadClaudeToken(provider);
    if (!token) return { ok: false, code: "not-signed-in", message: "Not signed in to Claude." };
    return claudeQuota(provider, token);
  }

  if (source === "codex") {
    try {
      const token = await getCodexAccessToken(provider);
      return await codexQuota(provider, token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: /not signed in/i.test(message) ? "not-signed-in" : "failed", message };
    }
  }

  const key = apiKeyFor(config);
  if (!key) {
    return {
      ok: false,
      code: "not-signed-in",
      message: `No API key: ${config.apiKeyEnv ?? "apiKey"} is not set.`,
    };
  }
  if (source === "opencode-go") return opencodeGoQuota(provider, key);
  return openrouterQuota(provider, key, config.baseUrl);
}

function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

function remember(provider: string, result: QuotaProbe): QuotaOutcome {
  const previous = cache.get(provider);
  if (result.ok) {
    const outcome: QuotaOutcome = { ok: true, snapshot: result.snapshot };
    cache.set(provider, { at: Date.now(), outcome, good: outcome, failures: 0, blockedUntil: 0 });
    return outcome;
  }

  const failures = (previous?.failures ?? 0) + 1;
  const blockedUntil = result.code === "rate-limited" ? Date.now() + (result.retryAfterMs ?? backoffMs(failures)) : 0;
  const outcome: QuotaOutcome = {
    ok: false,
    code: result.code,
    message: result.message,
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
  };
  cache.set(provider, { at: Date.now(), outcome, good: previous?.good, failures, blockedUntil });
  return previous?.good ? { ...previous.good, stale: true } : outcome;
}

/**
 * The snapshot for one provider. `force` asks for a fresh read now; it does not lift a cooldown a
 * 429 just set, because that cooldown is the provider's own answer.
 */
export async function quotaFor(
  config: MyClawConfig,
  provider: string,
  options: { force?: boolean } = {},
): Promise<QuotaOutcome> {
  const providerConfig = config.llm?.providers?.[provider];
  const source = quotaSourceOf(providerConfig);
  if (!source || !providerConfig) {
    return { ok: false, code: "no-source", message: `${provider} publishes no usage API.` };
  }

  const now = Date.now();
  const cached = cache.get(provider);
  if (cached && now < cached.blockedUntil) {
    return cached.good ? { ...cached.good, stale: true } : cached.outcome;
  }
  if (cached && !options.force && now - cached.at < QUOTA_TTL_MS[source]) return cached.outcome;

  const running = pending.get(provider);
  if (running) return running;

  const task = probe(provider, providerConfig, source)
    .then((result) => remember(provider, result))
    .catch((err): QuotaOutcome => {
      const failure: QuotaFailure = "failed";
      return { ok: false, code: failure, message: err instanceof Error ? err.message : String(err) };
    })
    .finally(() => pending.delete(provider));

  pending.set(provider, task);
  return task;
}

/**
 * Spends one banked reset. Only Codex grants them: Anthropic has no equivalent, and its extra
 * usage is a billing switch in its console, not a credit a client can redeem.
 */
export async function redeemQuota(config: MyClawConfig, provider: string): Promise<QuotaRedemption> {
  const providerConfig = config.llm?.providers?.[provider];
  const source = quotaSourceOf(providerConfig);
  if (!providerConfig || (source !== "codex" && source !== "claude")) {
    return { ok: false, code: "unsupported", message: "This provider grants no resettable credits." };
  }

  if (source === "claude") {
    const token = await loadClaudeToken(provider);
    if (!token) return { ok: false, code: "sign-in-expired", message: "Not signed in to Claude." };
    // The inventory says whether a claim would even be accepted; a forced read keeps a stale
    // card from sending one the provider is going to refuse.
    const current = await quotaFor(config, provider, { force: true });
    if (!current.ok) return { ok: false, code: "unavailable", message: "Usage is unavailable right now." };
    const resets = current.snapshot.resets;
    if (!resets?.usable) {
      return {
        ok: false,
        code: "not-usable",
        message: resets?.blocked ? `This reset cannot be used: ${resets.blocked}.` : "No reset is available.",
      };
    }
    const result = await consumeClaudeReset(token);
    await quotaFor(config, provider, { force: true });
    return result;
  }

  // A full window is what the provider checks, so ask now instead of trusting a card that may be
  // minutes old. A refusal from the backend is still surfaced below; this only avoids one.
  const current = await quotaFor(config, provider, { force: true });
  if (!current.ok) return { ok: false, code: "unavailable", message: "Usage is unavailable right now." };
  if (!current.snapshot.windows.some((window) => window.usedPercent >= 99)) {
    return { ok: false, code: "not-limited", message: "No window is full: nothing to reset." };
  }

  let token: { accessToken: string; accountId: string };
  try {
    token = await getCodexAccessToken(provider);
  } catch (err) {
    return { ok: false, code: "sign-in-expired", message: err instanceof Error ? err.message : String(err) };
  }

  const result = await consumeCodexReset(provider, token);
  // The card is stale either way: a credit may be gone, or a window may have moved.
  await quotaFor(config, provider, { force: true });
  return result;
}
