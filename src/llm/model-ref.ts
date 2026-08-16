/**
 * The one place that knows how a model reference is spelled. See docs/model-identity.md.
 *
 * ```
 * openrouter / openai/gpt-5.6-luna @ azure/eu
 *     |              |                  |
 *     |              |                  endpoint pin, the tag OpenRouter returns per endpoint
 *     |              apiId, what the request carries
 *     provider key in config.llm.providers
 * ```
 *
 * A reference travels as one string because that is what every store already holds: the config
 * default, the tags, a session override, an agent file, a cron job, the analytics `model` column,
 * the picker's callback digest. A parallel field would have to be threaded through all of them
 * and kept in sync; a string is parsed here and nowhere else.
 */

/** Separates the endpoint pin from the model. Chosen because no provider uses it in an id. */
const PIN = "@";

export interface ModelRef {
  /** Set when the reference names a provider explicitly. */
  provider?: string;
  /** The id the provider knows. Never qualified, never pinned. */
  apiId: string;
  /** OpenRouter endpoint tag ("azure/eu", "openai/flex"), when the reference pins one. */
  endpoint?: string;
}

/**
 * Splits a reference into its parts.
 *
 * `providers` is needed because an id can itself contain slashes (`openai/gpt-5.6-luna` on
 * OpenRouter): the first segment is a provider only when a provider by that name exists. An
 * unknown head is therefore part of the id, which is what keeps every reference written before
 * this existed resolving exactly as it did.
 */
export function parseModelRef(ref: string, providers: Iterable<string>): ModelRef {
  const at = ref.lastIndexOf(PIN);
  const endpoint = at > 0 ? ref.slice(at + 1) : undefined;
  const head = at > 0 ? ref.slice(0, at) : ref;

  const slash = head.indexOf("/");
  if (slash > 0) {
    const candidate = head.slice(0, slash);
    for (const name of providers) {
      if (name === candidate) {
        return { provider: candidate, apiId: head.slice(slash + 1), ...(endpoint ? { endpoint } : {}) };
      }
    }
  }
  return { apiId: head, ...(endpoint ? { endpoint } : {}) };
}

/** The reference a set of parts spells. Inverse of `parseModelRef`. */
export function formatModelRef(ref: ModelRef): string {
  const qualified = ref.provider ? `${ref.provider}/${ref.apiId}` : ref.apiId;
  return ref.endpoint ? `${qualified}${PIN}${ref.endpoint}` : qualified;
}

/**
 * The id a usage row is filed under: what the request actually carried, plus the endpoint it was
 * pinned to. A tag resolves away here on purpose (a later tag edit must not rewrite history), but
 * the endpoint stays, because two endpoints of one model are two different bills.
 */
export function usageModelOf(config: { model: string; apiModel?: string; providerRoute?: string }): string {
  const wire = config.apiModel ?? config.model;
  return config.providerRoute ? `${wire}${PIN}${config.providerRoute}` : wire;
}

/** The same reference without its endpoint pin, for the places that address the model itself. */
export function withoutEndpoint(ref: string): string {
  const at = ref.lastIndexOf(PIN);
  return at > 0 ? ref.slice(0, at) : ref;
}

/**
 * The id a display should show: the provider prefix and the pin are addressing, not a name.
 * Deliberately not provider-aware: a label is read, not resolved.
 */
export function bareIdOf(ref: string, providers: Iterable<string>): string {
  return parseModelRef(ref, providers).apiId;
}
