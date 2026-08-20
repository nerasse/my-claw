import type { AgentLlmConfig, EffortLevel, LlmConfig, LlmModelConfig, LlmProviderConfig, ResolvedLlmConfig, TagConfig } from "../core/config.ts";
import { tagNameOf } from "../core/config.ts";
import { clampEffortToLadder } from "./effort-ladder.ts";
import { parseModelRef } from "./model-ref.ts";
import { cachedOpenRouterEndpointLimits } from "./openrouter-endpoints.ts";
import { CODEX_BASE_URL } from "./codex-auth.ts";

/** Native Messages endpoint of the Claude subscription backend. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * The endpoint a provider actually talks to, which is not always the one it declares: the three
 * subscription backends default theirs, and `claude-sdk` has no HTTP endpoint at all so it carries
 * a marker instead.
 *
 * Exported because the resolver is not the only consumer. Anything that has to recognise the
 * vendor behind a provider (pricing, the models.dev capability gap-fill) needs the effective
 * endpoint, and reading `provider.baseUrl` there silently returns undefined for exactly the three
 * providers whose own discovery says the least about its models.
 */
export function providerBaseUrl(provider: LlmProviderConfig | undefined): string {
  if (provider?.baseUrl) return provider.baseUrl;
  switch (provider?.type) {
    case "claude-sdk":
      return "claude-sdk";
    case "anthropic":
      return ANTHROPIC_BASE_URL;
    case "codex":
      return CODEX_BASE_URL;
    default:
      return "";
  }
}

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

/**
 * The model a reference addresses. Three rules, most specific first (docs/model-identity.md):
 *
 * 1. the reference is an id verbatim, which covers everything declared in config and every
 *    qualified reference discovery produced;
 * 2. it names a provider, so only that provider's copy of the id can answer;
 * 3. it names no provider, so the first provider that serves it answers, in config order. This is
 *    the short form, the one the config default, the tags and every stored session use.
 */
/**
 * The catalogue entry a reference names, by the three rules of docs/model-identity.md. Exported
 * because it is the only lookup allowed: the catalogue holds qualified ids (`anthropic/opus`)
 * while a config, a tag or a session may hold the bare one, and an `id ===` comparison somewhere
 * else reads that as an unknown model.
 */
export function findModel(config: LlmConfig, modelId: string): LlmModelConfig | undefined {
  const models = config.models;
  if (!models) return undefined;
  const exact = models.find((m) => m.id === modelId);
  if (exact) return exact;
  const ref = parseModelRef(modelId, Object.keys(config.providers ?? {}));
  if (ref.provider) {
    return models.find((m) => m.provider === ref.provider && (m.apiId ?? m.id) === ref.apiId);
  }
  return models.find((m) => (m.apiId ?? m.id) === ref.apiId);
}

/**
 * OpenRouter is recognised by its host, never by the key it was given in the config: the endpoint
 * pin becomes a `provider` object in the request body, and no other API understands that field.
 */
export function isOpenRouterBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).host.endsWith("openrouter.ai");
  } catch {
    return false;
  }
}

/**
 * Expand a tag reference (`tag:<name>`, docs/tags.md) into the model id it aliases. The
 * reserved name `Default` is virtual and tracks the current default model. A tag may point at
 * another tag: the chain is followed to a real model, keeping the outer tag's own effort (the
 * most explicit pin wins). An unknown tag name passes through unchanged so it resolves like any
 * other stale id instead of throwing. A chain that loops (`tag:A` -> `tag:B` -> `tag:A`, or a
 * tag pinning itself) has no leaf and is refused loudly, the same way an unknown provider is:
 * the config is broken, and every run through it would silently carry a tag id as its model.
 */
function expandTag(
  merged: LlmConfig,
  modelId: string,
  seen: ReadonlySet<string> = new Set(),
): { tag?: TagConfig; modelId: string } {
  const name = tagNameOf(modelId);
  if (name === undefined) return { modelId };
  if (seen.has(name)) {
    throw new Error(`Tag cycle: ${[...seen, name].join(" -> ")} (fix the tags in config.json)`);
  }
  const tag = name === "Default" ? { model: merged.defaultModel ?? merged.model ?? "" } : merged.tags?.[name];
  if (!tag) return { modelId };
  if (tagNameOf(tag.model) === undefined) return { tag, modelId: tag.model };
  const leaf = expandTag(merged, tag.model, new Set(seen).add(name));
  return {
    tag: { model: leaf.modelId, effort: tag.effort ?? leaf.tag?.effort, contextCap: tag.contextCap ?? leaf.tag?.contextCap },
    modelId: leaf.modelId,
  };
}

