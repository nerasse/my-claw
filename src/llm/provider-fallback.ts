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
import type { RunModelRoute } from "./run-model.ts";

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

  if (route) {
    route.candidates.forEach((candidate, index) => {
      if (index === route.selectedIndex) return;
      if (route.unavailableIndices?.includes(index)) return;
      if (attempted.has(candidate.model)) return;
      const resolved = candidateConfig(candidate.model, candidate.effort);
      if (!resolved) return;
      targets.push({ model: candidate.model, config: resolved, label: `${route.tag} route candidate ${index + 1}` });
    });
    if (route.fallbackToGlobalDefault) {
      const global = resolveLlmConfigForAgentMessage(config.llm, undefined, undefined, hasImages);
      if (!attempted.has(global.model)) {
        targets.push({ model: global.model, config: global, label: `${route.tag} global default` });
      }
    }
    return targets;
  }

  const agentDefault = resolveLlmConfigForAgentMessage(config.llm, resolveAgentLlm(config, request.agent), undefined, hasImages);
  if (agentDefault.provider === request.current.provider || agentDefault.model === request.current.model) return targets;
  if (attempted.has(agentDefault.model)) return targets;
  targets.push({ model: agentDefault.model, config: agentDefault, label: "configured default" });
  return targets;
}
