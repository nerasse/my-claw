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

import { resolveAgentLlm, tagNameOf, tagRouteOf, type EffortLevel, type MyClawConfig, type ResolvedLlmConfig } from "../core/config.ts";
import { resolveLlmConfigForAgentMessage } from "./resolver.ts";
import { directRouteOf, type RunModelRoute } from "./run-model.ts";

export interface ProviderFallbackTarget {
  /** The model id the run moves to, for the note and the log. */
  model: string;
  /** What to run it with. */
  config: ResolvedLlmConfig;
  /** Where the target comes from, in the owner's terms: a route candidate, a default. */
  label: string;
  /**
   * Whether this target is an entry of the route the run is on -- the tag the owner picked or
   * pinned, candidates and its own global-default step. A conversation that asked to wait out its
   * wall still moves along that list: the route is the model, in order, and waiting is for when
   * nothing in it is left (docs/quota-retry.md). Everything else here is a sibling the switch
   * refuses.
   */
  fromRoute: boolean;
}

export interface ProviderFallbackRequest {
  config: MyClawConfig;
  /** The agent the run belongs to ("main", "cron", a sub-agent's kind). */
  agent: string;
  route?: RunModelRoute;
  /**
   * What the conversation picked, as stored: `tag:<name>` when it picked a tag.
   *
   * The run does not always arrive here carrying its route. The dispatcher hands the bridge the
   * concrete winner as a forced model, and a sub-agent runs on a resolved config, so both lose
   * `RunModel.route` -- and a run whose route is unknown walked the *agent's* default instead of its
   * own tag. Measured 2026-10-27: a chat pinned on a two-account tag fell out of the route on the
   * first account's spent quota and answered on `Medium`'s first candidate, while the tag's own
   * second account answered fine ninety seconds later.
   */
  tagRef?: string;
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
  /**
   * `fromRoute` is the run's own route, the one the owner wrote and this run is on -- never the
   * agent's pin: a run that left that pin on purpose (a spawn `model`) must not be walked back onto
   * it behind the owner's back.
   */
  const walk = (walked: RunModelRoute, fromRoute: boolean): ProviderFallbackTarget[] => {
    walked.candidates.forEach((candidate, index) => {
      if (index === walked.selectedIndex) return;
      if (walked.unavailableIndices?.includes(index)) return;
      if (attempted.has(candidate.model)) return;
      const resolved = candidateConfig(candidate.model, candidate.effort);
      if (!resolved || attempted.has(resolved.model) || isCurrent(resolved)) return;
      targets.push({ model: candidate.model, config: resolved, label: `${walked.tag} route candidate ${index + 1}`, fromRoute });
    });
    if (walked.fallbackToGlobalDefault) {
      const global = resolveLlmConfigForAgentMessage(config.llm, undefined, undefined, hasImages);
      if (!attempted.has(global.model) && !isCurrent(global) && !targets.some((t) => t.model === global.model)) {
        targets.push({ model: global.model, config: global, label: `${walked.tag} global default`, fromRoute });
      }
    }
    return targets;
  };

  if (route) return walk(route, true);

  // The conversation's own tag still names the chain when the resolved route did not travel with
  // the run. Only when the run is *on* one of its candidates: a tag that the preflight fell through
  // to the global default has already been judged unavailable, and walking it would retry a model
  // the resolver refused rather than continue past it.
  const ownRoute = routeOfTagRef(config, request.tagRef, request.current.model);
  if (ownRoute) return walk(ownRoute, true);

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
  if (agentRoute) return walk({ ...agentRoute, selectedIndex: -1 }, false);

  const agentDefault = resolveLlmConfigForAgentMessage(config.llm, resolveAgentLlm(config, request.agent), undefined, hasImages);
  if (agentDefault.provider === request.current.provider || agentDefault.model === request.current.model) return targets;
  if (attempted.has(agentDefault.model)) return targets;
  targets.push({ model: agentDefault.model, config: agentDefault, label: "configured default", fromRoute: false });
  return targets;
}

/**
 * The route a stored `tag:<name>` pick names, with the candidate the run is on as its selection.
 *
 * `undefined` when there is nothing to walk without inventing one: no tag pick, a tag that no longer
 * exists, or a run whose current model is not one of that tag's candidates (it already left the
 * route, so the route is not the answer).
 */
function routeOfTagRef(
  config: MyClawConfig,
  tagRef: string | undefined,
  currentModel: string,
): RunModelRoute | undefined {
  const name = tagRef === undefined ? undefined : tagNameOf(tagRef);
  if (name === undefined || name === "Default") return undefined;
  const tag = (config.tags ?? config.llm.tags)?.[name];
  const candidates = tagRouteOf(tag);
  if (candidates.length === 0) return undefined;
  // A nested tag would need a second expansion nobody resolved for this run.
  if (candidates.some((candidate) => tagNameOf(candidate.model) !== undefined)) return undefined;
  const selectedIndex = candidates.findIndex((candidate) => candidate.model === currentModel);
  if (selectedIndex < 0) return undefined;
  return {
    tag: name,
    candidates,
    fallbackToGlobalDefault: tag?.fallbackToGlobalDefault === true,
    selectedIndex,
  };
}