/**
 * The model a reference ends on, for callers that need the model's own metadata (its window, the
 * provenance of that window) rather than the run identity. Menus and `/status` used to read
 * `llm.models` by the literal id, which no `tag:` reference ever matches: every tag then reported
 * the fallback window instead of the one its model declares. A broken chain answers with the id
 * itself, so a display degrades instead of throwing.
 */
export function leafModelId(config: LlmConfig, modelId: string): string {
  try {
    return expandTag(config, modelId).modelId;
  } catch {
    return modelId;
  }
}

/**
 * Effective effort for a run: session override > the tag's own pin > the scope's pin (a cron
 * job first, then the agent) > the global default. The tag is indivisible: referencing it
 * accepts the effort it carries, and only the session sits above it. Only emitted when it
 * should actually be sent — claude-sdk and codex accept it natively; other openai-compatible
 * providers get it only when the model opts in via `supportsEffort`.
 */
function computeEffort(
  merged: LlmConfig,
  model: LlmModelConfig | undefined,
  nativeEffort: boolean,
  effortOverride?: EffortLevel,
  scopeEffort?: EffortLevel,
  tagEffort?: EffortLevel,
): EffortLevel | undefined {
  const chosen = effortOverride ?? tagEffort ?? scopeEffort ?? merged.effort;
  if (!chosen) return undefined;
  if (!effortApplies(model, nativeEffort)) return undefined;
  return clampEffortToLadder(chosen, model?.supportedEffortLevels, model?.id ?? "");
}

/**
 * Whether this model should be sent an effort at all.
 *
 * Explicit `false` is the provider stating the model has none, which outranks the backend being
 * effort-native (Haiku on the SDK); `undefined` only blocks the non-native backends, where the
 * parameter is never sent without an opt-in. One implementation because the two used to disagree:
 * the menus reported "unsupported" for Haiku while every run still sent it a level.
 */
function effortApplies(model: LlmModelConfig | undefined, native: boolean): boolean {
  if (model?.supportsEffort === false) return false;
  return native || model?.supportsEffort === true;
}

