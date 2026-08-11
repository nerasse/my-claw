import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EffortLevel, LlmConfig, LlmModelConfig, LlmProviderConfig } from "../core/config.ts";
import { MY_CLAW_DIR, EFFORT_ORDER } from "../core/config.ts";
import { writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { getCodexAccessToken, CODEX_BASE_URL } from "./codex-auth.ts";
import { loadClaudeToken } from "./claude-auth.ts";
import { fetchAnthropicModels } from "./anthropic-models.ts";
import type { ModelMetadata } from "./pricing.ts";

export interface DiscoveredSdkModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
}

/** Injected so the llm layer never imports the agent/claude-sdk backend. */
export type SdkDiscoverer = () => Promise<DiscoveredSdkModel[]>;

const CACHE_PATH = join(MY_CLAW_DIR, "model-catalog.json");
const DISCOVER_TIMEOUT_MS = 15_000;

/**
 * Merge curated config models with discovered ones. Config always wins on id collision, so the
 * owner can override a discovered model's label/group/limit/vision by declaring the same id.
 */
export function mergeModels(base: LlmModelConfig[], discovered: LlmModelConfig[]): LlmModelConfig[] {
  const seen = new Set(base.map((m) => m.id));
  const extra = discovered.filter((m) => !seen.has(m.id));
  return [...base, ...extra];
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
  if (!table) return models;
  return models.map((m) => {
    if (m.limit?.context) return m;
    const hit = table.contextWindowOf(m.id, m.provider ? providers[m.provider]?.baseUrl : undefined);
    if (!hit) return m;
    return { ...m, limit: { ...m.limit, context: hit.tokens }, contextFrom: "models.dev" };
  });
}

interface WindowTable {
  contextWindowOf(model: string, baseUrl?: string, upstreamApiBase?: string): { tokens: number } | undefined;
}

/**
 * Capabilities for the models whose provider answered with a list of ids and nothing else, read
 * from the same models.dev download as the prices. See docs/model-metadata.md.
 *
 * Gap-filling only (R7): a field already set is either a statement by the owner or by a provider
 * answering for its own models (claude-sdk, codex, Anthropic's versioned endpoint), and a community
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
  if (!table) return models;
  return models.map((m) => {
    const needsLabel = m.label === m.id;
    const needsEffort = m.supportsEffort === undefined;
    const needsVision = m.vision === undefined;
    const needsOutput = m.limit?.output === undefined;
    if (!needsLabel && !needsEffort && !needsVision && !needsOutput) return m;
    const meta = table.metadataOf(m.id, m.provider ? providers[m.provider]?.baseUrl : undefined);
    if (!meta) return m;
    const next: LlmModelConfig = { ...m };
    if (needsLabel && meta.label !== undefined) next.label = meta.label;
    if (needsEffort && meta.effortLevels !== undefined) {
      next.supportsEffort = true;
      next.supportedEffortLevels = meta.effortLevels;
    }
    if (needsVision && meta.vision !== undefined) next.vision = meta.vision;
    if (needsOutput && meta.outputLimit !== undefined) next.limit = { ...next.limit, output: meta.outputLimit };
    return next;
  });
}

interface MetadataTable {
  metadataOf(model: string, baseUrl?: string): ModelMetadata | undefined;
}

async function fetchOpenAiModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
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
async function fetchCodexModels(baseUrl: string): Promise<CodexDiscoveredModel[]> {
  const { accessToken, accountId } = await getCodexAccessToken();
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

/** Family submenu names keyed by their lowercase form, e.g. "opus" -> "Opus". */
function familyIndex(versioned: LlmModelConfig[]): Map<string, string> {
  const families = new Map<string, string>();
  for (const model of versioned) {
    if (model.family) families.set(model.family.toLowerCase(), model.family);
  }
  return families;
}

/**
 * The moving aliases, listed in the provider group next to the pinned versions. The "(auto)"
 * suffix is what tells them apart: "Opus (auto)" tracks the latest, "Opus 5" stays put. Every
 * provider lists flat, so this one does too.
 */
