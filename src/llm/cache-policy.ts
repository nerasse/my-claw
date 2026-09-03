/**
 * Which prompt-cache dialect a model speaks.
 *
 * Keyed on the model family, never on the provider entry it was reached through. The same engine
 * is resold by several providers -- `gpt-5.6-luna` arrives through the ChatGPT subscription,
 * OpenRouter and OpenCode Zen; `claude-sonnet-5` through the Anthropic subscription, OpenRouter
 * and CommandCode -- and the hint that actually caches is a property of the engine on the far end.
 * OpenAI ignores `cache_control` and keys its implicit prefix cache on `prompt_cache_key`;
 * Anthropic is the exact reverse. A per-provider flag cannot express that, which is why the
 * dialect is derived from the wire id.
 */
export type CacheDialect = "anthropic" | "openai" | "implicit";

const ANTHROPIC_FAMILY = /(^|[/\-_])(claude|opus|sonnet|haiku)([-._]|$)/;
const OPENAI_FAMILY = /(^|[/\-_])(gpt|chatgpt|codex|o[1-4])([-._]|$)/;

/**
 * `gpt-oss` carries the OpenAI name but is open weights hosted by third parties (Groq, OpenRouter),
 * so it reaches none of OpenAI's cache infrastructure. Handing it an OpenAI-only field would be a
 * request that means nothing at best and is rejected at worst.
 */
const OPENAI_IMPOSTORS = /gpt-oss/;

/**
 * The dialect for a wire model id (`config.apiModel ?? config.model`).
 *
 * The id is reduced to its leaf first: a reference carries its provider path and may carry an
 * endpoint pin (`openrouter/openai/gpt-5.6-luna@azure/eu`), and neither says anything about the
 * engine. Anything unrecognized is `implicit`, the safe answer: every major engine caches its
 * prefix automatically, so sending no hint costs a little while sending the wrong one can cost a
 * rejected request.
 */
export function cacheDialectOf(wireId: string | undefined): CacheDialect {
  if (!wireId) return "implicit";
  const id = wireId.split("@")[0]!.toLowerCase();
  const leaf = id.slice(id.lastIndexOf("/") + 1);
  if (ANTHROPIC_FAMILY.test(leaf)) return "anthropic";
  if (OPENAI_IMPOSTORS.test(leaf)) return "implicit";
  if (OPENAI_FAMILY.test(leaf)) return "openai";
  return "implicit";
}

/**
 * What an analytics row should say about the cache treatment a call received.
 *
 * Recorded at the call site rather than reconstructed later: the base URL names a reseller and not
 * a transport, so a row read months afterwards cannot tell which dialect was spoken.
 */
export function cacheAttributionOf(config: { backend?: string; model: string; apiModel?: string }): {
  backend: string;
  cacheDialect: CacheDialect;
} {
  return {
    backend: config.backend ?? "openai",
    cacheDialect: cacheDialectOf(config.apiModel ?? config.model),
  };
}
