# Prompt Caching

Cache the stable prompt prefix on the OpenAI-compatible home loop so per-token proxies that
support Anthropic-style `cache_control` (LiteLLM, OpenRouter) bill the big system+tools prefix at
the cached rate instead of full price on every tool-calling iteration.

## Why (and where it applies)

In a tool-calling run the system prompt (core directives + SOUL/AGENTS/USER + skills list + tool
list) is re-sent on **every** iteration. It is built **once per run** (`bridge.ts`, before the
loop), so it is byte-identical across all iterations of that run — an ideal cache target.

Scope is deliberately narrow:

- **OpenAI-compatible home loop only.** `claude-sdk` runs cache through the Claude SDK itself, and
  both `claude-sdk` and `codex` are subscription auth (not billed per token) — caching there is a
  no-op for us. The resolver never sets `promptCache` on those backends.
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
