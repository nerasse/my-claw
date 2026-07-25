# Model discovery

## Why

Hand-maintaining the Claude model ids in `config.llm.models` drifts: the subscription's
available models change, and pinned wire ids (`claude-opus-4-8`) go stale. Discovery pulls the
live list from the source of truth so `/model` always reflects what the account can actually run.

## Decisions

- **Two sources, one merge.** A provider opts in with `discover: true`:
  - `type: "claude-sdk"` → **two endpoints**. The SDK `Query.supportedModels()` control call
    (subscription OAuth via the same `CLAUDE_CONFIG_DIR` the run backend uses) returns the moving
    family aliases `{value, displayName, resolvedModel, supportedEffortLevels}` — no token cost,
    the throwaway query is aborted before any model turn runs. `GET /v1/models` on
    `api.anthropic.com` then returns the **versioned** ids the aliases hide. The subscription
    OAuth token is accepted there, so no separate paid API key is needed; without a token the
    aliases still work on their own.
  - OpenAI-compatible → `GET {baseUrl}/models` (bearer from `apiKeyEnv`). Standard endpoint,
    works with LiteLLM.
  - `type: "codex"` → `GET {baseUrl}/codex/models` on the ChatGPT subscription (bearer + account
    id from the stored OAuth token; requires a prior `codex login`). Best-effort: before login or
    on failure the curated/last-known set is kept. See `docs/codex-backend.md`.
- **Config wins.** Discovered models merge into `config.llm.models`; on an id collision the
  curated config entry is kept, so the owner can override a discovered model's label / group /
  limit / vision by declaring the same id. Everything downstream (resolver backend routing,
  dispatcher, picker) already reads `config.llm.models`, so the merge writes there.
- **Grouping.** Each provider's discovered models land under its `group` label (a submenu entry
  in `/model`). The redundant Claude `default` alias is dropped.
- **Aliases at the root, versions in family submenus.** Claude aliases keep the provider group
  (`Claude (abo)`) so picking `Sonnet` still tracks the latest, while each versioned model goes to
  `Claude (abo)/<Family>` — the family comes from the API display name (`Claude Opus 4.8` ->
  family `Opus`, label `Opus 4.8`), so no family list is hardcoded. The picker already supports
  arbitrarily nested `a/b` group paths, so this needed no picker change.
- **Effort is per model, from the provider.** Levels come from the model's own capabilities, never
  from a global assumption: Opus 4.6 has no `xhigh`, Opus 4.5 stops at `high`, and Haiku 4.5,
  Sonnet 4.5 and Opus 4.1 have none at all. `supportsEffort: false` is a definite fact and yields
  an empty level list, distinct from `undefined` ("unknown"), which falls back to the global set.
- **Resilient.** Discovery runs at boot (non-blocking), every 6h, and after any `llm` config
  hot-reload. Results are cached to `~/.my-claw/model-catalog.json` and loaded synchronously at
  startup, so the menu and model routing survive a restart while offline. A provider that fails
  to answer keeps its previously discovered models — the menu never breaks.

## Scope and limits

- The Claude SDK control call exposes only family aliases (`sonnet`, `opus`, `haiku`); the
  versioned ids come from `/v1/models`. Losing that endpoint degrades to aliases plus the last
  known versions rather than dropping the provider.
- `ultra` exists on Codex only (`gpt-5.6-sol`, `gpt-5.6-terra`). The Claude SDK caps at `max`, so
  an `ultra` session effort is clamped to `max` with a warning when the run lands on Claude.
- Menu callbacks carry a fixed-width digest of the model id (`mdl:<ref>`), not a list position, so
  a menu left open across a discovery refresh still designates the model it displayed. A ref that
  no longer resolves reports the menu as out of date instead of selecting a neighbour. The digest
  also keeps callbacks inside Telegram's 64-byte `callback_data` budget, which a provider-supplied
  id is not guaranteed to respect.
- LiteLLM `/v1/models` can return many entries (e.g. quantization variants); they sit under the
  provider's submenu group, not the root.

## Where

- `src/llm/catalog.ts` — `ModelCatalog` (merge, cache, refresh, resilience) + `mergeModels`.
- `src/llm/anthropic-models.ts` — `fetchAnthropicModels` + display-name/family split + per-model
  effort levels.
- `src/agent/claude-sdk/models.ts` — `discoverSdkModels` (injected so the llm layer never imports
  the agent backend).
- `src/index.ts` — wires the catalog, re-merges into `config.llm.models`, boot + interval refresh.
- `src/core/config-watcher.ts` — `ctx.syncModels` re-merges after an `llm` edit.
- Config: `LlmProviderConfig.discover` + `group` (see `docs/config.md`).
