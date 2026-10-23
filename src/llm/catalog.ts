import type { EffortLevel, LlmConfig, LlmModelConfig, LlmProviderConfig } from "../core/config.ts";
import { EFFORT_ORDER } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { getCodexAccessToken, CODEX_BASE_URL } from "./codex-auth.ts";
import { anthropicAuthHeaders, anthropicCredential } from "./anthropic-auth.ts";
import { fetchAnthropicModels } from "./anthropic-models.ts";
import { providerBaseUrl } from "./resolver.ts";
import { cachedOpenRouterModel, cachedOpenRouterEndpointLimits, isOpenRouterBaseUrl } from "./openrouter-endpoints.ts";
import type { ModelMetadata } from "./pricing.ts";
import { familyDefaultsOf } from "./families.ts";

// The model catalog is fully dynamic: no disk cache. See the ModelCatalog constructor.
const DISCOVER_TIMEOUT_MS = 15_000;

/**
 * Merge curated config models with discovered ones. Config wins on id collision, so the owner can
 * override a discovered model's label, group, limit, vision or effort by declaring the same id.
 *
 * The collision is on the reference, which discovery qualifies by provider: a model declared for
 * one provider no longer hides the same name served by another. That is the whole point, since
 * the price, the window and the data policy differ per provider.
 *
 * **Field-level, not entry-level.** A declaration that shares an id used to replace the discovered
 * entry outright, which was harmless only as long as declarations used bare ids and could never
 * actually collide. Once an override can be written from the app, pinning one context window would
 * drop `apiId`, `family` and `thinkingTypes` with it, and a missing `thinkingTypes` on an Anthropic
 * model is an HTTP 400. So the declared fields win and the discovered ones fill the rest: what the
 * owner did not touch keeps following the provider. See docs/model-declarations.md.
 */
export function mergeModels(base: LlmModelConfig[], discovered: LlmModelConfig[]): LlmModelConfig[] {
  const byId = new Map(discovered.map((m) => [m.id, m]));
  const overridden = base.map((declared) => {
    const found = byId.get(declared.id);
    if (!found) return declared;
    const merged = { ...found, ...pruneUndefined(declared) };
    // Rebuilt rather than overwritten so pinning one half of a window keeps the other. Left absent
    // when neither side states one: an empty object would read as "declared" and stop the model
    // from inheriting the global `llm.limit`.
    const limit = { ...found.limit, ...pruneUndefined(declared.limit ?? {}) };
    return Object.keys(limit).length > 0 ? { ...merged, limit } : merged;
  });
  const seen = new Set(base.map((m) => m.id));
  return [...overridden, ...discovered.filter((m) => !seen.has(m.id))];
}

/** An explicit `undefined` in a declaration means "not stated", never "unset what discovery found". */
function pruneUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * The reference a discovered model is addressed by: its provider, then the id that provider
 * knows. Two providers listing `gpt-5.6-luna` produce two entries, and each keeps its own
 * `apiId` for the wire. See docs/model-identity.md.
 */
function discoveredModel(model: Omit<LlmModelConfig, "id"> & { id: string; provider: string }): LlmModelConfig {
  return { ...model, id: `${model.provider}/${model.id}`, apiId: model.id };
}

/**
 * Provider-first menu: a model without an explicit `group` inherits its provider's `group`, so
 * the picker root shows one entry per provider instead of a flat list of every model.
 *
 * A provider that declares no `group` groups under its own key rather than spilling its models
 * at the root: a discovering provider is not a handful of models (OpenRouter alone returns 400+),
 * and the root is the one screen every picker opens on. `group` stays the exception, for the
 * providers whose key is not what the owner wants to read ("anthropic" -> "Claude (abo)").
 */
export function applyProviderGroups(
  models: LlmModelConfig[],
  providers: Record<string, LlmProviderConfig>,
): LlmModelConfig[] {
  return models.map((m) => {
    if (m.group || !m.provider) return m;
    return { ...m, group: providers[m.provider]?.group ?? m.provider };
  });
}

