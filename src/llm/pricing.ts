import { join } from "node:path";
import { readFileSync } from "node:fs";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";

/**
 * Per-call cost from models.dev, the community price database.
 *
 * The hard part is not the arithmetic, it is deciding which provider's price applies. The same
 * model id is resold by up to twelve providers at prices spanning a factor of ten, so indexing by
 * model id alone is wrong by an order of magnitude. Resolution is a ladder, strongest evidence
 * first, and anything it cannot establish is reported as unknown rather than as zero.
 *
 * See docs/status-command.md.
 */

const API_URL = "https://models.dev/api.json";
const CACHE_PATH = join(MY_CLAW_DIR, "model-pricing.json");
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

// Bumped whenever the compacted shape changes. A mismatch is treated as no cache at all, because
// silently serving an older shape means missing fields for a full refresh period.
export const CACHE_VERSION = 2;

interface TableEntry {
  // Absent for the ~400 models models.dev describes without publishing a price.
  cost?: ModelCost;
  // Context window in tokens, absent for the 2% that declare none.
  context?: number;
  id: string;
}

/** USD per million tokens. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface PricingCache {
  version: number;
  fetchedAt: string;
  // provider id -> api host, for mapping a base_url back to a provider
  hosts: Record<string, string>;
  // provider id -> lowercased model key -> price and window plus the id they came from, so a match
  // can say whether it is the model itself or a normalised neighbour
  models: Record<string, Record<string, TableEntry>>;
}

export interface CostBreakdown {
  usd: number;
  // Whether this is money actually owed. A subscription, a flat token plan and a self-hosted model
  // all produce a reference figure instead: real, comparable, but not a charge.
  billed: boolean;
  // The price came from a model id we matched rather than the one recorded.
  approximate: boolean;
  // Short trace of which rung of the ladder answered, surfaced in /status so a surprising number
  // can be explained without reading the code.
  source: string;
}

export interface ContextLookup {
  tokens: number;
  // The window came from a model id we matched, or from a median, rather than the one recorded.
  approximate: boolean;
  source: string;
}

export interface UsageForCost {
  model: string;
  baseUrl: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  upstreamApiBase?: string;
  proxyCostUsd?: number;
}

/** Two backends talk to exactly one company, so their vendor is not inferred. */
const ENGINE_PROVIDER: Record<string, string> = {
  "claude-sdk": "anthropic",
  "chatgpt.com": "openai",
};

// Variant and quantisation markers a self-hosted build appends and no catalogue will ever carry.
const VARIANT_SUFFIX = /-(?:uncensored|heretic|instant|mtp|abliterated|thinking|gguf|awq|fp8|fp16|int4|int8|q\d+(?:_k)?(?:_[msl])?)/gi;

/**
 * The same version is written four ways across models.dev -- `4-8`, `4.8`, `4p8`, `48` -- where
 * `p` stands for the decimal point (`glm-5p2`, `kimi-k2p6`). Collapsing any separator between two
 * digits makes them converge. Measured across the 2 776 priced ids: 106 merges, every one a
 * respelling of the same model, none joining two different models. Bounded to digit-digit
 * boundaries so it never touches `gpt-4o` or `k2-code`.
 */
function collapseVersions(s: string): string {
  let out = s;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/(\d)[-._p](\d)/g, "$1$2");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Progressively looser keys for one model id. Each is tried only when the previous found nothing,
 * so an exact match is never overridden by a normalised one.
 */
export function modelKeyCandidates(model: string): string[] {
  const segment = model.split("/").pop() ?? model;
  const stripped = segment.replace(VARIANT_SUFFIX, "").replace(/-+$/, "");
  const out = [
    model,
    segment,
    collapseVersions(segment),
    stripped,
    collapseVersions(stripped),
    collapseVersions(stripped).replace(/[-._\s]/g, ""),
  ];
  return [...new Set(out.map((s) => s.toLowerCase()).filter((s) => s.length > 0))];
}

/**
 * GGUF K-quant tags, which mark a model built to be served locally.
 *
 * Deliberately narrow. Measured across all 6 044 models in models.dev: this pattern matches 3, and
 * none of them is billed. Widening it to the precision formats `BF16`, `AWQ` or `GPTQ` matches 6
 * more, and **all 6 are billed** -- nvidia, cloudflare and nano-gpt all resell models carrying
 * those suffixes at 0.05 to 0.50 USD/M. Those are product names, not evidence of self-hosting.
 */
const SELF_HOSTED_QUANT = /(?:^|[-_.])(I?Q[2-8]_(?:K(?:_[SML])?|[01]|[SML])|I?Q[2-8]_X+[SL]|GGUF)(?:$|[-_.])/i;

