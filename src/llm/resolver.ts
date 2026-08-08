import type { AgentLlmConfig, EffortLevel, LlmConfig, LlmModelConfig, LlmProviderConfig, ResolvedLlmConfig } from "../core/config.ts";

function resolveApiKey(provider?: LlmProviderConfig, globalApiKey?: string): string | undefined {
  if (globalApiKey) return globalApiKey;
  if (provider?.apiKeyEnv) {
    const envKey = process.env[provider.apiKeyEnv];
    if (envKey) return envKey;
  }
  return process.env["FIREWORKS_API_KEY"] ?? process.env["OPENAI_API_KEY"];
}

function isNewFormat(config: LlmConfig): boolean {
  return config.providers !== undefined || config.defaultProvider !== undefined;
}

function buildImplicitProvider(config: LlmConfig): LlmProviderConfig {
  return {
    baseUrl: config.baseUrl ?? "",
  };
}

function findModel(config: LlmConfig, modelId: string): LlmModelConfig | undefined {
  return config.models?.find((m) => m.id === modelId);
}

/**
 * Effective effort for a run: session override > per-model default > global default. Only
 * emitted when it should actually be sent — claude-sdk and codex accept it natively; other
 * openai-compatible providers get it only when the model opts in via `supportsEffort`.
 */
function computeEffort(
  merged: LlmConfig,
  model: LlmModelConfig | undefined,
  nativeEffort: boolean,
  effortOverride?: EffortLevel,
): EffortLevel | undefined {
  const chosen = effortOverride ?? model?.effort ?? merged.effort;
  if (!chosen) return undefined;
  if (nativeEffort) return chosen;
  return model?.supportsEffort ? chosen : undefined;
}

function resolveFromMerged(
  merged: LlmConfig,
  modelId?: string,
  effortOverride?: EffortLevel,
): ResolvedLlmConfig {
  const effectiveModelId = modelId ?? merged.defaultModel ?? merged.model ?? "";

  if (!isNewFormat(merged)) {
    const provider = buildImplicitProvider(merged);
    return {
      baseUrl: provider.baseUrl || "https://api.fireworks.ai/inference/v1",
      model: effectiveModelId,
      provider: "default",
      apiKey: resolveApiKey(provider, merged.apiKey),
      vision: merged.vision,
      limit: merged.limit,
    };
  }

  const model = findModel(merged, effectiveModelId);
  const providerName = model?.provider ?? merged.defaultProvider ?? "default";
  const provider = merged.providers?.[providerName];

  if (!provider) {
    throw new Error(`Provider "${providerName}" not found in config. Available: ${Object.keys(merged.providers ?? {}).join(", ")}`);
  }

  if (provider.type === "claude-sdk") {
    return {
      backend: "claude-sdk",
      // No HTTP endpoint on this path; the marker keeps analytics rows self-describing.
      baseUrl: "claude-sdk",
      model: effectiveModelId,
      provider: providerName,
      vision: model?.vision ?? merged.vision,
      limit: model?.limit ?? merged.limit,
      fallbackModel: provider.fallbackModel,
      effort: computeEffort(merged, model, true, effortOverride),
    };
  }

  if (provider.type === "codex") {
    return {
      backend: "codex",
      // ChatGPT subscription via the Codex Responses backend; auth is the stored OAuth token,
      // fetched by the transport (no apiKey here). See docs/codex-backend.md.
      baseUrl: provider.baseUrl ?? "https://chatgpt.com/backend-api",
      model: effectiveModelId,
      provider: providerName,
      headers: provider.headers,
      vision: model?.vision ?? merged.vision,
      limit: model?.limit ?? merged.limit,
      effort: computeEffort(merged, model, true, effortOverride),
    };
  }

  return {
    baseUrl: provider.baseUrl ?? "",
    model: effectiveModelId,
    provider: providerName,
    apiKey: resolveApiKey(provider, merged.apiKey),
    headers: provider.headers,
    vision: model?.vision ?? merged.vision,
    limit: model?.limit ?? merged.limit,
    effort: computeEffort(merged, model, false, effortOverride),
    promptCache: provider.promptCache,
  };
}

export function resolveLlmConfig(config: LlmConfig, modelId?: string, effortOverride?: EffortLevel): ResolvedLlmConfig {
  return resolveFromMerged(config, modelId, effortOverride);
}

/**
 * Like resolveLlmConfig, but reroutes the run to `visionFallback` when the message carries
 * images and the resolved model cannot take them. The fallback must be a declared,
 * vision-capable model: a typo or a text-only target must never silently hijack the run.
 */
export function resolveLlmConfigForMessage(
  config: LlmConfig,
  modelId: string | undefined,
  hasImages: boolean,
  effortOverride?: EffortLevel,
): ResolvedLlmConfig {
  const resolved = resolveLlmConfig(config, modelId, effortOverride);
  if (!hasImages || resolved.vision) return resolved;

  const fallbackId = config.visionFallback;
  if (!fallbackId || fallbackId === resolved.model) return resolved;
  const fallbackModel = findModel(config, fallbackId);
  if (!fallbackModel?.vision) return resolved;

  return resolveLlmConfig(config, fallbackId, effortOverride);
}

/** An agent's defaults layered over the global ones. Only the two keys an agent may override. */
function mergeAgentLlm(agentConfig: AgentLlmConfig | undefined, globalConfig: LlmConfig): LlmConfig {
  return {
    ...globalConfig,
    defaultProvider: agentConfig?.defaultProvider ?? globalConfig.defaultProvider,
    defaultModel: agentConfig?.defaultModel ?? globalConfig.defaultModel,
  };
}