/**
 * Fill in the context window for models that declare none, from the models.dev table.
 *
 * Done here, in the same enrichment pass as the provider groups, because everything downstream
 * (resolver, dispatcher, bridge, picker, /status) already reads `config.llm.models`. Resolving the
 * window at each of those sites instead would mean threading the price table through a constructor
 * that already takes nine positional arguments.
 *
 * A declared window always survives: config wins over discovery, and both win over a third party.
 */
export function applyModelWindows(
  models: LlmModelConfig[],
  providers: Record<string, LlmProviderConfig>,
  table: WindowTable | undefined,
): LlmModelConfig[] {
  // Before the first OpenRouter refresh there is no cache, and an absent models.dev table has
  // nothing to contribute either. Preserve identity on that cold, offline boot path.
  const hasCachedOpenRouter = models.some((m) => {
    const provider = m.provider ? providers[m.provider] : undefined;
    if (!isOpenRouterProvider(provider)) return false;
    const apiId = m.apiId ?? m.id;
    const pinned = pinnedEndpointOf(apiId);
    const openRouterApiId = pinned ? apiId.slice(0, apiId.lastIndexOf("@")) : apiId;
    return (pinned !== undefined && cachedOpenRouterEndpointLimits(openRouterApiId, pinned) !== undefined)
      || cachedOpenRouterModel(openRouterApiId) !== undefined;
  });
  if (!table && !hasCachedOpenRouter) return models;

  return models.map((m) => {
    // Config and provider discovery are authoritative. A third-party table only fills a gap.
    if (m.limit?.context) return m;
    const provider = m.provider ? providers[m.provider] : undefined;
    const apiId = m.apiId ?? m.id;

    // OpenRouter's model row is exact, including :batch and :free. Never strip a suffix here.
    if (isOpenRouterProvider(provider)) {
      const pinned = pinnedEndpointOf(apiId);
      const openRouterApiId = pinned ? apiId.slice(0, apiId.lastIndexOf("@")) : apiId;
      const endpoint = pinned ? cachedOpenRouterEndpointLimits(openRouterApiId, pinned) : undefined;
      if (endpoint?.context !== undefined) {
        return {
          ...m,
          limit: { ...m.limit, context: endpoint.context },
          contextFrom: "openrouter-endpoint",
        };
      }
      const model = cachedOpenRouterModel(openRouterApiId);
      if (model?.contextLength !== undefined) {
        return {
          ...m,
          limit: { ...m.limit, context: model.contextLength },
          contextFrom: "openrouter",
        };
      }
    }

    if (!table) return m;
    // The table is keyed by the id the provider publishes, never by our qualified reference.
    // An alias is looked up under the upstream id it resells (`pricingModel`) first, then by the
    // name the provider gave it, so a table that only knows one of the two still answers.
    for (const candidate of catalogIdsOf(m, apiId)) {
      const hit = table.contextWindowOf(candidate, provider?.baseUrl);
      if (hit) return { ...m, limit: { ...m.limit, context: hit.tokens }, contextFrom: "models.dev" };
    }
    return m;
  });
}

interface WindowTable {
  contextWindowOf(model: string, baseUrl?: string, upstreamApiBase?: string): { tokens: number } | undefined;
}

/** The ids a price or a capability table may know a model under: the upstream one first. */
function catalogIdsOf(model: LlmModelConfig, apiId: string): string[] {
  return model.pricingModel && model.pricingModel !== apiId ? [model.pricingModel, apiId] : [apiId];
}

/**
 * Capabilities for the models whose provider answered with a list of ids and nothing else, read
 * from the same models.dev download as the prices. See docs/model-metadata.md.
 *
 * Gap-filling only (R7): a field already set is either a statement by the owner or by a provider
 * answering for its own models (codex, Anthropic's versioned endpoint), and a community
 * database outranks neither. A label equal to the id is not a name, it is the placeholder discovery
 * leaves when it had nothing to record, so that counts as a gap.
 *
 * No effort ladder means no effort step, which is the honest answer for a model published as
 * reasoning without saying how it is steered.
 */
