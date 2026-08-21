/**
 * The endpoints OpenRouter serves a model from, and the names of the providers behind them.
 *
 * One model is several offers: `gpt-5.6-luna` is served by OpenAI at three service tiers, by Azure
 * in three regions and by Bedrock, from 0.05 to 0.22 USD per million input tokens, with uptimes
 * between 82 and 100 percent. Routing is OpenRouter's job by default; pinning one endpoint is the
 * owner's when the price or the data policy matters (docs/model-identity.md).
 *
 * Fetched lazily, when a menu asks: the catalogue is 400 models and this is one call per model.
 */

import { log } from "../utils/logger.ts";

const ENDPOINTS_TTL_MS = 15 * 60_000;
const MODELS_TTL_MS = 15 * 60_000;
const PROVIDERS_TTL_MS = 24 * 60 * 60_000;
/**
 * OpenRouter is recognised by its registered domain, including official subdomains such as
 * `gateway.openrouter.ai`. The host is parsed rather than searched as text, so an unrelated URL
 * cannot opt into OpenRouter-only request fields by mentioning the domain in its path or query.
 */
export function isOpenRouterBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}
const FETCH_TIMEOUT_MS = 10_000;
const API_BASE = "https://openrouter.ai/api/v1";

export interface OpenRouterEndpoint {
  /** What `provider.order` must carry to reach this one, suffixes included ("azure/eu"). */
  tag: string;
  /** The provider's own display name, as OpenRouter spells it ("Amazon Bedrock"). */
  providerName: string;
  /** USD per million input tokens, undefined when the endpoint publishes no price. */
  promptUsd?: number;
  /** USD per million output tokens. */
  completionUsd?: number;
  /**
   * USD per million cached input tokens. Published per endpoint and often an order of magnitude
   * under the input rate, so a cached conversation priced at the input rate reads far too high.
   */
  cacheReadUsd?: number;
  contextLength?: number;
  /**
   * The output ceiling of this endpoint alone. The model-level catalogue publishes the ceiling of
   * the *best* endpoint, so a pinned run that trusts it asks for more than its own endpoint
   * accepts; OpenRouter then drops the endpoint and, with fallbacks off, answers 404.
   */
  maxOutput?: number;
  /** OpenRouter's own health flag: 0 is serving, anything negative is degraded or down. */
  status?: number;
  uptime30m?: number;
}

/**
 * One row of the model-level catalogue (`/api/v1/models`): what OpenRouter publishes about a model
 * before any endpoint is picked. Prices here are the *best* offer and the window/output ceiling is
 * the best endpoint's, so this is catalogue metadata, not what a pinned run pays
 * (docs/model-identity.md).
 */
export interface OpenRouterModel {
  /** Exact catalogue id, suffix included ("google/gemini-3.7-flash:batch"). Never normalised. */
  id: string;
  /** The dated slug behind the moving id, when the catalogue exposes one. */
  canonicalSlug?: string;
  /** Display name as OpenRouter spells it ("DeepSeek: DeepSeek V4 Flash"). */
  name: string;
  contextLength?: number;
  /** Ceiling of the best endpoint, per `top_provider.max_completion_tokens`. */
  maxOutput?: number;
  moderated?: boolean;
  /** USD per million tokens, undefined when the model publishes no such rate. */
  promptUsd?: number;
  completionUsd?: number;
  cacheReadUsd?: number;
  cacheWriteUsd?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  supportedParameters?: string[];
  /** True when the model refuses to run with reasoning off. */
  reasoningMandatory?: boolean;
  reasoningEfforts?: string[];
  /** ISO date after which the catalogue drops the model, when announced. */
  expirationDate?: string;
}

interface Cached<T> {
  at: number;
  value: T;
}

const endpointsCache = new Map<string, Cached<OpenRouterEndpoint[]>>();
let providersCache: Cached<Map<string, string>> | undefined;
let modelsCache: Cached<Map<string, OpenRouterModel>> | undefined;
let modelsInFlight: Promise<Map<string, OpenRouterModel>> | undefined;

/** Per million tokens, from OpenRouter's per-token strings. */
function perMillion(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) ? n * 1_000_000 : undefined;
}

async function getJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The endpoints of one model, cheapest first. An unreachable API answers with an empty list
 * rather than an error: the menu then offers automatic routing and nothing else, which is what
 * the run would do anyway.
 */