function resolveFromMerged(
  merged: LlmConfig,
  modelId?: string,
  effortOverride?: EffortLevel,
  scopeEffort?: EffortLevel,
): ResolvedLlmConfig {
  const rawModelId = modelId ?? merged.defaultModel ?? merged.model ?? "";
  // A tag reference keeps its identity on the resolved config (status, context cap, analytics)
  // while the API receives the tag's underlying model via `apiModel`.
  const expanded = expandTag(merged, rawModelId);
  const effectiveModelId = expanded.modelId;
  const tagEffort = expanded.tag?.effort;

  if (!isNewFormat(merged)) {
    const provider = buildImplicitProvider(merged);
    return {
      baseUrl: provider.baseUrl || "https://api.fireworks.ai/inference/v1",
      model: rawModelId,
      ...(expanded.tag ? { apiModel: effectiveModelId } : {}),
      provider: "default",
      apiKey: resolveApiKey(provider, merged.apiKey),
      vision: merged.vision,
      limit: merged.limit,
    };
  }

  const model = findModel(merged, effectiveModelId);
  const ref = parseModelRef(effectiveModelId, Object.keys(merged.providers ?? {}));
  const providerName = model?.provider ?? ref.provider ?? merged.defaultProvider ?? "default";
  const provider = merged.providers?.[providerName];

  if (!provider) {
    throw new Error(`Provider "${providerName}" not found in config. Available: ${Object.keys(merged.providers ?? {}).join(", ")}`);
  }

  // What the request carries, as opposed to what the run is called. They differ for a tag, for a
  // provider-qualified reference and for a pinned endpoint; `model` stays the identity so status,
  // analytics and the picker keep speaking of the same thing.
  const wireModel = model?.apiId ?? ref.apiId;
  const apiModel = wireModel === rawModelId ? {} : { apiModel: wireModel };
  const providerRoute = ref.endpoint && isOpenRouterBaseUrl(provider.baseUrl) ? { providerRoute: ref.endpoint } : {};

  // The tag's own pin rides above every scope: referencing a tag accepts both halves of it.
  if (provider.type === "claude-sdk") {
    return {
      backend: "claude-sdk",
      // No HTTP endpoint on this path; the marker keeps analytics rows self-describing.
      baseUrl: providerBaseUrl(provider),
      model: rawModelId,
      ...apiModel,
      provider: providerName,
      vision: model?.vision ?? merged.vision,
      limit: model?.limit ?? merged.limit,
      fallbackModel: provider.fallbackModel,
      effort: computeEffort(merged, model, true, effortOverride, scopeEffort, tagEffort),
    };
  }

  if (provider.type === "anthropic") {
    return {
      backend: "anthropic",
      // Claude subscription on the home loop with the native Messages transport; the token is
      // fetched by the transport, so no apiKey rides here. See docs/anthropic-backend.md.
      baseUrl: providerBaseUrl(provider),
      model: rawModelId,
      ...apiModel,
      provider: providerName,
      headers: provider.headers,
      vision: model?.vision ?? merged.vision,
      limit: model?.limit ?? merged.limit,
      thinkingTypes: model?.thinkingTypes,
      effortLevels: model?.supportedEffortLevels,
      fallbackModel: provider.fallbackModel,
      effort: computeEffort(merged, model, true, effortOverride, scopeEffort, tagEffort),
    };
  }

  if (provider.type === "codex") {
    return {
      backend: "codex",
      // ChatGPT subscription via the Codex Responses backend; auth is the stored OAuth token,
      // fetched by the transport (no apiKey here). See docs/codex-backend.md.
      baseUrl: providerBaseUrl(provider),
      model: rawModelId,
      ...apiModel,
      provider: providerName,
      headers: provider.headers,
      vision: model?.vision ?? merged.vision,
      limit: model?.limit ?? merged.limit,
      effort: computeEffort(merged, model, true, effortOverride, scopeEffort, tagEffort),
    };
  }

  return {
    baseUrl: provider.baseUrl ?? "",
    model: rawModelId,
    ...apiModel,
    ...providerRoute,
    provider: providerName,
    apiKey: resolveApiKey(provider, merged.apiKey),
    headers: provider.headers,
    vision: model?.vision ?? merged.vision,
    limit: pinnedLimit(model?.limit ?? merged.limit, wireModel, providerRoute.providerRoute),
    effort: computeEffort(merged, model, false, effortOverride, scopeEffort, tagEffort),
    promptCache: provider.promptCache,
  };
}

/**
 * Lower a model's declared limits to the pinned endpoint's own, when they are known.
 *
 * OpenRouter publishes model-level figures taken from its *best* endpoint, so a pinned run would
 * otherwise reason about capacity it does not have: the output ask becomes a 404 (see
 * clampOutputToPinnedEndpoint in provider.ts) and the context budget aims past the endpoint's real
 * window, which shows up much later as a trim that never trims enough. Read from the cache only,
 * because resolution is synchronous; no cached listing means the declared limits stand.
 */
function pinnedLimit(
  limit: { context?: number; output?: number } | undefined,
  wireModel: string,
  route: string | undefined,
): { context?: number; output?: number } | undefined {
  if (!route) return limit;
  const endpoint = cachedOpenRouterEndpointLimits(wireModel, route);
  if (!endpoint) return limit;

  const context = smaller(limit?.context, endpoint.context);
  const output = smaller(limit?.output, endpoint.maxOutput);
  if (context === undefined && output === undefined) return limit;
  return { ...(context === undefined ? {} : { context }), ...(output === undefined ? {} : { output }) };
}

/** The tighter of two ceilings, ignoring the ones nobody declared. */
function smaller(declared?: number, endpoint?: number): number | undefined {
  if (declared === undefined) return endpoint;
  if (endpoint === undefined) return declared;
  return Math.min(declared, endpoint);
}

export function resolveLlmConfig(
  config: LlmConfig,
  modelId?: string,
  effortOverride?: EffortLevel,
  scopeEffort?: EffortLevel,
): ResolvedLlmConfig {
  return resolveFromMerged(config, modelId, effortOverride, scopeEffort);
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
  scopeEffort?: EffortLevel,
): ResolvedLlmConfig {
  const resolved = resolveLlmConfig(config, modelId, effortOverride, scopeEffort);
  if (!hasImages || resolved.vision) return resolved;

  const fallbackId = config.visionFallback;
  if (!fallbackId || fallbackId === resolved.model) return resolved;
  const fallbackModel = findModel(config, fallbackId);
  if (!fallbackModel?.vision) return resolved;

  return resolveLlmConfig(config, fallbackId, effortOverride, scopeEffort);
}

