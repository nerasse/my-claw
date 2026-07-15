# Model discovery

## Why

Hand-maintaining the Claude model ids in `config.llm.models` drifts: the subscription's
available models change, and pinned wire ids (`claude-opus-4-8`) go stale. Discovery pulls the
live list from the source of truth so `/model` always reflects what the account can actually run.

## Decisions

- **Two sources, one merge.** A provider opts in with `discover: true`:
  - `type: "claude-sdk"` → the SDK `Query.supportedModels()` control call (subscription OAuth via
    the same `CLAUDE_CONFIG_DIR` the run backend uses). Returns `{value, displayName,
    resolvedModel, supportedEffortLevels}` — no token cost, the throwaway query is aborted before
    any model turn runs.
  - OpenAI-compatible → `GET {baseUrl}/models` (bearer from `apiKeyEnv`). Standard endpoint,
    works with LiteLLM.
- **Config wins.** Discovered models merge into `config.llm.models`; on an id collision the
  curated config entry is kept, so the owner can override a discovered model's label / group /
  limit / vision by declaring the same id. Everything downstream (resolver backend routing,
  dispatcher, picker) already reads `config.llm.models`, so the merge writes there.
- **Grouping.** Each provider's discovered models land under its `group` label (a submenu entry
  in `/model`). Claude models are flagged `vision: true` (multimodal); the redundant `default`
  alias is dropped.
- **Resilient.** Discovery runs at boot (non-blocking), every 6h, and after any `llm` config
  hot-reload. Results are cached to `~/.my-claw/model-catalog.json` and loaded synchronously at
  startup, so the menu and model routing survive a restart while offline. A provider that fails
  to answer keeps its previously discovered models — the menu never breaks.

## Scope and limits

- The Claude SDK exposes family aliases (`sonnet`, `opus`, `haiku`), not multiple pinned versions
  per family — discovery lists one entry per family. Pin a specific wire id in `config.models` if
  you need it.
- LiteLLM `/v1/models` can return many entries (e.g. quantization variants); they sit under the
  provider's submenu group, not the root.

## Where

- `src/llm/catalog.ts` — `ModelCatalog` (merge, cache, refresh, resilience) + `mergeModels`.
- `src/agent/claude-sdk/models.ts` — `discoverSdkModels` (injected so the llm layer never imports
  the agent backend).
- `src/index.ts` — wires the catalog, re-merges into `config.llm.models`, boot + interval refresh.
- `src/core/config-watcher.ts` — `ctx.syncModels` re-merges after an `llm` edit.
- Config: `LlmProviderConfig.discover` + `group` (see `docs/config.md`).
