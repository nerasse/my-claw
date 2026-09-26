# Prompt Caching

Cache the stable prompt prefix on the OpenAI-compatible home loop so per-token proxies that
support Anthropic-style `cache_control` (LiteLLM, OpenRouter) bill the big system+tools prefix at
the cached rate instead of full price on every tool-calling iteration.

## Why (and where it applies)

In a tool-calling run the system prompt (core directives + SOUL/AGENTS/USER + skills list + tool
list) is re-sent on **every** iteration. It is built **once per run** (`bridge.ts`, before the
loop), so it is byte-identical across all iterations of that run — an ideal cache target.

Scope is deliberately narrow:

- **OpenAI-compatible home loop only** for the `cache_control` breakpoints. The resolver never
  sets `promptCache` on the subscription backends: the Anthropic transport marks its own
  breakpoints, and Codex has no `cache_control` to translate into.

  This once read "caching there is a no-op for us" because subscription auth is not billed per
  token. That was wrong, and measurably so: a subscription quota is consumed in **tokens**, cached
  or not. A cache miss on a subscription costs quota instead of money, which is why an August run
  at 11.6% cache-read drained a Claude quota in an afternoon.
- **Per-token proxies that honor `cache_control`.** Verified live: LiteLLM returns HTTP 200 with
  the field (and exposes `prompt_tokens_details`); OpenRouter accepts it. Endpoints that don't
  cache simply ignore the extra field.

It is **opt-in per provider** (`promptCache: true`) because a few strict OpenAI endpoints reject
unknown fields inside message content — so we never send it unless the owner declares support.

## How it works

`applyPromptCache()` in `src/llm/provider.ts` (called from `buildRequestBody` only when
`config.promptCache` is set) adds two `cache_control: { type: "ephemeral" }` breakpoints — well
under Anthropic's max of 4:

1. **The system message** — the large stable prefix, constant across a run's iterations.
2. **The last message** — so the growing conversation (tool results, assistant turns) is cached
   incrementally as the run progresses.

`cache_control` attaches to a content *part*, so a string body is promoted to a single text part
(`"SYS"` → `[{ "type": "text", "text": "SYS", "cache_control": { "type": "ephemeral" } }]`); array
content (vision) gets the marker on its last part. Role-specific fields (`tool_call_id`,
`tool_calls`) are preserved. An empty-string body is left untouched (no block to cache).

## Config

```json
"providers": {
  "litellm":    { "baseUrl": "https://litellm.example/v1", "apiKeyEnv": "LITELLM_API_KEY", "promptCache": true },
  "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY", "promptCache": true }
}
```

The actual token discount depends on the underlying model: Anthropic/Gemini models behind these
proxies honor the breakpoints (cache reads ~10% of input price); OpenAI models cache automatically
and ignore the field. Either way the request stays valid.

## Notes / limits

- The breakpoints are only useful when the cached prefix is byte-stable. The system prompt's
  trailing runtime line carries a timestamp, but it is fixed for the whole run (built once), so it
  does not bust intra-run caching. Cross-run reuse (within the ~5 min TTL) is a bonus, not relied on.
- Tools are a top-level field in the OpenAI schema, not a message; whether they are cached is up to
  the proxy's mapping. We cache them implicitly via the system-message breakpoint where the proxy
  supports it.
- Tested in `tests/llm/prompt-cache.test.ts` (breakpoint placement, string→part promotion, array
  last-part, empty-body skip, on/off request-body gating, resolver propagation).

## The dialect follows the engine, not the provider

`cache_control` is Anthropic's mechanism. OpenAI ignores it and keys its implicit prefix cache on
a `prompt_cache_key` instead. Since the same engine is resold by several providers, the mechanism
that works cannot be read off the provider entry: `gpt-5.6-luna` arrives through the ChatGPT
subscription, OpenRouter and OpenCode Zen, and `claude-sonnet-5` through the Anthropic
subscription, OpenRouter and CommandCode.