/**
 * An agent's defaults layered over the global ones. Only the two keys an agent may override:
 * the effort of the scope is passed to the resolvers explicitly, never merged here, so it
 * stays under the tag's pin (a merge would slot it where the global default sits).
 */
export function mergeAgentLlm(agentConfig: AgentLlmConfig | undefined, globalConfig: LlmConfig): LlmConfig {
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
  scopeEffort?: EffortLevel,
): ResolvedLlmConfig {
  return resolveFromMerged(
    mergeAgentLlm(agentConfig, globalConfig),
    modelId,
    undefined,
    scopeEffort ?? agentConfig?.effort,
  );
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
  scopeEffort?: EffortLevel,
): ResolvedLlmConfig {
  return resolveLlmConfigForMessage(
    mergeAgentLlm(agentConfig, globalConfig),
    modelId,
    hasImages,
    effortOverride,
    scopeEffort ?? agentConfig?.effort,
  );
}

export function listAvailableModels(config: LlmConfig): LlmModelConfig[] {
  return config.models ?? [];
}

/**
 * The levels offered when nothing describes a model: the global/tag/agent pin vocabulary, and the
 * fallback ladder in the picker.
 *
 * Deliberately narrower than `EffortLevel`. `none` and `minimal` exist, but only where a model
 * publishes them (docs/model-metadata.md R1): this list reaches every model no source describes,
 * across every provider, and offering a rung on no evidence is how an endpoint answers 400.
 */
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
      return isEffortNativeBackend(resolveLlmConfig(config, m.id).backend);
    } catch {
      return false;
    }
  });
  const anySupports = models.some((m) => m.supportsEffort);
  return { enabled: anyNative || anySupports || config.effort !== undefined, levels: EFFORT_LEVELS };
}

// Two engines document `high` as what they apply when a request carries no effort: the Claude Agent
// SDK (the EffortLevel doc comment in its typings) and the Messages API itself, where the effort
// doc states naming `high` is identical to omitting the field. Codex and plain OpenAI-compatible
// providers document no such value, so their unset state stays unnamed instead of guessed.
const DOCUMENTED_DEFAULT_EFFORT: EffortLevel = "high";

/**
 * Backends that steer effort themselves rather than forwarding a `reasoning_effort` field an
 * OpenAI-compatible provider may or may not read. Written once: three call sites used to spell the
 * list out, and each new engine had to be remembered in all of them.
 */
export function isEffortNativeBackend(backend: ResolvedLlmConfig["backend"]): boolean {
  return backend === "claude-sdk" || backend === "codex" || backend === "anthropic";
}

export type EffortSource = "session" | "tag" | "scope" | "config" | "sdk-default" | "api-default" | "provider-default" | "unsupported";

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
 * The scope's pin (a cron job first, then the agent) arrives as a single value: the two merge
 * before this is called, so the source is one "scope" whatever its owner.
 */
export function effectiveEffort(
  config: LlmConfig,
  modelId?: string,
  sessionOverride?: EffortLevel,
  scopeEffort?: EffortLevel,
): EffectiveEffort {
  let backend: ResolvedLlmConfig["backend"];
  try {
    backend = resolveLlmConfig(config, modelId).backend;
  } catch {
    // Stale model override after a config edit: claiming a level here would invent one.
    return { source: "unsupported" };
  }

  const model = findModel(config, expandTag(config, modelId ?? config.defaultModel ?? config.model ?? "").modelId);
  const tag = expandTag(config, modelId ?? config.defaultModel ?? config.model ?? "").tag;
  const native = isEffortNativeBackend(backend);
  if (!effortApplies(model, native)) return { source: "unsupported" };

  // The level the run would send, clamp included: reporting the pin verbatim is how a menu came to
  // name a rung the request never carried.
  const shown = (level: EffortLevel): EffortLevel => clampEffortToLadder(level, model?.supportedEffortLevels, model?.id ?? "");
  if (sessionOverride) return { level: shown(sessionOverride), source: "session" };
  if (tag?.effort) return { level: shown(tag.effort), source: "tag" };
  if (scopeEffort) return { level: shown(scopeEffort), source: "scope" };
  if (config.effort) return { level: shown(config.effort), source: "config" };
  if (backend === "claude-sdk") return { level: DOCUMENTED_DEFAULT_EFFORT, source: "sdk-default" };
  if (backend === "anthropic") return { level: DOCUMENTED_DEFAULT_EFFORT, source: "api-default" };
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