export async function openRouterEndpoints(apiId: string): Promise<OpenRouterEndpoint[]> {
  const hit = endpointsCache.get(apiId);
  if (hit && Date.now() - hit.at < ENDPOINTS_TTL_MS) return hit.value;
  try {
    const body = (await getJson(`/models/${apiId}/endpoints`)) as {
      data?: {
        endpoints?: Array<{
          tag?: string;
          provider_name?: string;
          context_length?: number;
          max_completion_tokens?: number | null;
          status?: number;
          uptime_last_30m?: number;
          pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
        }>;
      };
    };
    const out: OpenRouterEndpoint[] = [];
    for (const e of body.data?.endpoints ?? []) {
      if (!e.tag) continue;
      out.push({
        tag: e.tag,
        providerName: e.provider_name ?? e.tag,
        ...(perMillion(e.pricing?.prompt) === undefined ? {} : { promptUsd: perMillion(e.pricing?.prompt)! }),
        ...(perMillion(e.pricing?.completion) === undefined ? {} : { completionUsd: perMillion(e.pricing?.completion)! }),
        ...(perMillion(e.pricing?.input_cache_read) === undefined ? {} : { cacheReadUsd: perMillion(e.pricing?.input_cache_read)! }),
        ...(typeof e.context_length === "number" ? { contextLength: e.context_length } : {}),
        ...(typeof e.max_completion_tokens === "number" ? { maxOutput: e.max_completion_tokens } : {}),
        ...(typeof e.status === "number" ? { status: e.status } : {}),
        ...(typeof e.uptime_last_30m === "number" ? { uptime30m: e.uptime_last_30m } : {}),
      });
    }
    out.sort((a, b) => (a.promptUsd ?? Number.MAX_VALUE) - (b.promptUsd ?? Number.MAX_VALUE));
    endpointsCache.set(apiId, { at: Date.now(), value: out });
    return out;
  } catch (err) {
    void log("warn", "openrouter endpoints lookup failed", { model: apiId, error: String(err) });
    // Cached as empty so a menu opened twice on a dead API does not wait twice.
    endpointsCache.set(apiId, { at: Date.now(), value: [] });
    return [];
  }
}

/**
 * Slug to display name for every provider OpenRouter fronts. Read, never guessed: the catalogue
 * spells things "Z.AI", "Amazon Bedrock", "VoyageAI by MongoDB", and no casing rule produces that.
 */
export async function openRouterProviderNames(): Promise<Map<string, string>> {
  if (providersCache && Date.now() - providersCache.at < PROVIDERS_TTL_MS) return providersCache.value;
  try {
    const body = (await getJson("/providers")) as { data?: Array<{ name?: string; slug?: string }> };
    const map = new Map<string, string>();
    for (const p of body.data ?? []) {
      if (p.slug && p.name) map.set(p.slug, p.name);
    }
    providersCache = { at: Date.now(), value: map };
    return map;
  } catch (err) {
    void log("warn", "openrouter provider names lookup failed", { error: String(err) });
    providersCache = { at: Date.now(), value: new Map() };
    return providersCache.value;
  }
}

interface RawModel {
  id?: string;
  canonical_slug?: string | null;
  name?: string;
  context_length?: number | null;
  expiration_date?: string | null;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null; is_moderated?: boolean };
  supported_parameters?: string[];
  reasoning?: { mandatory?: boolean; supported_efforts?: string[] } | null;
}

function toModel(raw: RawModel): OpenRouterModel | undefined {
  if (!raw.id) return undefined;
  // top_provider is the endpoint serving by default, so its window wins when both are published.
  const context =
    typeof raw.top_provider?.context_length === "number"
      ? raw.top_provider.context_length
      : typeof raw.context_length === "number"
        ? raw.context_length
        : undefined;
  const prompt = perMillion(raw.pricing?.prompt);
  const completion = perMillion(raw.pricing?.completion);
  const cacheRead = perMillion(raw.pricing?.input_cache_read);
  const cacheWrite = perMillion(raw.pricing?.input_cache_write);
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    ...(raw.canonical_slug ? { canonicalSlug: raw.canonical_slug } : {}),
    ...(context === undefined ? {} : { contextLength: context }),
    ...(typeof raw.top_provider?.max_completion_tokens === "number"
      ? { maxOutput: raw.top_provider.max_completion_tokens }
      : {}),
    ...(typeof raw.top_provider?.is_moderated === "boolean" ? { moderated: raw.top_provider.is_moderated } : {}),
    ...(prompt === undefined ? {} : { promptUsd: prompt }),
    ...(completion === undefined ? {} : { completionUsd: completion }),
    ...(cacheRead === undefined ? {} : { cacheReadUsd: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteUsd: cacheWrite }),
    ...(raw.architecture?.input_modalities ? { inputModalities: raw.architecture.input_modalities } : {}),
    ...(raw.architecture?.output_modalities ? { outputModalities: raw.architecture.output_modalities } : {}),
    ...(raw.supported_parameters ? { supportedParameters: raw.supported_parameters } : {}),
    ...(typeof raw.reasoning?.mandatory === "boolean" ? { reasoningMandatory: raw.reasoning.mandatory } : {}),
    ...(raw.reasoning?.supported_efforts ? { reasoningEfforts: raw.reasoning.supported_efforts } : {}),
    ...(raw.expiration_date ? { expirationDate: raw.expiration_date } : {}),
  };
}

/**
 * The whole model-level catalogue, keyed by exact id. Suffix variants (`:free`, `:batch`) are
 * distinct models with their own prices and stay distinct keys: collapsing them would price a batch
 * run at the interactive rate.
 *
 * One call for 400 models, so unlike the per-model endpoint listing this is cheap enough to fetch
 * whole. A failed fetch caches an empty map for the TTL rather than throwing: callers treat a miss
 * as "no evidence" and leave their own values untouched.
 */