export function applyModelMetadata(
  models: LlmModelConfig[],
  providers: Record<string, LlmProviderConfig>,
  table: MetadataTable | undefined,
): LlmModelConfig[] {
  // As with context windows, do not allocate a lookalike list before either source has data.
  // This keeps the offline bootstrap path a genuine no-op.
  const hasCachedOpenRouter = models.some((m) => {
    const provider = m.provider ? providers[m.provider] : undefined;
    if (!isOpenRouterProvider(provider)) return false;
    const apiId = m.apiId ?? m.id;
    const openRouterApiId = pinnedEndpointOf(apiId) ? apiId.slice(0, apiId.lastIndexOf("@")) : apiId;
    return cachedOpenRouterModel(openRouterApiId) !== undefined;
  });
  // The family rung needs neither source: it is the reason `litellm/mimo-v2.6-pro` gets a
  // reasoning field at all, and it has to survive a boot with no table downloaded yet.
  const hasFamily = models.some((m) => familyDefaultsOf(m.apiId ?? m.id) !== undefined);
  if (!table && !hasCachedOpenRouter && !hasFamily) return models;

  return models.map((m) => {
    const provider = m.provider ? providers[m.provider] : undefined;
    const apiId = m.apiId ?? m.id;
    // An endpoint pin decorates a model reference, it is not part of the OpenRouter model id.
    // Keep the raw id everywhere else, but only the catalogue lookup removes this separator.
    const openRouterApiId = pinnedEndpointOf(apiId) ? apiId.slice(0, apiId.lastIndexOf("@")) : apiId;
    const openrouter = isOpenRouterProvider(provider) ? cachedOpenRouterModel(openRouterApiId) : undefined;
    const needsLabel = m.label === m.id || m.label === m.apiId;
    const needsEffort = m.supportsEffort === undefined;
    const needsVision = m.vision === undefined;
    const needsOutput = m.limit?.output === undefined;
    const needsReasoningField = m.reasoningField === undefined;
    const hasOpenRouter = openrouter !== undefined;
    const needsFallback = !hasOpenRouter && (needsLabel || needsEffort || needsVision || needsOutput || needsReasoningField);
    if (!hasOpenRouter && !needsFallback) return m;

    const next: LlmModelConfig = { ...m };
    // OpenRouter is authoritative for its own discovered model rows. Apply each field separately,
    // so a missing field still falls through to models.dev without replacing exact API metadata.
    if (openrouter) {
      if (needsLabel && openrouter.name) next.label = openrouter.name;
      if (needsVision && openrouter.inputModalities) next.vision = openrouter.inputModalities.includes("image");
      if (needsOutput && openrouter.maxOutput !== undefined) next.limit = { ...next.limit, output: openrouter.maxOutput };
      if (needsEffort) {
        const efforts = openRouterEffortLevels(openrouter);
        if (efforts !== undefined) {
          next.supportsEffort = true;
          next.supportedEffortLevels = efforts;
        } else if (openrouter.reasoningMandatory === false) {
          next.supportsEffort = false;
        }
      }
    }

    // Do not let a generic table fill a field OpenRouter explicitly answered, including false or
    // an empty capability list. Fallback is field-by-field, not entry-by-entry.
    if (
      table &&
      (next.label === m.label ||
        next.supportsEffort === undefined ||
        next.vision === undefined ||
        next.limit?.output === undefined ||
        next.reasoningField === undefined)
    ) {
      const meta = catalogIdsOf(m, apiId)
        .map((candidate) => table.metadataOf(candidate, provider ? providerBaseUrl(provider) : undefined))
        .find((hit) => hit !== undefined);
      if (meta) {
        // `needsLabel` as well as the OpenRouter check: an owner-declared label used to be
        // protected only by the early return above, which a model reaching this branch for some
        // other missing field walks straight past.
        if (needsLabel && next.label === m.label && meta.label !== undefined) next.label = meta.label;
        if (next.supportsEffort === undefined && meta.effortLevels !== undefined) {
          next.supportsEffort = true;
          next.supportedEffortLevels = meta.effortLevels;
        }
        if (next.vision === undefined && meta.vision !== undefined) next.vision = meta.vision;
        if (next.limit?.output === undefined && meta.outputLimit !== undefined) {
          next.limit = { ...next.limit, output: meta.outputLimit };
        }
        if (next.reasoningField === undefined && meta.reasoningField !== undefined) next.reasoningField = meta.reasoningField;
      }
    }

    // The family speaks last. Everything above described the model where it could; this fills what
    // is still empty, which is the whole case for a reseller that publishes nothing.
    const family = familyDefaultsOf(apiId);
    if (family) {
      if (next.reasoningField === undefined && family.reasoningField !== undefined) next.reasoningField = family.reasoningField;
      if (next.vision === undefined && family.vision !== undefined) next.vision = family.vision;
      if (next.limit?.output === undefined && family.limit?.output !== undefined) {
        next.limit = { ...next.limit, output: family.limit.output };
      }
    }
    return next;
  });
}