/**
 * Whether a model id is evidence of a locally served build, which has no marginal billing at all.
 *
 * Better evidence than the proxy header: LiteLLM answers `x-litellm-response-cost: 0` for these,
 * but that zero means both "free" and "no price on file" and the two cannot be told apart. A quant
 * tag is positive evidence. It says nothing about the context window -- quantisation is weight
 * precision, the window is whatever `--ctx-size` the server was launched with.
 */
export function isSelfHosted(model: string): boolean {
  return SELF_HOSTED_QUANT.test(model);
}

/** Trailing version numbers of a model id: `claude-opus-4-8` -> [4, 8], `claude-opus-5` -> [5]. */
function versionKey(id: string): number[] {
  return (id.match(/\d+/g) ?? []).map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function isFree(cost: ModelCost): boolean {
  return cost.input <= 0 && cost.output <= 0;
}

export class ModelPricing {
  private cache: PricingCache | null = null;
  private hostToProvider = new Map<string, string>();
  private refreshing: Promise<void> | null = null;

  constructor(
    private declaredProviders: () => Record<string, { baseUrl?: string; pricingProvider?: string }>,
    // Discovered models, used only to resolve an alias to a concrete version. Optional so the
    // price table stays usable without a catalogue.
    private catalogModels: () => Array<{ id: string; group?: string; limit?: { context?: number } }> = () => [],
  ) {
    this.loadCache();
  }

  /**
   * `opus`, `sonnet` and `haiku` are not models, they are pointers the vendor resolves server-side,
   * so no price database carries them. The local catalogue does, and files them in the same group
   * as the concrete versions -- recognisable because discovery only reports a context window for a
   * real version, never for an alias.
   *
   * The newest sibling is the right answer because that is what "auto" means, and it matters:
   * `claude-opus-4-1` costs three times `claude-opus-5`, so picking an arbitrary group member
   * would be off by 3x rather than merely imprecise.
   */
  private resolveAlias(model: string): string | undefined {
    const models = this.catalogModels();
    const self = models.find((m) => m.id === model);
    if (!self || !self.group || self.limit?.context) return undefined;
    const siblings = models.filter((m) => m.group === self.group && m.id !== model && m.limit?.context);
    if (siblings.length === 0) return undefined;
    return siblings.sort((a, b) => compareVersions(versionKey(b.id), versionKey(a.id)))[0]?.id;
  }

  /** Fetch on boot when the copy on disk is missing or stale; never blocks a caller. */
  async refreshIfStale(): Promise<void> {
    const age = this.cache ? Date.now() - Date.parse(this.cache.fetchedAt) : Infinity;
    if (Number.isFinite(age) && age < REFRESH_AFTER_MS) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch(API_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as Record<string, RawProvider>;
      const next = compact(raw);
      this.cache = next;
      this.index();
      await writeJsonFileAtomically(CACHE_PATH, next, false);
      void log("info", "model pricing refreshed", { providers: Object.keys(next.models).length });
    } catch (err) {
      // A stale copy prices better than nothing at all, so a failed refresh is not fatal.
      void log("warn", "model pricing refresh failed", { error: String(err), hasCache: this.cache !== null });
    }
  }

  ready(): boolean {
    return this.cache !== null;
  }

  /**
   * Cost of one call. Returns undefined when no rung of the ladder can price it, which is a
   * different statement from zero -- zero is a real price in this data set.
   */
  costOf(usage: UsageForCost): CostBreakdown | undefined {
    // 1. The proxy states what it billed. Only trusted when positive: LiteLLM reports 0.0 both for
    //    a free plan and for a model it has no price for.
    if (usage.proxyCostUsd !== undefined && usage.proxyCostUsd > 0) {
      return { usd: usage.proxyCostUsd, billed: true, approximate: false, source: "proxy" };
    }
    if (!this.cache) return undefined;

    const engine = ENGINE_PROVIDER[usage.baseUrl] ?? ENGINE_PROVIDER[hostOf(usage.baseUrl)];
    if (engine) {
      const hit = this.lookupCost(engine, usage.model);
      // Subscription auth is not metered, so this is a reference price whatever the table says.
      if (hit) return this.priced(usage, hit.cost, false, hit.approximate, `engine ${engine}`);
    }

    // 2/4. The endpoint we called, or the upstream a proxy told us it forwarded to.
    for (const [url, label] of [
      [usage.baseUrl, "host"],
      [usage.upstreamApiBase ?? "", "upstream"],
    ] as const) {
      const provider = url ? this.hostToProvider.get(hostOf(url)) : undefined;
      if (!provider) continue;
      const hit = this.lookupCost(provider, usage.model);
      if (!hit) continue;
      if (!isFree(hit.cost)) return this.priced(usage, hit.cost, true, hit.approximate, `${label} ${provider}`);
      // Never report zero: climb from a flat plan to the vendor for a comparable figure.
      const vendor = this.vendorOf(provider);
      const vendorHit = vendor ? this.lookupCost(vendor, usage.model) : undefined;
      if (vendorHit && !isFree(vendorHit.cost)) {
        return this.priced(usage, vendorHit.cost, false, vendorHit.approximate, `plan ${provider} via ${vendor}`);
      }
    }

    // The owner can name the provider whose prices apply to an endpoint we cannot resolve.
    const declared = this.declaredPricingProvider(usage.baseUrl);
    if (declared) {
      const hit = this.lookupCost(declared, usage.model);
      if (hit && !isFree(hit.cost)) return this.priced(usage, hit.cost, true, hit.approximate, `declared ${declared}`);
    }

    // 5. Last resort. A median describes what a model costs on the open market, not what this
    //    deployment pays for it, so it is never billed and always approximate.
    const median = this.medianCost(usage.model);
    if (median) return this.priced(usage, median.cost, false, true, `median of ${median.offers}`);
    return undefined;
  }

  private priced(usage: UsageForCost, cost: ModelCost, billed: boolean, approximate: boolean, source: string): CostBreakdown {
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    // promptTokens counts every input token, cached ones included, so the fresh remainder is what
    // is billed at the full rate. Clamped because a provider that reports inconsistent buckets
    // must not produce a negative cost.
    const fresh = Math.max(0, usage.promptTokens - cacheRead - cacheWrite);
    const usd =
      (fresh / 1e6) * cost.input +
      (usage.completionTokens / 1e6) * cost.output +
      (cacheRead / 1e6) * (cost.cacheRead ?? cost.input) +
      (cacheWrite / 1e6) * (cost.cacheWrite ?? cost.input);
    return { usd, billed, approximate, source };
  }

  /**
   * `pick` decides what makes an entry a hit, and a key whose entry cannot answer keeps the search
   * going. That matters since the table started carrying priceless models: a looser key holding a
   * real price must not be shadowed by a stricter key that only declares a window.
   */
  /**
   * Context window as published by models.dev, resolved through the same provider ladder as the
   * price because a reseller can serve a smaller window than the vendor. Lives on the price table
   * rather than in its own module: both answers come out of the same 3.3 MB download, and fetching
   * it twice to justify the file name would cost more than the naming stretch.
   *
   * Returns undefined rather than a guess, so the caller can say where the number came from.
   */
  contextWindowOf(model: string, baseUrl?: string, upstreamApiBase?: string): ContextLookup | undefined {
    if (!this.cache) return undefined;
    const pick = (e: TableEntry): number | undefined => e.context;

    const engine = baseUrl ? (ENGINE_PROVIDER[baseUrl] ?? ENGINE_PROVIDER[hostOf(baseUrl)]) : undefined;
    const rungs: Array<[string | undefined, string]> = [
      [engine, engine ? `engine ${engine}` : ""],
      [baseUrl ? this.hostToProvider.get(hostOf(baseUrl)) : undefined, "host"],
      [upstreamApiBase ? this.hostToProvider.get(hostOf(upstreamApiBase)) : undefined, "upstream"],
      [baseUrl ? this.declaredPricingProvider(baseUrl) : undefined, "declared"],
    ];
    for (const [provider, label] of rungs) {
      if (!provider) continue;
      const hit = this.lookup(provider, model, pick);
      if (hit) return { tokens: hit.value, approximate: hit.approximate, source: `${label} ${provider}`.trim() };
    }

    // No provider resolved. A median over every offer of this model describes the window the
    // market publishes for it, and resists a single reseller advertising a truncated one.
    for (const key of modelKeyCandidates(model)) {
      const offers: number[] = [];
      for (const table of Object.values(this.cache.models)) {
        const hit = table[key];
        if (hit?.context !== undefined) offers.push(hit.context);
      }
      if (offers.length === 0) continue;
      const sorted = [...offers].sort((a, b) => a - b);
      const tokens = sorted[Math.floor(sorted.length / 2)];
      if (tokens === undefined) continue;
      return { tokens, approximate: true, source: `median of ${offers.length}` };
    }
    return undefined;
  }

  private lookup<T>(provider: string, model: string, pick: (entry: TableEntry) => T | undefined): { value: T; approximate: boolean } | undefined {
    const table = this.cache?.models[provider];
    if (!table) return undefined;
    for (const key of modelKeyCandidates(model)) {
      const hit = table[key];
      if (!hit) continue;
      const value = pick(hit);
      if (value === undefined) continue;
      // Compare against the id the entry was published under, not against the rung that matched:
      // a loose key can hold an exactly-named model, and a strict key can hold a respelling.
      const exact = hit.id.toLowerCase() === model.toLowerCase() || hit.id.split("/").pop()?.toLowerCase() === model.split("/").pop()?.toLowerCase();
      return { value, approximate: !exact };
    }
    const concrete = this.resolveAlias(model);
    if (concrete) {
      const hit = table[concrete.toLowerCase()];
      const value = hit ? pick(hit) : undefined;
      // Always approximate: the version was inferred from the group, not recorded on the call.
      if (value !== undefined) return { value, approximate: true };
    }
    return undefined;
  }

  private lookupCost(provider: string, model: string): { cost: ModelCost; approximate: boolean } | undefined {
    const hit = this.lookup(provider, model, (e) => e.cost);
    return hit ? { cost: hit.value, approximate: hit.approximate } : undefined;
  }

  /** `xiaomi-token-plan-ams` -> `xiaomi`, `azure-cognitive-services` -> `azure`. */
  private vendorOf(provider: string): string | undefined {
    const parts = provider.split("-");
    for (let n = parts.length - 1; n >= 1; n--) {
      const candidate = parts.slice(0, n).join("-");
      if (this.cache?.models[candidate]) return candidate;
    }
    return undefined;
  }

  private medianCost(model: string): { cost: ModelCost; offers: number } | undefined {
    if (!this.cache) return undefined;
    for (const key of modelKeyCandidates(model)) {
      const offers: ModelCost[] = [];
      for (const table of Object.values(this.cache.models)) {
        const hit = table[key];
        if (hit?.cost && !isFree(hit.cost)) offers.push(hit.cost);
      }
      if (offers.length === 0) continue;
      const mid = (xs: number[]): number => {
        const sorted = [...xs].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] ?? 0;
      };
      const withRead = offers.filter((o) => o.cacheRead !== undefined).map((o) => o.cacheRead!);
      const withWrite = offers.filter((o) => o.cacheWrite !== undefined).map((o) => o.cacheWrite!);
      const cost: ModelCost = { input: mid(offers.map((o) => o.input)), output: mid(offers.map((o) => o.output)) };
      if (withRead.length > 0) cost.cacheRead = mid(withRead);
      if (withWrite.length > 0) cost.cacheWrite = mid(withWrite);
      return { cost, offers: offers.length };
    }
    return undefined;
  }

  private declaredPricingProvider(baseUrl: string): string | undefined {
    for (const provider of Object.values(this.declaredProviders())) {
      if (provider.pricingProvider && provider.baseUrl && hostOf(provider.baseUrl) === hostOf(baseUrl)) {
        return provider.pricingProvider;
      }
    }
    return undefined;
  }

  private index(): void {
    this.hostToProvider.clear();
    for (const [provider, api] of Object.entries(this.cache?.hosts ?? {})) {
      const host = hostOf(api);
      if (host && !this.hostToProvider.has(host)) this.hostToProvider.set(host, provider);
    }
  }

  private loadCache(): void {
    try {
      const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as PricingCache;
      if (parsed.version === CACHE_VERSION && parsed.models && parsed.hosts) {
        this.cache = parsed;
        this.index();
      }
    } catch {
      // No copy yet, or unreadable: refreshIfStale will populate it.
    }
  }
}

