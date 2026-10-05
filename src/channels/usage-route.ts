import type { MyClawConfig } from "../core/config.ts";
import { UNKNOWN_PROVIDER } from "../analytics/usage-stats.ts";
import { cachedOpenRouterProviderName } from "../llm/openrouter-endpoints.ts";

/**
 * Where a recorded call went, read off the row alone.
 *
 * Shared by the per-conversation report and the install-wide statistics page: the two show the
 * same rows grouped differently, and a route named one way on one screen and another way on the
 * next is two screens disagreeing about the same call.
 */

/**
 * The host a base URL reaches, or the string itself when it is not a URL at all: the SDK and
 * subscription transports record a bare name (`claude-sdk`), which is already the clearest label
 * there is for them.
 */
export function providerHost(baseUrl: string): string {
  const match = /^https?:\/\/([^/]+)/.exec(baseUrl);
  return match ? match[1]!.replace(/^www\./, "") : baseUrl;
}

export interface UsageRoute {
  provider: string;
  variant?: string;
  providerName?: string;
}

/**
 * Where a call went, and which variant of the route it was served as.
 *
 * The model reference carries the endpoint pin (`z-ai/glm-5.2@streamlake/fp8`), and for OpenRouter
 * that pin is the only place the upstream provider exists: `upstream_api_base` is filled in by the
 * resellers that proxy, and OpenRouter leaves it empty. The pin's first segment is therefore the
 * provider and the rest is the variant, which is why `fp8` and `flex` -- a quantization and a
 * service tier -- must never be read as part of a model name.
 *
 * A row without a pin falls back to the base it reached, which is the only thing left that tells
 * two calls of the same model apart (the same id on `api.anthropic.com` and through `claude-sdk`
 * is two providers, two rates, and two rows).
 *
 * `providerName` is how OpenRouter spells that first segment, and it is decoration: the tag stays
 * in `provider`, which is the key everything else groups and merges on. Read from the cache alone,
 * so a cold catalogue drops the decoration instead of making the report wait on a lookup.
 */
export function routeOf(model: string, baseUrl: string): UsageRoute {
  const at = model.lastIndexOf("@");
  const [head, ...rest] = at > 0 ? model.slice(at + 1).split("/").filter(Boolean) : [];
  if (!head) return { provider: providerHost(baseUrl) };
  const name = cachedOpenRouterProviderName(head);
  return {
    provider: head,
    ...(rest.length > 0 ? { variant: rest.join("/") } : {}),
    ...(name === undefined ? {} : { providerName: name }),
  };
}

/** How a provider key reads on a report: the name the owner gave it, the key, or what became of it. */
export type ProviderLabel = (key: string | null) => string;

export function providerLabels(config: MyClawConfig): ProviderLabel {
  const providers = config.llm.providers ?? {};
  return (key) => {
    if (key === null || key === UNKNOWN_PROVIDER) return UNKNOWN_PROVIDER;
    const provider = providers[key];
    // A provider removed since keeps its spend under its key, said to be gone rather than renamed.
    if (!provider) return `${key} (removed)`;
    return provider.group || key;
  };
}
