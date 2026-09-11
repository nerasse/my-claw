import { join } from "node:path";
import { readFileSync } from "node:fs";
import { MY_CLAW_DIR, type EffortLevel, type ReasoningField } from "../core/config.ts";
import { writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { cachedOpenRouterEndpointPricing, cachedOpenRouterModel } from "./openrouter-endpoints.ts";
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
export const CACHE_VERSION = 4;

interface TableEntry {
  // Absent for the ~400 models models.dev describes without publishing a price.
  cost?: ModelCost;
  // Context window in tokens, absent for the 2% that declare none.
  context?: number;
  id: string;
  // The capability half of the entry, used to describe models whose own provider lists nothing but
  // ids -- see docs/model-metadata.md. All optional: this database is uneven by nature.
  name?: string;
  // Reasoning ladder as published, already filtered to our vocabulary and ordered bottom-up.
  effort?: EffortLevel[];
  // A model that only declares an on/off reasoning switch. Read as two rungs, `none` and `high`,
  // measured to be honoured on the wire even though the switch is not an effort ladder.
  effortToggle?: boolean;
  vision?: boolean;
  output?: number;
  // Which message field this model wants its own reasoning handed back in, from models.dev's
  // `interleaved`. Published for 881 models: 819 say `reasoning_content`, 14 `reasoning_details`.
  // Per model and not per provider -- OpenRouter alone publishes both. See docs/reasoning-replay.md.
  reasoningField?: ReasoningField;
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

/**
 * What the database says a model can do, for providers that answer with ids and nothing else.
 * Every field is optional and only ever fills a gap: see docs/model-metadata.md R7.
 */
export interface ModelMetadata {
  label?: string;
  effortLevels?: EffortLevel[];
  vision?: boolean;
  outputLimit?: number;
  reasoningField?: ReasoningField;
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
  /**
   * The cost this call was recorded with, when the row carries one. Read before every other rung:
   * it is the only one that answers "what did this cost then" rather than "what would it cost at
   * today's prices".
   */
  pinned?: CostBreakdown;
}

/**
 * Backends that talk to exactly one company, so their vendor is not inferred.
 *
 * `api.anthropic.com` is here because models.dev publishes no api base for the `anthropic`
 * provider itself (only for Anthropic-compatible third parties), so host resolution cannot find
 * it and the native Messages transport would fall all the way to the cross-market median. Every
 * my-claw route to that host is subscription auth: the `anthropic` backend sends a bearer token
 * and no api key, by construction. See docs/anthropic-backend.md.
 */
const ENGINE_PROVIDER: Record<string, string> = {
  "api.anthropic.com": "anthropic",
  "chatgpt.com": "openai",
  // The subscription SDK transport. Without it the Claude rows written through the SDK fell to the
  // cross-market median while the same model on the native host, one line below, was priced at the
  // vendor's tarif -- two answers for one model on one page.
  "claude-sdk": "anthropic",
};

// Variant and quantisation markers a self-hosted build appends and no catalogue will ever carry.
const VARIANT_SUFFIX = /-(?:uncensored|heretic|instant|mtp|abliterated|thinking|gguf|awq|fp8|fp16|int4|int8|q\d+(?:_k)?(?:_[msl])?)/gi;

/**
 * An id a provider publishes verbatim: `:batch`, `:free`, `:nitro`. It has its own catalogue row
 * and its own price, so it is never a short form for something else -- and its version digits are
 * shared with unrelated models, which is how it inherited their name (docs/model-metadata.md R10).
 */
const CATALOG_VARIANT = /:[a-z0-9._-]+$/i;

/**
 * Whether a token of an id names anything. A digit is not a family name, and matching on one is
 * how `anthropic/claude-fable-5.1:batch` resolved to `thedrummer/cydonia-24b-v4.1`.
 */
function isNamedToken(token: string): boolean {
  return /[a-z]/.test(token);
}

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
  // An endpoint pin addresses one route of a model, never a different model: it says nothing to
  // a price table (docs/model-identity.md). Dropped first, or the last segment would be a region.
  const at = model.lastIndexOf("@");
  if (at > 0) model = model.slice(0, at);
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

/** `OpenCode-Go`, `opencode_go` and `opencodego` are one name written three ways. */
function normalizeProviderKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whether an entry says anything about capability, as opposed to only price or window. */
function describesModel(entry: TableEntry): boolean {
  return (
    entry.name !== undefined ||
    entry.effort !== undefined ||
    entry.effortToggle === true ||
    entry.vision !== undefined ||
    entry.output !== undefined ||
    entry.reasoningField !== undefined
  );
}

function entryMetadata(entry: TableEntry, source: string): ModelMetadata {
  const meta: ModelMetadata = { source };
  if (entry.name !== undefined) meta.label = entry.name;
  if (entry.effort !== undefined) meta.effortLevels = entry.effort;
  else if (entry.effortToggle === true) meta.effortLevels = TOGGLE_LADDER;
  if (entry.vision !== undefined) meta.vision = entry.vision;
  if (entry.output !== undefined) meta.outputLimit = entry.output;
  if (entry.reasoningField !== undefined) meta.reasoningField = entry.reasoningField;
  return meta;
}

function isFree(cost: ModelCost): boolean {
  return cost.input <= 0 && cost.output <= 0;
}

export class ModelPricing {
  private cache: PricingCache | null = null;
  private hostToProvider = new Map<string, string>();
  /** Normalized models.dev provider id -> id, so a local key spelt differently still matches. */
  private keyToProvider = new Map<string, string>();
  private refreshing: Promise<void> | null = null;

  constructor(
    private declaredProviders: () => Record<string, { baseUrl?: string; pricingProvider?: string }>,
    // Discovered models, used only to resolve an alias to a concrete version. Optional so the
    // price table stays usable without a catalogue.
    private catalogModels: () => Array<{ id: string; apiId?: string; group?: string; limit?: { context?: number } }> = () => [],
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
   *
   * A sibling only counts when it actually carries the alias's name: a shared group is a menu
   * choice, not evidence of kinship. Without this, every windowless id in a flat provider group
   * (a stealth model, a batch variant) inherits whatever sibling sorts highest by version --
   * `mistral-small-2603` beats `glm-5.3` on `[2603] > [5, 3]` -- and wears its name and price.
   */
  private resolveAlias(model: string): string | undefined {
    if (CATALOG_VARIANT.test(model)) return undefined;
    const models = this.catalogModels();
    // A price is looked up under the id the provider bills, never under the qualified reference
    // the catalogue addresses the model by (docs/model-identity.md).
    const wireId = (m: { id: string; apiId?: string }): string => m.apiId ?? m.id;
    const self = models.find((m) => wireId(m) === model);
    if (!self || !self.group || self.limit?.context) return undefined;
    // Name tokens of the alias (`opus` -> {opus}, `ox-alpha` -> {ox, alpha}), digits excluded: one
    // named token in common is kinship enough, because the alias is a short form of the family's
    // name. A shared version number is not kinship -- every `-5` or `-1` in the catalogue would
    // otherwise answer for a model that simply has no metadata of its own.
    const tokensOf = (id: string): Set<string> =>
      new Set(id.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0 && isNamedToken(token)));
    const selfTokens = tokensOf(model);
    if (selfTokens.size === 0) return undefined;
    const siblings = models.filter(
      (m) =>
        m.group === self.group &&
        wireId(m) !== model &&
        m.limit?.context &&
        [...tokensOf(wireId(m))].some((token) => selfTokens.has(token)),
    );
    if (siblings.length === 0) return undefined;
    return siblings.map(wireId).sort((a, b) => compareVersions(versionKey(b), versionKey(a)))[0];
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
    // 0. The cost frozen on the row when the call was recorded, flags and rung included. A table
    //    refetched since cannot restate what was charged that day, and re-pricing the past is how a
    //    provider changing its price silently rewrites up to 90 days of spend.
    if (usage.pinned) return usage.pinned;

    // 1. The proxy states what it billed. Only trusted when positive: LiteLLM reports 0.0 both for
    //    a free plan and for a model it has no price for.
    if (usage.proxyCostUsd !== undefined && usage.proxyCostUsd > 0) {
      return { usd: usage.proxyCostUsd, billed: true, approximate: false, source: "proxy" };
    }

    // 1b. A pinned OpenRouter endpoint publishes its own price, and one model's endpoints span a
    //     6.8x range (0.065 to 0.44 USD/M input on deepseek-v4-flash). The model-level table
    //     cannot express that: it priced streamlake/fp8 at 2.08x its real rate. This outranks
    //     every table below because it is the tariff of the exact endpoint that served the call.
    const pinned = this.pinnedEndpointCost(usage.model);
    if (pinned) return this.priced(usage, pinned.cost, true, false, `endpoint ${pinned.tag}`);

    // 1c. Exact OpenRouter catalogue pricing precedes models.dev. Suffix variants such as `:batch`
    // and `:free` remain distinct ids, so no sibling can donate an interactive tariff.
    const openRouter = this.openRouterModelCost(usage.model);
    if (openRouter) return this.priced(usage, openRouter, true, false, "openrouter catalogue");

    if (!this.cache) return undefined;

    const engine = ENGINE_PROVIDER[usage.baseUrl] ?? ENGINE_PROVIDER[hostOf(usage.baseUrl)];
    if (engine) {
      const hit = this.lookupCost(engine, usage.model);
      // Subscription auth is not metered, so this is a reference price whatever the table says.
      if (hit) return this.priced(usage, hit.cost, false, hit.approximate, `engine ${engine}`);
    }

    // 2/4. The endpoint we called, or the upstream a proxy told us it forwarded to.
    for (const [url, fallbackLabel] of [
      [usage.baseUrl, "host"],
      [usage.upstreamApiBase ?? "", "upstream"],
    ] as const) {
      const resolved = url ? this.resolveProvider(url) : undefined;
      if (!resolved) continue;
      const provider = resolved.provider;
      // The rung that answered, unless the host is what resolved it: then the url we used is the
      // more informative half of the trace.
      const label = resolved.how === "host" ? fallbackLabel : resolved.how;
      const hit = this.lookupCost(provider, usage.model);
      if (!hit) {
        const vendor = this.vendorByModelId(usage.model);
        const vendorHit = vendor ? this.lookupCost(vendor, usage.model) : undefined;
        if (vendorHit && !isFree(vendorHit.cost)) {
          return this.priced(usage, vendorHit.cost, false, vendorHit.approximate, `vendor ${vendor}`);
        }
        continue;
      }
      if (!isFree(hit.cost)) return this.priced(usage, hit.cost, true, hit.approximate, `${label} ${provider}`);
      // Never report zero: climb from a flat plan to the vendor for a comparable figure.
      const vendor = this.vendorOf(provider);
      const vendorHit = vendor ? this.lookupCost(vendor, usage.model) : undefined;
      if (vendorHit && !isFree(vendorHit.cost)) {
        return this.priced(usage, vendorHit.cost, false, vendorHit.approximate, `plan ${provider} via ${vendor}`);
      }
    }

    // 3. The vendor the model's name belongs to, when the endpoint resolved above carries the id
    //    not at all. The escalation inside that loop answers a flat plan; this one answers an empty
    //    table, which is otherwise a straight fall to the market median.
    //
    //    Anchored on a resolved endpoint, like every rung here: an unknown host still resolves
    //    nothing rather than borrowing a table. See `metadataOf` for why the vendor is named by the
    //    model and not by the provider (`opencode-go` resolves to `opencode`, which lacks the id).

    // 5. Last resort. A median describes what a model costs on the open market, not what this
    //    deployment pays for it, so it is never billed and always approximate.
    const median = this.medianCost(usage.model);
    if (median) return this.priced(usage, median.cost, false, true, `median of ${median.offers}`);
    return undefined;
  }

  /**
   * The published tariff of the endpoint a usage row was filed under, when the row carries a pin.
   *
   * The `model` of a usage row keeps its `@endpoint` suffix on purpose (see usageModelOf): two
   * endpoints of one model are two different bills. Read from the endpoints cache only, since
   * pricing happens while the row is written.
   */
  private pinnedEndpointCost(model: string): { cost: ModelCost; tag: string } | undefined {
    const at = model.lastIndexOf("@");
    if (at <= 0) return undefined;
    const tag = model.slice(at + 1);
    const priced = cachedOpenRouterEndpointPricing(model.slice(0, at), tag);
    if (!priced) return undefined;
    return {
      tag,
      cost: {
        input: priced.input,
        output: priced.output,
        ...(priced.cacheRead === undefined ? {} : { cacheRead: priced.cacheRead }),
      },
    };
  }

  /** Exact-id pricing from the cached OpenRouter catalogue, never an alias or sibling. */
  private openRouterModelCost(model: string): ModelCost | undefined {
    const at = model.lastIndexOf("@");
    const id = at > 0 ? model.slice(0, at) : model;
    const priced = cachedOpenRouterModel(id);
    if (priced?.promptUsd === undefined || priced.completionUsd === undefined) return undefined;
    return {
      input: priced.promptUsd,
      output: priced.completionUsd,
      ...(priced.cacheReadUsd === undefined ? {} : { cacheRead: priced.cacheReadUsd }),
      ...(priced.cacheWriteUsd === undefined ? {} : { cacheWrite: priced.cacheWriteUsd }),
    };
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
    const fromBase = baseUrl ? this.resolveProvider(baseUrl) : undefined;
    const fromUpstream = upstreamApiBase ? this.resolveProvider(upstreamApiBase) : undefined;
    const rungs: Array<[string | undefined, string]> = [
      [engine, engine ? `engine ${engine}` : ""],
      [fromBase?.provider, fromBase && fromBase.how !== "host" ? fromBase.how : "host"],
      [fromUpstream?.provider, fromUpstream && fromUpstream.how !== "host" ? fromUpstream.how : "upstream"],
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

  /**
   * What the database says this model can do, for a provider that lists ids and nothing else.
   * Same ladder as the price, because it is the same question about the same provider, and the
   * same fallthrough: an entry carrying only a price must not shadow a looser key that describes
   * the model. No median rung -- a capability is not an average, and a wrong ladder is offered to
   * the user as a choice rather than shown as an approximation.
   */
  metadataOf(model: string, baseUrl?: string): ModelMetadata | undefined {
    if (!this.cache || !baseUrl) return undefined;
    const engine = ENGINE_PROVIDER[baseUrl] ?? ENGINE_PROVIDER[hostOf(baseUrl)];
    const resolved = this.resolveProvider(baseUrl);
    const rungs: Array<[string, string]> = [];
    if (engine) rungs.push([engine, `engine ${engine}`]);
    if (resolved) {
      rungs.push([resolved.provider, `${resolved.how} ${resolved.provider}`]);
      // The endpoint, then the vendor the model's name belongs to. That vendor is not the endpoint's
      // own (see `vendorByModelId`): it is the last rung before giving up on describing the model,
      // and it stays below the table of the endpoint that actually served the call.
      const vendor = this.vendorByModelId(model);
      if (vendor && vendor !== resolved.provider && vendor !== engine) rungs.push([vendor, `vendor ${vendor}`]);
    }
    for (const [provider, source] of rungs) {
      const hit = this.lookup(provider, model, (entry) => (describesModel(entry) ? entry : undefined));
      if (hit) return entryMetadata(hit.value, source);
    }
    return undefined;
  }

  /**
   * Which models.dev provider describes an endpoint, and on what evidence.
   *
   * Name before host: `opencode-go` and `opencode` both live on `opencode.ai` and publish different
   * prices for the same id, so the host says nothing about which of the two is being called while
   * the local provider key does. See docs/model-metadata.md R6.
   */
  private resolveProvider(url: string): { provider: string; how: "declared" | "key" | "host" } | undefined {
    const declared = this.declaredPricingProvider(url);
    if (declared) return { provider: declared, how: "declared" };
    const host = hostOf(url);
    if (!host) return undefined;
    for (const [key, provider] of Object.entries(this.declaredProviders())) {
      if (!provider.baseUrl || hostOf(provider.baseUrl) !== host) continue;
      const match = this.keyToProvider.get(normalizeProviderKey(key));
      if (match) return { provider: match, how: "key" };
    }
    const byHost = this.hostToProvider.get(host);
    return byHost ? { provider: byHost, how: "host" } : undefined;
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

  /**
   * The vendor a model id names, for the rung where no endpoint table answers -- measured live on
   * 2026-09-11.
   *
   * `deepseek-flash` through the opencode gateway: that table carries `deepseek-v4.1-flash`, its
   * vendor resolves to `opencode` which does not carry it either, so neither rung can describe it.
   * The model's own name is the last evidence -- `deepseek` publishes the id verbatim -- and a
   * vendor selling a model under its own name is how models.dev is seeded in the first place.
   *
   * Longest prefix first, never shorter than three characters. This runs only once every table that
   * knows the id has declined it, so a wrong guess costs nothing that was not already missing.
   */
  private vendorByModelId(model: string): string | undefined {
    const parts = model.toLowerCase().split("-");
    for (let n = parts.length - 1; n >= 1; n--) {
      const candidate = parts.slice(0, n).join("-");
      if (candidate.length < 3) continue;
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
    this.keyToProvider.clear();
    for (const [provider, api] of Object.entries(this.cache?.hosts ?? {})) {
      const host = hostOf(api);
      if (host && !this.hostToProvider.has(host)) this.hostToProvider.set(host, provider);
    }
    // Indexed off the tables rather than the hosts: a provider can describe models without
    // publishing an api url. Measured on the live file: 183 providers, no two normalize alike.
    for (const provider of Object.keys(this.cache?.models ?? {})) {
      const key = normalizeProviderKey(provider);
      if (key && !this.keyToProvider.has(key)) this.keyToProvider.set(key, provider);
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
  models?: Record<string, RawModel>;
}

interface RawModel {
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
  name?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: unknown }>;
  modalities?: { input?: string[] };
  // `true` (the field exists but names nothing) or `{ field: "reasoning_content" }`. Only the
  // object form is usable: the bare boolean says a model interleaves without saying how to feed
  // it, and guessing a field name is how you send a body a strict endpoint rejects.
  interleaved?: boolean | { field?: string };
}

/**
 * The replay field this model publishes, validated rather than trusted: the same file carries a
 * bare `true` on 48 models, which names no field and so cannot drive a request body.
 */
function reasoningFieldOf(model: RawModel): ReasoningField | undefined {
  const value = model.interleaved;
  if (typeof value !== "object" || value === null) return undefined;
  return value.field === "reasoning_content" || value.field === "reasoning_details" ? value.field : undefined;
}

/**
 * Every rung the vocabulary owns, so a value published upstream is either recognised or dropped.
 * Measured on the live file: three entries carry junk (one `"default"`, two `null`), and 305 carry
 * `minimal` — which is why this validates instead of trusting the array.
 */
const EFFORT_VOCABULARY: EffortLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** What a toggle-only model offers: off, and on. See docs/model-metadata.md R1. */
const TOGGLE_LADDER: EffortLevel[] = ["none", "high"];

/**
 * The reasoning ladder a model publishes, ordered bottom-up whatever order it was written in, or
 * undefined when nothing usable was declared. An `effort` entry wins over a `toggle`: it is the
 * more precise statement about the same capability. `budget_tokens` is not a ladder and is ignored.
 */
export function effortLadderOf(model: { reasoning_options?: Array<{ type?: string; values?: unknown }> }): {
  levels?: EffortLevel[];
  toggle: boolean;
} {
  let toggle = false;
  const found = new Set<EffortLevel>();
  for (const option of model.reasoning_options ?? []) {
    if (option.type === "toggle") toggle = true;
    if (option.type !== "effort" || !Array.isArray(option.values)) continue;
    for (const value of option.values) {
      const level = EFFORT_VOCABULARY.find((known) => known === value);
      if (level) found.add(level);
    }
  }
  if (found.size > 0) return { levels: EFFORT_VOCABULARY.filter((level) => found.has(level)), toggle };
  return { toggle };
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
      const ladder = effortLadderOf(model);
      const output = typeof model.limit?.output === "number" && model.limit.output > 0 ? model.limit.output : undefined;
      const vision = Array.isArray(model.modalities?.input) ? model.modalities.input.includes("image") : undefined;
      const name = typeof model.name === "string" && model.name.length > 0 ? model.name : undefined;
      const reasoningField = reasoningFieldOf(model);
      const describes =
        ladder.levels !== undefined || ladder.toggle || output !== undefined || vision !== undefined || name !== undefined || reasoningField !== undefined;
      // A model with a window but no published price is worth keeping now that the table answers
      // both questions; one with neither carries nothing.
      if (!cost && context === undefined && !describes) continue;
      const value: TableEntry = { id };
      if (cost) value.cost = cost;
      if (context !== undefined) value.context = context;
      if (name !== undefined) value.name = name;
      if (ladder.levels !== undefined) value.effort = ladder.levels;
      else if (ladder.toggle) value.effortToggle = true;
      if (vision !== undefined) value.vision = vision;
      if (output !== undefined) value.output = output;
      if (reasoningField !== undefined) value.reasoningField = reasoningField;
      for (const key of modelKeyCandidates(id)) {
        if (!(key in table)) table[key] = value;
      }
    }
    if (Object.keys(table).length > 0) models[provider] = table;
  }
  return { version: CACHE_VERSION, fetchedAt: new Date().toISOString(), hosts, models };
}

/**
 * The table the whole process prices with.
 *
 * `recordApiCall` freezes a tariff on every row it writes, and it runs deep in the agent loop, from
 * three call sites that hold no pricing table of their own. One instance is registered at boot
 * (`src/index.ts`) and read here, which also keeps the multi-megabyte models.dev cache loaded once
 * instead of once per sub-agent.
 *
 * Null before boot, and in any test that never registers one: a row then carries no tariff and the
 * report prices it live, exactly as it did before tariffs were pinned.
 */
let shared: ModelPricing | null = null;

export function setSharedPricing(pricing: ModelPricing | null): void {
  shared = pricing;
}

export function sharedPricing(): ModelPricing | null {
  return shared;
}