export async function openRouterModels(): Promise<Map<string, OpenRouterModel>> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.value;
  // Several callers can ask at once; one flight serves them all.
  if (modelsInFlight) return modelsInFlight;
  modelsInFlight = (async () => {
    try {
      const body = (await getJson("/models")) as { data?: RawModel[] };
      const map = new Map<string, OpenRouterModel>();
      for (const raw of body.data ?? []) {
        const model = toModel(raw);
        if (model) map.set(model.id, model);
      }
      modelsCache = { at: Date.now(), value: map };
      return map;
    } catch (err) {
      void log("warn", "openrouter models lookup failed", { error: String(err) });
      modelsCache = { at: Date.now(), value: new Map() };
      return modelsCache.value;
    } finally {
      modelsInFlight = undefined;
    }
  })();
  return modelsInFlight;
}

/** One catalogue row by exact id, fetching the catalogue if it is cold. */
export async function openRouterModel(apiId: string): Promise<OpenRouterModel | undefined> {
  return (await openRouterModels()).get(apiId);
}

/**
 * The catalogue as it stands in memory, never reaching the network. Same rule as the endpoint
 * accessors: pricing and window resolution sit on synchronous hot paths and cannot await.
 */
export function cachedOpenRouterModels(): Map<string, OpenRouterModel> | undefined {
  if (!modelsCache || Date.now() - modelsCache.at >= MODELS_TTL_MS) return undefined;
  return modelsCache.value;
}

/** One cached catalogue row by exact id, or undefined when the catalogue is cold or stale. */
export function cachedOpenRouterModel(apiId: string): OpenRouterModel | undefined {
  return cachedOpenRouterModels()?.get(apiId);
}

/**
 * The limits of one pinned endpoint, or undefined when it is not listed (or the API is down).
 * Undefined means "no evidence", never "no limit": the caller must leave the request untouched
 * rather than invent a ceiling.
 */
export async function openRouterEndpointLimits(
  apiId: string,
  tag: string,
): Promise<{ context?: number; maxOutput?: number } | undefined> {
  const endpoint = (await openRouterEndpoints(apiId)).find((candidate) => candidate.tag === tag);
  if (!endpoint) return undefined;
  return {
    ...(endpoint.contextLength === undefined ? {} : { context: endpoint.contextLength }),
    ...(endpoint.maxOutput === undefined ? {} : { maxOutput: endpoint.maxOutput }),
  };
}

/**
 * What a pinned endpoint charges, if its listing is already cached. Same cache-only rule as the
 * limits: pricing is read while a usage row is written, which must never wait on the network.
 *
 * A model's endpoints span a 6.8x price range (measured on deepseek-v4-flash: 0.065 to 0.44 USD/M
 * input), so pricing a pinned run from the model-level table is wrong by whatever the pin is worth.
 */
export function cachedOpenRouterEndpointPricing(
  apiId: string,
  tag: string,
): { input: number; output: number; cacheRead?: number } | undefined {
  const hit = endpointsCache.get(apiId);
  if (!hit || Date.now() - hit.at >= ENDPOINTS_TTL_MS) return undefined;
  const endpoint = hit.value.find((candidate) => candidate.tag === tag);
  // Both halves are required: half a price would bill the other half at zero.
  if (endpoint?.promptUsd === undefined || endpoint.completionUsd === undefined) return undefined;
  return {
    input: endpoint.promptUsd,
    output: endpoint.completionUsd,
    ...(endpoint.cacheReadUsd === undefined ? {} : { cacheRead: endpoint.cacheReadUsd }),
  };
}

/**
 * The limits of a pinned endpoint if they are already cached, without ever reaching the network.
 *
 * Window resolution is synchronous and sits on the hot path of every display and every trim, so it
 * cannot await a lookup. Cache-only is enough in practice: the listing is fetched when a route menu
 * opens and when the transport clamps its output ask, and a cold cache simply means no clamp, which
 * is the same "no evidence, change nothing" rule applied everywhere else here.
 */
export function cachedOpenRouterEndpointLimits(
  apiId: string,
  tag: string,
): { context?: number; maxOutput?: number } | undefined {
  const hit = endpointsCache.get(apiId);
  if (!hit || Date.now() - hit.at >= ENDPOINTS_TTL_MS) return undefined;
  const endpoint = hit.value.find((candidate) => candidate.tag === tag);
  if (!endpoint) return undefined;
  return {
    ...(endpoint.contextLength === undefined ? {} : { context: endpoint.contextLength }),
    ...(endpoint.maxOutput === undefined ? {} : { maxOutput: endpoint.maxOutput }),
  };
}

/** Test seam: every cache here is module state, and module state leaks across test files. */
export function clearOpenRouterCache(): void {
  endpointsCache.clear();
  providersCache = undefined;
  modelsCache = undefined;
  modelsInFlight = undefined;
}
