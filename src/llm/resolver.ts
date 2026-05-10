import type { LlmConfig, LlmModelConfig, LlmProviderConfig, ResolvedLlmConfig } from "../core/config.ts";

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

export function resolveLlmConfig(config: LlmConfig, modelId?: string): ResolvedLlmConfig {
  const effectiveModelId = modelId ?? config.defaultModel ?? config.model ?? "";

  if (!isNewFormat(config)) {
    const provider = buildImplicitProvider(config);
    return {
      baseUrl: provider.baseUrl || "https://api.fireworks.ai/inference/v1",
      model: effectiveModelId,
      apiKey: resolveApiKey(provider, config.apiKey),
      vision: config.vision,
      limit: config.limit,
    };
  }

  const model = findModel(config, effectiveModelId);
  const providerName = model?.provider ?? config.defaultProvider ?? "default";
  const provider = config.providers?.[providerName];

  if (!provider) {
    throw new Error(`Provider "${providerName}" not found in config. Available: ${Object.keys(config.providers ?? {}).join(", ")}`);
  }

  return {
    baseUrl: provider.baseUrl,
    model: effectiveModelId,
    apiKey: resolveApiKey(provider, config.apiKey),
    headers: provider.headers,
    vision: model?.vision ?? config.vision,
    limit: model?.limit ?? config.limit,
  };
}

export function listAvailableModels(config: LlmConfig): LlmModelConfig[] {
  return config.models ?? [];
}