interface MetadataTable {
  metadataOf(model: string, baseUrl?: string): ModelMetadata | undefined;
}

function isOpenRouterProvider(provider: LlmProviderConfig | undefined): boolean {
  return isOpenRouterBaseUrl(provider?.baseUrl);
}

function pinnedEndpointOf(apiId: string): string | undefined {
  const at = apiId.lastIndexOf("@");
  return at > 0 ? apiId.slice(at + 1) : undefined;
}

const OPENROUTER_EFFORTS: Record<string, EffortLevel> = {
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra",
};

function openRouterEffortLevels(model: {
  reasoningMandatory?: boolean;
  reasoningEfforts?: string[];
  supportedParameters?: string[];
}): EffortLevel[] | undefined {
  const levels = (model.reasoningEfforts ?? [])
    .map((level) => OPENROUTER_EFFORTS[level.toLowerCase()])
    .filter((level): level is EffortLevel => level !== undefined);
  if (levels.length > 0) {
    const unique = [...new Set(levels)];
    if (model.reasoningMandatory !== true && !unique.includes("none")) unique.unshift("none");
    return unique;
  }
  if (model.reasoningMandatory === true || model.supportedParameters?.includes("reasoning")) return ["none", "high"];
  return undefined;
}

/** What a failed pass tells the owner: the status or the network fault, never a response body. */
function discoveryFailure(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") return "no answer in time";
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/**
 * A row of an OpenAI-compatible `/models` answer, in the fields a provider may publish beyond the
 * id. Every one is optional and gap-filling: a listing that declares only ids (the common case)
 * yields `{ id }` and nothing changes downstream.
 */
interface OpenAiModelRow {
  id: string;
  label?: string;
  context?: number;
  output?: number;
  vision?: boolean;
  efforts?: EffortLevel[];
  /** The upstream id behind a reseller's alias, when the listing names one (`hugging_face_id`). */
  pricingModel?: string;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function effortLevelsOf(value: unknown): EffortLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value
    .filter((level): level is string => typeof level === "string")
    .map((level) => level.toLowerCase())
    .filter((level): level is EffortLevel => EFFORT_SET.has(level as EffortLevel));
  if (levels.length === 0) return undefined;
  // Bottom-up, deduped: the picker renders the ladder in the order it is given.
  return EFFORT_ORDER.filter((level) => levels.includes(level));
}

function rowOf(model: Record<string, unknown>): OpenAiModelRow | undefined {
  const id = typeof model.id === "string" && model.id.length > 0 ? model.id : undefined;
  if (!id) return undefined;
  const row: OpenAiModelRow = { id };
  const display = typeof model.display_name === "string" ? model.display_name.trim() : undefined;
  // An alias often names itself (`syn:large:text`), which says nothing about the model it routes
  // to. The row usually says that too (`alias_of`), so the label carries both: what it is, and
  // the stable name to pin.
  if (display && display !== id) row.label = display;
  else if (typeof model.alias_of === "string" && model.alias_of.trim()) row.label = `${model.alias_of.trim()} (${id})`;
  else if (display) row.label = display;
  const context = positiveInt(model.context_length) ?? positiveInt(model.max_input_tokens);
  if (context !== undefined) row.context = context;
  const output =
    positiveInt(model.max_output_length) ?? positiveInt(model.max_completion_tokens) ?? positiveInt(model.max_output_tokens);
  if (output !== undefined) row.output = output;
  if (Array.isArray(model.input_modalities)) row.vision = model.input_modalities.includes("image");
  const reasoning = model.reasoning_parameters as { efforts?: unknown } | undefined;
  const efforts = effortLevelsOf(reasoning?.efforts);
  if (efforts) row.efforts = efforts;
  const huggingFace = typeof model.hugging_face_id === "string" ? model.hugging_face_id : undefined;
  if (huggingFace) row.pricingModel = huggingFace.startsWith("hf:") ? huggingFace : `hf:${huggingFace}`;
  return row;
}

async function fetchOpenAiModels(baseUrl: string, apiKey?: string): Promise<OpenAiModelRow[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    return (body.data ?? []).map(rowOf).filter((row): row is OpenAiModelRow => row !== undefined);
  } finally {
    clearTimeout(timer);
  }
}

