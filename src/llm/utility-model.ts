import type { AgentLlmConfig, LlmConfig, ResolvedLlmConfig } from "../core/config.ts";
import { mergeAgentLlm, resolveAgentLlmConfig, resolveLlmConfig } from "./resolver.ts";
import { availabilityOf } from "./run-model.ts";
import { availabilityWorld } from "./world.ts";

/**
 * Whether a single completion can be issued against this model from the home loop.
 *
 * Everything with an HTTP transport qualifies, which is every backend but one: `claude-sdk` is a
 * subprocess owning its own session, so there is no request to send. Allowlisting the exception
 * rather than the members is what keeps a new engine from being excluded by omission, which is how
 * the native Anthropic transport spent its first days barred from compaction.
 */
function hasHomeLoopTransport(resolved: ResolvedLlmConfig): boolean {
  return resolved.backend !== "claude-sdk";
}

/**
 * The same model on a transport the home loop can reach: an `anthropic` provider serving the exact
 * id the SDK was asked for.
 *
 * A claude-sdk pin is the only one that has to borrow, and since the native Messages transport
 * exists it no longer has to borrow from a stranger. The twin is the same model on the same
 * subscription, so an Opus session is summarized by Opus. Matching is by wire id only: the `opus`
 * and `sonnet` aliases are resolved server-side by the SDK and no `/v1/models` lists them, so they
 * have no twin and fall through to the default like anything else.
 */
function nativeTwin(config: LlmConfig, wireId: string | undefined): string | undefined {
  if (!wireId) return undefined;
  const native = Object.entries(config.providers ?? {})
    .filter(([, provider]) => provider.type === "anthropic")
    .map(([name]) => name);
  if (native.length === 0) return undefined;
  return (config.models ?? []).find(
    (m) => m.provider !== undefined && native.includes(m.provider) && (m.apiId ?? m.id) === wireId,
  )?.id;
}

/** The twin of an id that still has to be resolved. A config too broken to resolve has no twin. */
function twinOfModel(config: LlmConfig, modelId: string | undefined): string | undefined {
  try {
    const resolved = resolveLlmConfig(config, modelId);
    return nativeTwin(config, resolved.apiModel ?? resolved.model);
  } catch {
    return undefined;
  }
}

/**
 * What a utility call may borrow, best first: the native twin of the pin, the twin of the default,
 * the default itself, then whatever is declared.
 *
 * Declaration order used to be the whole policy, which made the answer an accident of the config
 * file: the first entry summarized every SDK session, whatever it was and whether or not it still
 * existed. The default comes first now because it is the one model the owner actually picked, and
 * its twin comes before it because an alias pin (`claude-sdk/opus`) has no twin of its own while
 * the default it inherits from usually does.
 */
function borrowOrder(config: LlmConfig, resolved: ResolvedLlmConfig): string[] {
  const defaultId = config.defaultModel ?? config.model;
  const preferred = [
    nativeTwin(config, resolved.apiModel ?? resolved.model),
    twinOfModel(config, defaultId),
    defaultId,
  ];
  return [...preferred.filter((id): id is string => Boolean(id)), ...(config.models ?? []).map((m) => m.id)];
}

/**
 * The resolved config when the home loop can call it, else the best model that can stand in.
 *
 * A candidate must be *runnable*, not merely declared: a provider that answered and did not list
 * the id has testified that it is gone (docs/model-resolution.md). Skipping that check is what let
 * compaction keep calling a model the gateway had renamed months earlier, turning every summary
 * into an HTTP 400 that only showed up as a session that would not compact.
 */
function homeLoopOrFallback(config: LlmConfig, resolved: ResolvedLlmConfig): ResolvedLlmConfig {
  if (hasHomeLoopTransport(resolved)) return resolved;
  const world = availabilityWorld();
  for (const id of borrowOrder(config, resolved)) {
    // `undefined` is an unknown id, not an unavailable one: a default pointing at nothing is as
    // unusable here as a model the provider dropped, and both are reported by the run that fails.
    if (availabilityOf(config, id, world)?.state !== "ready") continue;
    const candidate = resolveLlmConfig(config, id);
    if (hasHomeLoopTransport(candidate)) return candidate;
  }
  throw new Error("No runnable model with an HTTP transport configured (every candidate is claude-sdk backed or gone)");
}

/**
 * Resolve a config the utility LLM callers can issue one completion against (compaction summarizer,
 * memory consolidation). They dispatch through `llmComplete`, so any wire protocol will do and the
 * session's own model is kept: only a claude-sdk pin has to borrow another one.
 */
export function resolveUtilityLlmConfig(config: LlmConfig, modelId?: string): ResolvedLlmConfig {
  return homeLoopOrFallback(config, resolveLlmConfig(config, modelId));
}

/**
 * The same guarantee, for an agent that has a model of its own.
 *
 * The browser sub-agent runs on the home loop, so it cannot use a claude-sdk default; it was
 * therefore skipping agent resolution entirely and taking the first OpenAI-compatible model in the
 * catalogue, which meant `config.agents.browser` was quietly ignored and the model was whatever
 * happened to be listed first. The pin is honoured here, and the fallback only runs when the pin
 * itself has no HTTP transport.
 */
export function resolveUtilityAgentLlmConfig(
  agentConfig: AgentLlmConfig | undefined,
  globalConfig: LlmConfig,
  modelId?: string,
): ResolvedLlmConfig {
  return homeLoopOrFallback(
    mergeAgentLlm(agentConfig, globalConfig),
    resolveAgentLlmConfig(agentConfig, globalConfig, modelId),
  );
}
