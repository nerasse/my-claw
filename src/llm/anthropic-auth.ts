import type { LlmProviderConfig } from "../core/config.ts";
import { loadClaudeToken } from "./claude-auth.ts";

/**
 * What signs a request to a provider of type `anthropic`.
 *
 * `apiKeyEnv` is kept even when the variable holds nothing, because "declared and unset" and "not
 * declared" must not resolve the same way: the first is a configuration fault to name, the second
 * is the Claude subscription. Folding them together would hand the subscription token to whatever
 * endpoint the provider's `baseUrl` names. See docs/anthropic-backend.md.
 */
export interface AnthropicCredential {
  apiKey?: string;
  apiKeyEnv?: string;
}

/**
 * Deliberately not the resolver's `resolveApiKey`: its last-resort `FIREWORKS_API_KEY` /
 * `OPENAI_API_KEY` fallbacks would give a subscription provider somebody else's key on any box
 * that has one exported, which is the default path this generalization must leave untouched.
 */
export function anthropicCredential(provider: Pick<LlmProviderConfig, "apiKeyEnv">): AnthropicCredential {
  const apiKeyEnv = provider.apiKeyEnv;
  if (!apiKeyEnv) return {};
  const apiKey = process.env[apiKeyEnv];
  return apiKey ? { apiKeyEnv, apiKey } : { apiKeyEnv };
}

/**
 * The one auth header the request carries, or `null` when the subscription has no token yet --
 * the callers disagree on what that means, so neither answer is decided here: a run fails on it
 * while a discovery pass keeps the models it already knew.
 *
 * An API key travels as `x-api-key`, which is what the Messages API documents for one, and the
 * subscription token as a bearer credential. Never both: `x-api-key` beside a bearer token is
 * refused, and it is the invariant the captured client also holds.
 */
export async function anthropicAuthHeaders(
  credential: AnthropicCredential,
  provider?: string,
): Promise<Record<string, string> | null> {
  if (credential.apiKeyEnv) {
    if (!credential.apiKey) {
      const who = provider ? `Provider "${provider}"` : "This Anthropic provider";
      throw new Error(`${who} reads its key from ${credential.apiKeyEnv}, which is not set.`);
    }
    return { "x-api-key": credential.apiKey };
  }
  // The subscription: each Claude provider holds its own sign-in (accounts-store.ts).
  if (!provider) return null;
  const token = await loadClaudeToken(provider);
  return token ? { authorization: `Bearer ${token}` } : null;
}