interface CodexDiscoveredModel {
  id: string;
  label: string;
  vision: boolean;
  supportedEffortLevels?: EffortLevel[];
}

// The whole vocabulary, not the fallback list: a provider describing its own models is evidence,
// so a level it publishes is kept. This is what stopped Codex's `minimal` from being dropped.
const EFFORT_SET = new Set<EffortLevel>(EFFORT_ORDER);
// The backend lists helper models (e.g. auto-review) that are not general chat targets.
const CODEX_MODEL_DENYLIST = new Set(["codex-auto-review"]);

/**
 * List models exposed by the Codex backend for the logged-in ChatGPT subscription, with their
 * display name, vision support and per-model reasoning levels. Requires a valid OAuth token;
 * before `codex login` this throws and the catalog keeps its curated set.
 */
async function fetchCodexModels(provider: string, baseUrl: string): Promise<CodexDiscoveredModel[]> {
  const { accessToken, accountId } = await getCodexAccessToken(provider);
  const url = `${(baseUrl || CODEX_BASE_URL).replace(/\/+$/, "")}/codex/models?client_version=1.0.0`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        originator: "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.0.0 (my-claw)",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      models?: Array<{
        slug?: string;
        id?: string;
        display_name?: string;
        input_modalities?: string[];
        supported_reasoning_levels?: Array<{ effort?: string }>;
      }>;
    };
    const out: CodexDiscoveredModel[] = [];
    for (const m of body.models ?? []) {
      const id = m.slug ?? m.id;
      if (!id || CODEX_MODEL_DENYLIST.has(id)) continue;
      const levels = (m.supported_reasoning_levels ?? [])
        .map((r) => r.effort)
        .filter((e): e is EffortLevel => typeof e === "string" && EFFORT_SET.has(e as EffortLevel));
      out.push({
        id,
        label: m.display_name || id,
        vision: (m.input_modalities ?? []).includes("image"),
        supportedEffortLevels: levels.length > 0 ? levels : undefined,
      });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runtime model catalog: augments config.models with models discovered from providers marked
 * `discover`. Resilient by design — a failed provider keeps the last known set (persisted to
 * disk so the menu and model routing survive a restart while offline).
 */
export class ModelCatalog {
  private discoveredModels: LlmModelConfig[] = [];
  private listeners: Array<() => void> = [];
  /**
   * What each provider listed on its last *complete* answer, kept before the cross-provider
   * dedupe: a provider is only evidence about its own catalog. Absent means "never answered
   * completely", which is not evidence that anything disappeared -- see `answered`.
   */
  private listedByProvider = new Map<string, ReadonlySet<string>>();
  /** The discovery pass currently running, so callers coalesce onto it rather than pile up. */
  private inFlight?: Promise<void>;
  /** The one pass that runs after it, shared by every caller that arrived while it ran. */
  private queued?: Promise<void>;
  /** Why each provider's last pass failed, cleared by its next complete answer. */
  private failures = new Map<string, string>();

  constructor(
    private getConfig: () => LlmConfig,
  ) {
    // No disk cache: the catalog is rebuilt from live provider answers on every boot and refresh.
    // The trade is deliberate — a provider down at boot shows no models until it answers again,
    // instead of a cached list serving models that no longer exist (deepseek decommissions,
    // marketplace removals) for up to a full boot cycle.
  }

  discovered(): LlmModelConfig[] {
    return this.discoveredModels;
  }

  /**
   * Whether this provider answered its last discovery in full. The distinction is load-bearing:
   * "answered and did not list X" means X is gone, while "did not answer" means nothing at all.
   * Reading the second as the first would empty the model picker on every network hiccup.
   *
   * False after a restart until the first refresh completes: the cached models are still served,
   * and nothing is declared missing on the strength of a discovery that has not run.
   */
  answered(provider: string): boolean {
    return this.listedByProvider.has(provider);
  }

  /**
   * How a discovering provider's last pass went, for the page that just added it: `pending` until
   * a pass has reached it, then the answer or the reason it failed (`HTTP 401`, never a body: an
   * error page can quote the key). Undefined for a provider that does not discover.
   */
  discovery(provider: string): { state: "ok" | "failed" | "pending"; error?: string } | undefined {
    if (!this.getConfig().providers?.[provider]?.discover) return undefined;
    const error = this.failures.get(provider);
    if (error !== undefined) return { state: "failed", error };
    return { state: this.listedByProvider.has(provider) ? "ok" : "pending" };
  }

  /** The ids that provider listed, empty when it never answered in full. */
  listedBy(provider: string): ReadonlySet<string> {
    return this.listedByProvider.get(provider) ?? new Set();
  }

  onUpdate(cb: () => void): void {
    this.listeners.push(cb);
  }

  /** True when any provider opts into discovery (otherwise refresh is a no-op). */
  enabled(): boolean {
    const providers = this.getConfig().providers ?? {};
    return Object.values(providers).some((p) => p.discover && !p.disabled);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  /**
   * Versioned Claude models, listed flat in the provider group like every other provider. The
   * family only orders them: the label already says which is which.
   */
  private async claudeVersionedModels(name: string, provider: LlmProviderConfig): Promise<LlmModelConfig[]> {
    // Discovery reads the same endpoint the run will send to, under the same credential: a
    // provider listed from api.anthropic.com and then talked to elsewhere would offer models the
    // other backend does not serve.
    const auth = await anthropicAuthHeaders(anthropicCredential(provider), name);
    if (!auth) return [];
    const models = await fetchAnthropicModels(auth, provider.baseUrl);
    return models.map((m) => discoveredModel({
      id: m.id,
      label: m.label,
      provider: name,
      group: provider.group,
      family: m.family,
      supportsEffort: m.effortLevels.length > 0,
      supportedEffortLevels: m.effortLevels.length > 0 ? m.effortLevels : undefined,
      thinkingTypes: m.thinkingTypes,
      vision: m.vision,
      limit: { context: m.contextLimit, output: m.outputLimit },
    }));
  }

  /**
   * Re-discover every `discover` provider and update the merged set. Never throws: a provider
   * that fails to answer keeps its previously discovered models.
   *
   * Never two passes at once: the loser's `next` array would overwrite the winner's. A call that
   * lands during a pass gets one more pass after it, shared by every such call, because it may
   * carry what the running one could not see: a provider created, then its key written a frame
   * later, was otherwise discovered before its key existed and showed nothing for six hours.
   */
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.queued ??= this.inFlight.then(() => {
        this.queued = undefined;
        return this.refresh();
      });
      return this.queued;
    }
    this.inFlight = this.runRefresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async runRefresh(): Promise<void> {
    const config = this.getConfig();
    const providers = config.providers ?? {};
    if (!this.enabled()) return;

    const next: LlmModelConfig[] = [];
    let anyFailed = false;

    for (const [name, provider] of Object.entries(providers)) {
      // A disabled provider is not queried at all: no discovery call goes out for something the
      // picker will not offer back (docs/providers-admin.md).
      if (!provider.discover || provider.disabled) continue;
      const before = next.length;
      let complete = true;
      try {
        if (provider.type === "anthropic") {
          // No aliases on this path: the moving opus/sonnet/haiku names are a transport control-channel
          // feature, and /v1/models answers with versioned ids the transport can send as-is.
          let versioned: LlmModelConfig[] = [];
          try {
            versioned = await this.claudeVersionedModels(name, provider);
          } catch (err) {
            anyFailed = true;
            // Half an answer is not an answer: the versioned set falls back to what was already
            // known, so this listing cannot be used as evidence that a model disappeared.
            complete = false;
            this.failures.set(name, discoveryFailure(err));
            void log("warn", "anthropic versioned model discovery failed", { error: String(err) });
            versioned = this.discoveredModels.filter((m) => m.provider === name);
          }
          next.push(...versioned);
        } else if (provider.type === "codex") {
          const models = await fetchCodexModels(name, provider.baseUrl ?? "");
          for (const m of models) {
            next.push(discoveredModel({
              id: m.id,
              label: m.label,
              provider: name,
              group: provider.group,
              supportsEffort: true,
              supportedEffortLevels: m.supportedEffortLevels,
              vision: m.vision,
            }));
          }
        } else {
          // An empty baseUrl used to reach fetch as the relative "/models", which answers
          // `TypeError [ERR_INVALID_URL]: fetch() URL is invalid` and says nothing about the
          // provider. It happens for real: a config naming a provider type the running build does
          // not know falls through to this branch, which is how an `anthropic` entry looked like a
          // network fault on the build before the one that understood it.
          if (!provider.baseUrl) {
            throw new Error(`provider "${name}" has type "${provider.type ?? "openai"}" and no baseUrl to discover from`);
          }
          const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
          const rows = await fetchOpenAiModels(provider.baseUrl, apiKey);
          for (const row of rows) {
            // Only what the listing stated, nothing invented: an endpoint that answers ids keeps
            // `label: id` and no limit, and models.dev fills the rest downstream.
            const limit = { context: row.context, output: row.output };
            next.push(discoveredModel({
              id: row.id,
              label: row.label ?? row.id,
              provider: name,
              group: provider.group,
              ...(row.vision !== undefined ? { vision: row.vision } : {}),
              ...(row.efforts ? { supportsEffort: true, supportedEffortLevels: row.efforts } : {}),
              ...(limit.context !== undefined || limit.output !== undefined ? { limit } : {}),
              ...(row.pricingModel ? { pricingModel: row.pricingModel } : {}),
            }));
          }
        }
      } catch (err) {
        anyFailed = true;
        complete = false;
        this.failures.set(name, discoveryFailure(err));
        void log("warn", "model discovery failed for provider", { provider: name, error: String(err) });
        // Keep this provider's previously discovered models on failure.
        for (const m of this.discoveredModels) {
          if (m.provider === name) next.push(m);
        }
      }
      // What this provider listed, in the ids it uses itself: callers ask "does provider X still
      // serve model Y", and Y is the provider's own name for it, not our qualified reference.
      if (complete) {
        this.failures.delete(name);
        this.listedByProvider.set(name, new Set(next.slice(before).map((m) => m.apiId ?? m.id)));
      } else {
        this.listedByProvider.delete(name);
      }
    }

    // Dedupe on the reference, which carries the provider: a name served by two providers is two
    // entries on purpose. Only a provider listing the same id twice loses one.
    const seen = new Set<string>();
    this.discoveredModels = next.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));

    hooks.emit("models:discovered", { count: this.discoveredModels.length, anyFailed });
    this.notify();
  }
}
