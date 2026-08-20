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
  /**
   * The output ceiling of this endpoint. Shown because it is the limit that actually refuses a
   * request: the context figure is the input side, and a menu that displays only the input reads
   * as if a 1M-context route accepts a 1M-token answer.
   */
  maxOutput?: number;
  /** Degraded or down on the provider's own health flag: worth showing, not worth hiding. */
  degraded?: boolean;
  uptime30m?: number;
}

/**
 * How a route list is ordered. Price is the default because pinning is usually a price decision;
 * the others exist because the cheapest route is regularly not the one worth having.
 */
export type RouteSort = "price" | "context" | "output" | "uptime";

export const ROUTE_SORTS: readonly RouteSort[] = ["price", "context", "output", "uptime"];

export const ROUTE_SORT_LABELS: Record<RouteSort, string> = {
  price: "Prix",
  context: "Contexte",
  output: "Sortie",
  uptime: "Uptime",
};

/**
 * Order a route list. A route missing the figure being sorted on sinks to the bottom instead of
 * sorting as zero, which would present "unknown" as "worst" and, on price, as "free".
 */
export function sortRoutes(routes: readonly RouteOption[], sort: RouteSort): RouteOption[] {
  const key = (route: RouteOption): number | undefined =>
    sort === "price" ? route.promptUsd
    : sort === "context" ? route.context
    : sort === "output" ? route.maxOutput
    : route.uptime30m;
  // Price ascends (cheapest first); every other figure is better when larger.
  const ascending = sort === "price";
  return [...routes].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    return ascending ? a - b : b - a;
  });
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
    ...(endpoint.maxOutput === undefined ? {} : { maxOutput: endpoint.maxOutput }),
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

/**
 * Tokens as a menu reads them: 384000 is "384k", 1024000 and 1048576 are both "1M".
 * Rounded first, then tested for a whole number, so 1048576 does not read "1.0M".
 */
function shortTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

/** One button label: the provider, then what pinning it costs. Menus are one line per route. */
export function routeLabel(route: RouteOption): string {
  const parts = [route.providerName];
  if (route.promptUsd !== undefined) {
    parts.push(route.promptUsd >= 1 ? `$${route.promptUsd.toFixed(2)}` : `$${route.promptUsd.toFixed(3)}`);
  }
  // Both sides of the window, because only showing the input hides the ceiling that refuses a call.
  if (route.context !== undefined) {
    parts.push(route.maxOutput === undefined
      ? shortTokens(route.context)
      : `${shortTokens(route.context)}/${shortTokens(route.maxOutput)}`);
  }
  if (route.degraded) parts.push("(degraded)");
  return parts.join(" ");
}