interface RawProvider {
  api?: string;
  models?: Record<
    string,
    { cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }; limit?: { context?: number } }
  >;
}

/**
 * models.dev ships 3.3 MB and we need three fields, so only the price table is kept. Ids are
 * indexed both whole and by last path segment, lowercased, because both sides namespace
 * inconsistently: we record `accounts/fireworks/routers/kimi-k2p6-turbo`, models.dev carries
 * `TEE/qwen3.6-35b-a3b-uncensored`.
 */
function compact(raw: Record<string, RawProvider>): PricingCache {
  const hosts: Record<string, string> = {};
  const models: Record<string, Record<string, TableEntry>> = {};
  for (const [provider, entry] of Object.entries(raw)) {
    if (entry.api) hosts[provider] = entry.api;
    const table: Record<string, TableEntry> = {};
    for (const [id, model] of Object.entries(entry.models ?? {})) {
      const c = model.cost;
      let cost: ModelCost | undefined;
      if (c && c.input !== undefined && c.output !== undefined) {
        cost = { input: c.input, output: c.output };
        if (c.cache_read !== undefined) cost.cacheRead = c.cache_read;
        if (c.cache_write !== undefined) cost.cacheWrite = c.cache_write;
      }
      const context = typeof model.limit?.context === "number" && model.limit.context > 0 ? model.limit.context : undefined;
      // A model with a window but no published price is worth keeping now that the table answers
      // both questions; one with neither carries nothing.
      if (!cost && context === undefined) continue;
      const value: TableEntry = { id };
      if (cost) value.cost = cost;
      if (context !== undefined) value.context = context;
      for (const key of modelKeyCandidates(id)) {
        if (!(key in table)) table[key] = value;
      }
    }
    if (Object.keys(table).length > 0) models[provider] = table;
  }
  return { version: CACHE_VERSION, fetchedAt: new Date().toISOString(), hosts, models };
}
