import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EffortLevel, LlmConfig, LlmModelConfig, LlmProviderConfig } from "../core/config.ts";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { getCodexAccessToken, CODEX_BASE_URL } from "./codex-auth.ts";

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
 */
export function applyProviderGroups(
  models: LlmModelConfig[],
  providers: Record<string, LlmProviderConfig>,
): LlmModelConfig[] {
  return models.map((m) => {
    if (m.group || !m.provider) return m;
    const group = providers[m.provider]?.group;
    return group ? { ...m, group } : m;
  });
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

const EFFORT_SET = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);
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

/**
 * Runtime model catalog: augments config.models with models discovered from providers marked
 * `discover`. Resilient by design — a failed provider keeps the last known set (persisted to
 * disk so the menu and model routing survive a restart while offline).
 */
export class ModelCatalog {
  private discoveredModels: LlmModelConfig[] = [];
  private listeners: Array<() => void> = [];

  constructor(
    private getConfig: () => LlmConfig,
    private sdkDiscoverer?: SdkDiscoverer,
  ) {
    this.loadCache();
  }

  discovered(): LlmModelConfig[] {
    return this.discoveredModels;
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
      try {
        if (provider.type === "claude-sdk") {
          if (!this.sdkDiscoverer) continue;
          const models = await this.sdkDiscoverer();
          for (const m of models) {
            // "default" is a redundant alias (resolves to another listed model).
            if (m.value === "default") continue;
            next.push({
              id: m.value,
              label: m.displayName || m.value,
              provider: name,
              group: provider.group,
              supportsEffort: m.supportsEffort,
              supportedEffortLevels: m.supportedEffortLevels,
              vision: true,
            });
          }
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
        void log("warn", "model discovery failed for provider", { provider: name, error: String(err) });
        // Keep this provider's previously discovered models on failure.
        for (const m of this.discoveredModels) {
          if (m.provider === name) next.push(m);
        }
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