function aliasModels(
  aliases: DiscoveredSdkModel[],
  provider: string,
  config: LlmProviderConfig,
  families: Map<string, string>,
): LlmModelConfig[] {
  const out: LlmModelConfig[] = [];
  for (const alias of aliases) {
    // "default" is a redundant alias (resolves to another listed model).
    if (alias.value === "default") continue;
    // Variant markers like "opus[1m]" name the same family as the plain alias.
    const family = families.get(alias.value.replace(/\[.*\]$/, "").toLowerCase());
    const displayName = alias.displayName || alias.value;
    out.push({
      id: alias.value,
      label: family ? `${displayName} (auto)` : displayName,
      provider,
      group: config.group,
      // The SDK omits the flag entirely for models without reasoning, so normalize to a
      // definite false: "unknown" would make the picker offer the whole global list.
      supportsEffort: alias.supportsEffort === true,
      supportedEffortLevels: alias.supportedEffortLevels,
      vision: true,
    });
  }
  return out;
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

  constructor(
    private getConfig: () => LlmConfig,
    private sdkDiscoverer?: SdkDiscoverer,
  ) {
    this.loadCache();
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
    return Object.values(providers).some((p) => p.discover);
  }

  private loadCache(): void {
    try {
      const raw = readFileSync(CACHE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as { models?: LlmModelConfig[] };
      if (Array.isArray(parsed.models)) this.discoveredModels = parsed.models;
    } catch {
      // No cache yet (or unreadable) — discovery will populate it.
    }
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  /**
   * Versioned Claude models, listed flat in the provider group like every other provider. The
   * family only orders them: the label already says which is which.
   */
  private async claudeVersionedModels(name: string, provider: LlmProviderConfig): Promise<LlmModelConfig[]> {
    const token = await loadClaudeToken();
    if (!token) return [];
    const models = await fetchAnthropicModels(token);
    return models.map((m) => ({
      id: m.id,
      label: m.label,
      provider: name,
      group: provider.group,
      family: m.family,
      supportsEffort: m.effortLevels.length > 0,
      supportedEffortLevels: m.effortLevels.length > 0 ? m.effortLevels : undefined,
      vision: m.vision,
      limit: { context: m.contextLimit, output: m.outputLimit },
    }));
  }

  /**
   * Re-discover every `discover` provider and update the merged set. Never throws: a provider
   * that fails to answer keeps its previously discovered models.
   */
  async refresh(): Promise<void> {
    const config = this.getConfig();
    const providers = config.providers ?? {};
    if (!this.enabled()) return;

    const next: LlmModelConfig[] = [];
    let anyFailed = false;

    for (const [name, provider] of Object.entries(providers)) {
      if (!provider.discover) continue;
      const before = next.length;
      let complete = true;
      try {
        if (provider.type === "claude-sdk") {
          if (!this.sdkDiscoverer) continue;
          const aliases = await this.sdkDiscoverer();
          // Versioned models come from a separate endpoint: losing it must not drop the aliases,
          // which are what makes the provider usable at all.
          let versioned: LlmModelConfig[] = [];
          try {
            versioned = await this.claudeVersionedModels(name, provider);
          } catch (err) {
            anyFailed = true;
            // Half an answer is not an answer: the versioned set falls back to what was already
            // known, so this listing cannot be used as evidence that a model disappeared.
            complete = false;
            void log("warn", "anthropic versioned model discovery failed", { error: String(err) });
            const aliasIds = new Set(aliases.map((m) => m.value));
            versioned = this.discoveredModels.filter((m) => m.provider === name && !aliasIds.has(m.id));
          }
          next.push(...aliasModels(aliases, name, provider, familyIndex(versioned)));
          next.push(...versioned);
        } else if (provider.type === "codex") {
          const models = await fetchCodexModels(provider.baseUrl ?? "");
          for (const m of models) {
            next.push({
              id: m.id,
              label: m.label,
              provider: name,
              group: provider.group,
              supportsEffort: true,
              supportedEffortLevels: m.supportedEffortLevels,
              vision: m.vision,
            });
          }
        } else {
          const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
          const ids = await fetchOpenAiModels(provider.baseUrl ?? "", apiKey);
          for (const id of ids) {
            next.push({ id, label: id, provider: name, group: provider.group });
          }
        }
      } catch (err) {
        anyFailed = true;
        complete = false;
        void log("warn", "model discovery failed for provider", { provider: name, error: String(err) });
        // Keep this provider's previously discovered models on failure.
        for (const m of this.discoveredModels) {
          if (m.provider === name) next.push(m);
        }
      }
      // Recorded before the cross-provider dedupe below, which would otherwise hide an id under
      // whichever provider listed it first and make it look absent from the other.
      if (complete) {
        this.listedByProvider.set(name, new Set(next.slice(before).map((m) => m.id)));
      } else {
        this.listedByProvider.delete(name);
      }
    }

    // Dedupe by id across providers (first wins).
    const seen = new Set<string>();
    this.discoveredModels = next.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));

    await writeJsonFileAtomically(CACHE_PATH, { models: this.discoveredModels }, true).catch((err) =>
      void log("warn", "model catalog cache write failed", { error: String(err) }),
    );
    hooks.emit("models:discovered", { count: this.discoveredModels.length, anyFailed });
    this.notify();
  }
}
