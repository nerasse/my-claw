/**
 * Where a run goes when its provider fails, resolved from what the owner already configured.
 *
 * The chain is not a new setting: it is the one they wrote. A `tag:` with a `route` is a list of
 * candidates in order, so the fallback walks what is left of it and then, if the tag says so, the
 * global default. A run that is not on a route falls back to its agent's configured default, and
 * only when it is not already there.
 *
 * Nothing here invents a target: a run already on the default has no fallback, because the target
 * would be the model that just failed.
 */

import { resolveAgentLlm, type MyClawConfig, type ResolvedLlmConfig } from "../core/config.ts";
import { resolveLlmConfigForAgentMessage } from "./resolver.ts";
import type { EffortLevel } from "../core/config.ts";
import { directRouteOf, type RunModelRoute } from "./run-model.ts";

export interface ProviderFallbackTarget {
  /** The model id the run moves to, for the note and the log. */
  model: string;
  /** What to run it with. */
  config: ResolvedLlmConfig;
  /** Where the target comes from, in the owner's terms: a route candidate, a default. */
  label: string;
}

export interface ProviderFallbackRequest {
  config: MyClawConfig;
  /** The agent the run belongs to ("main", "cron", a sub-agent's kind). */
  agent: string;
  route?: RunModelRoute;
  /** The model that just failed. */
  current: { model: string; provider?: string };
  hasImages: boolean;
  /** Models this run already tried, so a chain never comes back to one of them. */
  attempted: ReadonlySet<string>;
}

export function providerFallbackTargets(request: ProviderFallbackRequest): ProviderFallbackTarget[] {
  const { config, route, hasImages } = request;
  const attempted = new Set(request.attempted);
  const targets: ProviderFallbackTarget[] = [];

  // A candidate the resolver refuses is skipped, not fatal: one broken entry in a route must not
  // take the whole chain down with it.
  const candidateConfig = (model: string, effort?: EffortLevel): ResolvedLlmConfig | undefined => {
    try {
      return resolveLlmConfigForAgentMessage(config.llm, undefined, model, hasImages, effort);
    } catch {
      return undefined;
    }
  };

  const isCurrent = (resolved: ResolvedLlmConfig): boolean =>
    resolved.model === request.current.model && (request.current.provider === undefined || resolved.provider === request.current.provider);
  const walk = (walked: RunModelRoute): ProviderFallbackTarget[] => {
    walked.candidates.forEach((candidate, index) => {
      if (index === walked.selectedIndex) return;
      if (walked.unavailableIndices?.includes(index)) return;
      if (attempted.has(candidate.model)) return;
      const resolved = candidateConfig(candidate.model, candidate.effort);
      if (!resolved || attempted.has(resolved.model) || isCurrent(resolved)) return;
      targets.push({ model: candidate.model, config: resolved, label: `${walked.tag} route candidate ${index + 1}` });
    });
    if (walked.fallbackToGlobalDefault) {
      const global = resolveLlmConfigForAgentMessage(config.llm, undefined, undefined, hasImages);
      if (!attempted.has(global.model) && !isCurrent(global) && !targets.some((t) => t.model === global.model)) {
        targets.push({ model: global.model, config: global, label: `${walked.tag} global default` });
      }
    }
    return targets;
  };

  if (route) return walk(route);

  // Off its route -- a model the caller picked, like a spawn's `model` -- a run whose agent default
  // is a tag falls back along that tag's whole route, not only its first candidate: taking the first
  // alone left a volet dead when mimo's quota and then deepseek failed, with opus unused further down
  // the same route (2026-09-29).
  const agentModel = resolveAgentLlm(config, request.agent)?.defaultModel;
  const tagged = config.tags === undefined ? config.llm : { ...config.llm, tags: config.tags };
  let agentRoute: RunModelRoute | undefined;
  try {
    agentRoute = agentModel ? directRouteOf(tagged, agentModel) : undefined;
  } catch {
    agentRoute = undefined;
  }
  if (agentRoute) return walk({ ...agentRoute, selectedIndex: -1 });

  const agentDefault = resolveLlmConfigForAgentMessage(config.llm, resolveAgentLlm(config, request.agent), undefined, hasImages);
  if (agentDefault.provider === request.current.provider || agentDefault.model === request.current.model) return targets;
  if (attempted.has(agentDefault.model)) return targets;
  targets.push({ model: agentDefault.model, config: agentDefault, label: "configured default" });
  return targets;
}
