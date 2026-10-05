# Model discovery

> **Note historique** : ce document a été écrit quand my-claw servait aussi Telegram et Matrix.
> Ces deux canaux ont été supprimés (seul `my-claw-app` subsiste). Les mentions et chemins de
> fichiers `channels/telegram/*` et `channels/matrix/*` ci-dessous sont conservés pour la trace
> de la décision : ils ne décrivent plus le code.

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
- **One reference per provider.** A discovered model is addressed as `<provider>/<id>` and keeps
  the provider's own id in `apiId` for the wire. Two providers serving the same name are two
  entries, on purpose: the price, the window and the data policy differ. See
  docs/model-identity.md.
- **Config wins.** Discovered models merge into `config.llm.models`; on a collision of the
  reference the curated config entry is kept, so the owner can override a discovered model's
  label / group / limit / vision by declaring the same id. Everything downstream (resolver backend routing,
  dispatcher, picker) already reads `config.llm.models`, so the merge writes there.
- **Grouping.** Each provider's discovered models land under its `group` label (a submenu entry
  in `/model`). The redundant Claude `default` alias is dropped.
- **One submenu per family, alias included.** Every Claude model goes to
  `Claude SDK (abo)/<Family>`, the family coming from the API display name (`Claude Opus 4.8` ->
  family `Opus`, label `Opus 4.8`), so no family list is hardcoded. The moving alias joins its own
  family as `Opus (auto)` and is listed first: side by side with the family it read as the same
  entry twice (`Opus` and `Opus >`) and picking it silently skipped the version choice. An alias
  the versioned list does not cover stays at the provider root under its plain name. The picker
  already supports arbitrarily nested `a/b` group paths, so this needed no picker change.
- **Effort is per model, from the provider.** Levels come from the model's own capabilities, never
  from a global assumption: Opus 4.6 has no `xhigh`, Opus 4.5 stops at `high`, and Haiku 4.5,
  Sonnet 4.5 and Opus 4.1 have none at all. `supportsEffort: false` is a definite fact and yields
  an empty level list, distinct from `undefined` ("unknown"), which falls back to the global set.
- **Resilient.** Discovery runs at boot (non-blocking), every 6h, and after any `llm` config
  hot-reload. Results are cached to `~/.my-claw/model-catalog.json` and loaded synchronously at
  startup, so the menu and model routing survive a restart while offline. A provider that fails
  to answer keeps its previously discovered models — the menu never breaks.

## A pass requested during a pass, and what a failure says (2026-10-05)

- `refresh()` never runs two passes at once, but a call that lands during one gets one more pass
  after it, shared by every such call. Joining the running pass was wrong: the app declares a new
  provider (a pass starts) and writes its key a frame later; the running pass reached the provider
  before its key existed, answered 401, and nothing asked again for six hours.
- The reason of a provider's last failed pass is kept (`failures`, cleared by its next complete
  answer) and read by `discovery(provider)`: `pending` until a pass has reached it, `ok`, or
  `failed` with the status or the network fault, never a response body (an error page can quote
  the key). The app's `agents.config` snapshot carries it per provider (`discovery`), and the
  server pushes that snapshot and the model list after every pass, so the page of a provider just
  added moves from "asking" to its models or to the reason it has none.

## Scope and limits

- The Claude SDK control call exposes only family aliases (`sonnet`, `opus`, `haiku`); the
  versioned ids come from `/v1/models`. Losing that endpoint degrades to aliases plus the last
  known versions rather than dropping the provider.
- `ultra` exists on Codex only (`gpt-5.6-sol`, `gpt-5.6-terra`). The Claude SDK caps at `max`, so
  an `ultra` session effort is clamped to `max` with a warning when the run lands on Claude; the
  rungs below its ladder (`minimal`, `none`) clamp to `low` the same way.
- An OpenAI-compatible provider answers `/v1/models` with ids and nothing else, so its capabilities
  are filled in from the models.dev catalogue we already download for prices — reasoning ladder,
  display name, vision, output limit. Gap-filling only: a provider that describes its own models
  always wins. See `docs/model-metadata.md`.
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