`src/llm/cache-policy.ts` derives the dialect from the wire id (`apiModel ?? model`), reduced to
its leaf so a provider path and an `@endpoint` pin cannot confuse it:

| Dialect | Matched by | Treatment |
|---|---|---|
| `anthropic` | `claude`, `opus`, `sonnet`, `haiku` | `cache_control` breakpoints (unchanged) |
| `openai` | `gpt`, `chatgpt`, `codex`, `o1`-`o4` | `prompt_cache_key` |
| `implicit` | everything else | no hint; the engine caches its prefix on its own |

`gpt-oss` is explicitly excluded from the OpenAI dialect: it carries the name but is open weights
hosted by third parties, so it reaches none of OpenAI's cache infrastructure.

Unrecognized is `implicit` by design. Sending no hint costs a little; sending the wrong one can
cost a rejected request.

## `prompt_cache_key`

The key names the conversation, so the transport needs something the LLM layer never had: nothing
below the bridge knows about sessions. `ResolvedLlmConfig.cacheKey` carries it, set by the caller
that owns the conversation (`bridge.ts`, from `session.id`) rather than by the resolver, because it
identifies the run and not the model. A sub-agent uses its own id on purpose: it has its own
system prompt, so sharing the parent's key would point two different prefixes at one cache entry.

Two places consume it:

- **Codex** (`codex.ts`) always sends it. It is OpenAI's own API and the request sets `store: false`,
  so nothing is kept server-side and without a key each iteration may land on a different cache
  node. Measured before the key: 19-35% cache-read, against 94% on the Anthropic transport.
- **OpenAI-compatible** (`provider.ts`) sends it only for the `openai` dialect, and only when the
  provider opted into `promptCache` — that opt-in is precisely the owner stating the endpoint
  tolerates cache hint fields.

The `openai` dialect is the only one that gets the key, and `anthropic` the only one that gets the
breakpoints: the two spellings are mutually exclusive and each is meaningless to an engine that
does not speak it. The `implicit` dialects -- DeepSeek, GLM, Kimi, MiMo, Qwen -- are sent neither,
which `tests/analytics/e2e-usage.test.ts` guards on the highest-volume path in production.

## When the endpoint refuses the shape

A cache breakpoint lives on a content *part*, so `markCacheBreakpoint` promotes a message's content
from a string to `[{type:"text", text, cache_control}]`. Some upstreams validate that shape strictly
and answer 400 to the whole request:

```
LLM stream request failed: HTTP 400 — Error from provider (Console Go):
Upstream request failed: [invalid_request_error] 4 request validation errors:
Input should be a valid string, field: 'messages[0].content.str', value: [{'type': 'text', ...
```

Measured 2026-09-21, on `opencode_go/glm-5.3` — while the *same provider's* deepseek models take the
identical request. The prompt was fine; the form our hints chose was not.

One refusal was all this transport used to handle, in code written where the call is made. It is now
one row of a table, `plain-content`, in `src/llm/request-repair.ts`, beside two others that cost a
run twenty-nine minutes on 2026-09-26. The rebuild, the single replay and the per-endpoint memo all
still happen; what changed is that they are data, and that a refusal naming a parameter is answered
rather than thrown. See `docs/llm-request-repair.md`.

## Auditing it

`api_calls` records `backend` and `cache_dialect` per call. Neither is derivable after the fact:
a couple of hosts name a transport (`chatgpt.com/backend-api`) while every other one names a
reseller that could be fronting any engine. An audit that grouped by base URL once concluded the
opposite of the truth, which is why the columns exist.

```sql
SELECT backend, cache_dialect, model,
       COUNT(*) AS calls,
       ROUND(100.0 * SUM(cache_read_tokens) / NULLIF(SUM(prompt_tokens), 0), 1) AS hit_pct
FROM api_calls
WHERE timestamp > datetime('now', '-7 days')
GROUP BY backend, cache_dialect, model
ORDER BY SUM(prompt_tokens) DESC;
```