export function resolveAgentLlmConfig(
  agentConfig: AgentLlmConfig | undefined,
  globalConfig: LlmConfig,
  modelId?: string,
): ResolvedLlmConfig {
  return resolveFromMerged(mergeAgentLlm(agentConfig, globalConfig), modelId);
}

/**
 * The agent-aware form of `resolveLlmConfigForMessage`, for the agents that run a real message
 * rather than a synthetic sub-agent turn. Sub-agents go through `resolveAgentLlmConfig` instead
 * and lose the vision fallback and the session effort with it, which is fine for them because
 * their turn carries no attachment; the orchestrator and cron both need those kept.
 *
 * Precedence: the session's own `/model` first, then the agent's configured default, then the
 * global default. A per-chat choice must never be silently overruled by a config edit.
 */
export function resolveLlmConfigForAgentMessage(
  globalConfig: LlmConfig,
  agentConfig: AgentLlmConfig | undefined,
  modelId: string | undefined,
  hasImages: boolean,
  effortOverride?: EffortLevel,
): ResolvedLlmConfig {
  return resolveLlmConfigForMessage(mergeAgentLlm(agentConfig, globalConfig), modelId, hasImages, effortOverride);
}

export function listAvailableModels(config: LlmConfig): LlmModelConfig[] {
  return config.models ?? [];
}

export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * Whether the effort UI should be offered, and the levels to show. Enabled when any model can
 * actually honor effort (claude-sdk backend or an opt-in `supportsEffort`) or a global default
 * is set — otherwise the menu entry would be a no-op.
 */
export function effortOptionsFor(config: LlmConfig): { enabled: boolean; levels: EffortLevel[] } {
  const models = config.models ?? [];
  const anyNative = models.some((m) => {
    try {
      const backend = resolveLlmConfig(config, m.id).backend;
      return backend === "claude-sdk" || backend === "codex";
    } catch {
      return false;
    }
  });
  const anySupports = models.some((m) => m.supportsEffort);
  return { enabled: anyNative || anySupports || config.effort !== undefined, levels: EFFORT_LEVELS };
}

// The Claude Agent SDK documents `high` as what it applies when a query carries no effort
// (see the EffortLevel doc comment in its typings). Codex and plain OpenAI-compatible providers
// document no such value, so their unset state stays unnamed instead of guessed.
const SDK_DEFAULT_EFFORT: EffortLevel = "high";

export type EffortSource = "session" | "model" | "config" | "sdk-default" | "provider-default" | "unsupported";

export interface EffectiveEffort {
  // Absent when nothing sets a level and the provider documents no default of its own.
  level?: EffortLevel;
  source: EffortSource;
}

/**
 * What effort a run on this model would actually use, and where that value comes from.
 *
 * The menus used to render the raw `session ?? global` chain, which disagreed with computeEffort
 * on two counts: it skipped the per-model default, and it reported "default" even for models
 * that discard effort outright. Callers need the origin too, because "high because you asked for
 * it" and "high because the SDK falls back to it" are different answers to the same question.
 */
export function effectiveEffort(
  config: LlmConfig,
  modelId?: string,
  sessionOverride?: EffortLevel,
): EffectiveEffort {
  let backend: ResolvedLlmConfig["backend"];
  try {
    backend = resolveLlmConfig(config, modelId).backend;
  } catch {
    // Stale model override after a config edit: claiming a level here would invent one.
    return { source: "unsupported" };
  }

  const model = findModel(config, modelId ?? config.defaultModel ?? config.model ?? "");
  const native = backend === "claude-sdk" || backend === "codex";
  // Explicit `false` is the provider stating this model has no effort at all, which outranks the
  // backend being effort-native (Haiku on the SDK). `undefined` only blocks non-native backends,
  // where the parameter is never sent without an opt-in.
  if (model?.supportsEffort === false) return { source: "unsupported" };
  if (!native && !model?.supportsEffort) return { source: "unsupported" };

  if (sessionOverride) return { level: sessionOverride, source: "session" };
  if (model?.effort) return { level: model.effort, source: "model" };
  if (config.effort) return { level: config.effort, source: "config" };
  if (backend === "claude-sdk") return { level: SDK_DEFAULT_EFFORT, source: "sdk-default" };
  return { source: "provider-default" };
}

/**
 * True when this model id (or the default) resolves to the claude-sdk backend. Resolution
 * failures (stale override after a config edit) count as "not SDK" so callers fall back to
 * paths that surface a proper error.
 */
export function isSdkBackedModel(config: LlmConfig, modelId?: string): boolean {
  try {
    return resolveLlmConfig(config, modelId).backend === "claude-sdk";
  } catch {
    return false;
  }
}

/**
 * Resolve a config guaranteed to target an OpenAI-compatible chat/completions endpoint. Utility
 * LLM callers (compaction summarizer, memory consolidation, browser sub-agent) speak
 * chat-completions directly and would break on the non-HTTP claude-sdk path or the Responses-only
 * codex path; they fall back to the first plain openai model instead.
 */
export function resolveOpenAiLlmConfig(config: LlmConfig, modelId?: string): ResolvedLlmConfig {
  const isChatCompletions = (c: ResolvedLlmConfig): boolean => c.backend !== "claude-sdk" && c.backend !== "codex";
  const resolved = resolveLlmConfig(config, modelId);
  if (isChatCompletions(resolved)) return resolved;
  for (const model of config.models ?? []) {
    const candidate = resolveLlmConfig(config, model.id);
    if (isChatCompletions(candidate)) return candidate;
  }
  throw new Error("No OpenAI-compatible model configured (all models are claude-sdk or codex backed)");
}
