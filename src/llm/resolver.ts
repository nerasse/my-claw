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
      headers: provider.headers,
      vision: model?.vision ?? merged.vision,
      limit: model?.limit ?? merged.limit,
      effort: computeEffort(merged, model, true, effortOverride),
    };
  }

  return {
    baseUrl: provider.baseUrl ?? "",
    model: effectiveModelId,
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

export function resolveAgentLlmConfig(
  agentConfig: AgentLlmConfig | undefined,
  globalConfig: LlmConfig,
  modelId?: string,
): ResolvedLlmConfig {
  const merged: LlmConfig = {
    ...globalConfig,
    defaultProvider: agentConfig?.defaultProvider ?? globalConfig.defaultProvider,
    defaultModel: agentConfig?.defaultModel ?? globalConfig.defaultModel,
  };
  return resolveFromMerged(merged, modelId);
}

export function listAvailableModels(config: LlmConfig): LlmModelConfig[] {
  return config.models ?? [];
}

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

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
