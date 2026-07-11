import type { AgentLlmConfig, LlmConfig, LlmModelConfig, LlmProviderConfig, ResolvedLlmConfig } from "../core/config.ts";

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

function resolveFromMerged(
  merged: LlmConfig,
  modelId?: string,
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
    };
  }

  return {
    baseUrl: provider.baseUrl ?? "",
    model: effectiveModelId,
    apiKey: resolveApiKey(provider, merged.apiKey),
    headers: provider.headers,
    vision: model?.vision ?? merged.vision,
    limit: model?.limit ?? merged.limit,
  };
}

export function resolveLlmConfig(config: LlmConfig, modelId?: string): ResolvedLlmConfig {
  return resolveFromMerged(config, modelId);
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
): ResolvedLlmConfig {
  const resolved = resolveLlmConfig(config, modelId);
  if (!hasImages || resolved.vision) return resolved;

  const fallbackId = config.visionFallback;
  if (!fallbackId || fallbackId === resolved.model) return resolved;
  const fallbackModel = findModel(config, fallbackId);
  if (!fallbackModel?.vision) return resolved;

  return resolveLlmConfig(config, fallbackId);
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
 * Resolve a config guaranteed to target an OpenAI-compatible endpoint. Utility LLM callers
 * (compaction summarizer, memory consolidation, browser sub-agent) speak chat-completions
 * directly and would send HTTP to the placeholder "claude-sdk" baseUrl if the requested or
 * default model lives on the SDK backend; they fall back to the first openai model instead.
 */
export function resolveOpenAiLlmConfig(config: LlmConfig, modelId?: string): ResolvedLlmConfig {
  const resolved = resolveLlmConfig(config, modelId);
  if (resolved.backend !== "claude-sdk") return resolved;
  for (const model of config.models ?? []) {
    const candidate = resolveLlmConfig(config, model.id);
    if (candidate.backend !== "claude-sdk") return candidate;
  }
  throw new Error("No OpenAI-compatible model configured (all models are claude-sdk backed)");
}
