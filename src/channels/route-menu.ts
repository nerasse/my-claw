import type { MyClawConfig } from "../core/config.ts";
import { isOpenRouterBaseUrl } from "../llm/resolver.ts";
import { formatModelRef, withoutEndpoint } from "../llm/model-ref.ts";
import { openRouterEndpoints } from "../llm/openrouter-endpoints.ts";
import { tryResolveRunModel } from "../llm/run-model.ts";
import { availabilityWorld } from "../llm/world.ts";

/**
 * The route step of the `/model` flow: which provider serves this model, when more than one can.
 *
 * Shared by both channels and by the app controller for the same reason `context-menu.ts` is
 * shared: three surfaces offering three different route lists for one model is how a menu comes
 * to pin something the run does not honour. See docs/model-identity.md.
 */

export interface RouteOption {
  /** The endpoint tag, which is what a pin carries ("azure/eu", "openai/flex"). */
  tag: string;
  /** The provider behind the route, spelled the way its own catalogue spells it. */
  providerName: string;
  promptUsd?: number;
  completionUsd?: number;
  context?: number;
  /** Degraded or down on the provider's own health flag: worth showing, not worth hiding. */
  degraded?: boolean;
  uptime30m?: number;
}

export interface RouteChoice {
  /** False when the model has a single route: a menu entry there would open on nothing. */
  available: boolean;
  /** The route in force, absent when the model routes automatically. */
  current?: string;
}

/**
 * Whether this reference can be pinned at all, and to what it is pinned right now.
 *
 * Answered from the resolved provider rather than from the id: only OpenRouter understands a
 * route, and it is recognised by host, never by the key it was given in the config.
 */
export function routeChoiceFor(config: MyClawConfig, modelId: string): RouteChoice {
  const resolved = tryResolveRunModel(config, { agent: "main", forcedModel: modelId }, availabilityWorld());
  if (!resolved || !isOpenRouterBaseUrl(resolved.baseUrl)) return { available: false };
  return { available: true, ...(resolved.providerRoute ? { current: resolved.providerRoute } : {}) };
}

/**
 * The routes of a model, cheapest first. Empty for anything OpenRouter does not serve, and empty
 * when the call fails: a menu that cannot list the routes offers automatic routing, which is what
 * the run does anyway.
 */
export async function routesFor(config: MyClawConfig, modelId: string): Promise<RouteOption[]> {
  const resolved = tryResolveRunModel(config, { agent: "main", forcedModel: modelId }, availabilityWorld());
  if (!resolved || !isOpenRouterBaseUrl(resolved.baseUrl)) return [];
  const endpoints = await openRouterEndpoints(resolved.apiModel ?? resolved.model);
  return endpoints.map((endpoint) => ({
    tag: endpoint.tag,
    providerName: endpoint.providerName,
    ...(endpoint.promptUsd === undefined ? {} : { promptUsd: endpoint.promptUsd }),
    ...(endpoint.completionUsd === undefined ? {} : { completionUsd: endpoint.completionUsd }),
    ...(endpoint.contextLength === undefined ? {} : { context: endpoint.contextLength }),
    ...(endpoint.status !== undefined && endpoint.status < 0 ? { degraded: true } : {}),
    ...(endpoint.uptime30m === undefined ? {} : { uptime30m: endpoint.uptime30m }),
  }));
}

/** The reference to store for a route: the same model, pinned, or unpinned for automatic. */
export function referenceWithRoute(modelId: string, endpoint?: string): string {
  const bare = withoutEndpoint(modelId);
  // The provider half already sits inside `bare`, whatever it is: only the pin is being added.
  return endpoint ? formatModelRef({ apiId: bare, endpoint }) : bare;
}

/** One button label: the provider, then what pinning it costs. Menus are one line per route. */
export function routeLabel(route: RouteOption): string {
  const parts = [route.providerName];
  if (route.promptUsd !== undefined) {
    parts.push(route.promptUsd >= 1 ? `$${route.promptUsd.toFixed(2)}` : `$${route.promptUsd.toFixed(3)}`);
  }
  if (route.degraded) parts.push("(degraded)");
  return parts.join(" ");
}
