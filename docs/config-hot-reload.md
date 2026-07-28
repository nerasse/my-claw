# Config hot-reload

## Why

`config.json` was read exactly once at boot (`loadConfig`) and the parsed object was passed by
reference everywhere. Changing a model, a limit, an allowlist or a reaction emoji meant restarting the
whole process -- which on Matrix re-inits the E2E crypto session and re-warms embeddings, i.e. a heavy,
disruptive operation for a trivial change.

Hot-reload watches `~/.my-claw/config.json` (and the sibling `.env`, see below) and applies the **safe**
subset of changes in place, with no restart. Fields that genuinely cannot be swapped on a live process
(channel identity/crypto, boot-wired timers) are detected, skipped, and reported as `rebootRequired`.

## The golden rule: mutate in place, never replace the reference

Every consumer holds a reference to the live config object (or a sub-object). The watcher therefore
**mutates the existing objects/arrays in place** (`replaceContents` / `Array.splice`) and never reassigns
a section to a fresh reference. If it replaced `config.llm = {...}`, components that captured
`config.llm` (or a derived value) at boot would keep pointing at the stale object -- divergent state.

Two consumption patterns exist and both are covered:

- **Live reads through the shared root config** (`this.config.llm`, `config.browser?.enabled`, ...):
  picked up automatically on the next use once the contents are mutated.
- **Boot-time snapshots** (ModelPicker's model list, the channel reaction/error managers, the adapter
  whitelist `Set`): these copy values out at construction, so a small setter is called by an *applier*
  after the mutation (`setModels`, `setConfig`, `setMode`, `setWhitelist`, `applyConfigReload`).

## What hot-reloads vs what needs a reboot

Hot-reloadable (applied in place, effective on the next message/call):

- `llm.*` (defaultProvider, defaultModel, providers, limit, vision, models)
- `agents.*` (maxIterations, llm, nested.enabled/maxBytes)
- `injection`, `browser` (enabled/sidecarUrl/maxSteps/...), `webSearch`
- `context` (pruning.enabled/keepLastAssistantTurns/headChars, autoCompact.enabled/thresholdRatio)
- `tools.disabled` (denylist read live per run)
- `mcp` (external MCP servers; the applier reconnects added/changed/removed servers)
- `voice` (read live by VoiceManager, no applier)
- `cron` (`enabled`/`tickIntervalMs` re-arm the tick timer via `reloadCron`)
- `memory` (recall knobs live; an embedding-model change triggers a re-warm + backfill applier)
- `whitelist`, `blacklist`
- Telegram/Matrix **behavioral** fields: dm/group policy + allowFrom, groups, contextVisibility,
  historyLimit, streaming, replyToMode, threadReplies, reactions, errorPolicy, chunking, mediaMaxMb,
  displayName, autoJoin, ...

Recreate (identity applied in place, adapter torn down + rebuilt via a `recreate` applier):

- `channels.telegram`: `token`, `mode`, `webhook`, `enabled` -- `bot.stop()` is clean and a
  sequential swap avoids the Telegram 409; the adapter is rebuilt from a factory and refs
  (cron adapters map, approval handler) are re-pointed. See `docs/hot-reload-extensions.md` (A6b).

Reboot-only (detected, **not** applied, reported in `rebootRequired`):

- `channels.matrix`: `homeserver`, `accessToken`, `userId`, `password`, `deviceId`, `encryption`,
  `initialSyncLimit` -- an in-process recreate is feasible (source: `olmMachine.close()` releases the
  IndexedDB handle on `stopClient()`), but the mechanism is gated on a live-homeserver Megolm test that
  cannot run in CI, so it stays reboot-only for now (see A6). The store is keyed by `sha256(accessToken)`.
- Adding/removing a channel entirely (adapter instantiation/teardown + approval wiring)
- Top-level `workspace` (would need re-seeding templates + re-resolving every tool cwd)

## Secrets in `.env` (hot-refreshed alongside config.json)

The watcher watches the whole `$MY_CLAW_DIR` directory, so it now also reacts to edits of
`$MY_CLAW_DIR/.env` (not only `config.json`). On any reload, `readConfigFromDisk` calls
`loadEnv(forceRefresh=true)`: the file becomes authoritative and overwrites the in-memory
`process.env` value of every key it defines. At **boot** (`loadConfig`) the old first-wins rule
still holds -- the shell/systemd environment beats the file -- so start-up precedence is unchanged.

Effectiveness depends on how the secret is consumed:

- `CLAUDE_CODE_OAUTH_TOKEN`: **fully hot**. The Claude SDK backend rebuilds `env` from
  `process.env` and respawns the CLI on every run, so a rotated token is used by the next run
  with no restart. In-flight runs keep the token their subprocess already received.
- Telegram/Matrix tokens: `process.env` (and the parsed config) update, but the already-connected
  client keeps its session until reboot (still listed under reboot-only above).

A bare `.env` edit produces no config-section diff, so the reload short-circuits before the
appliers and logs `config watcher fired with no section changes (env refreshed)` for observability.

## Decisions

### Fail-safe on bad input

A save mid-write or invalid JSON makes the re-parse throw. The watcher catches it, logs a warning, and
**keeps the running config** -- a broken file never takes down or corrupts the live state. Events are
debounced (300ms) so editors that emit multiple writes trigger a single reload.

Three things extend this (see `docs/config-backup.md`):

- The refused content is archived under `backups/<artifact>/rejected/`. The owner repairs the file
  within seconds, so without the archive nothing would still explain why the edit never applied.
- `parseConfig` now also rejects a section of the wrong *type* (`"llm": "oops"`), which used to be
  stored as-is and break the object identity this whole design depends on. A section that is simply
  **absent** stays legal and still empties the live section, matching what a restart produces.
- `applyHotReload` is wrapped in try/catch. It used to sit between the two guarded blocks, so a throw
  inside it became an unhandled rejection and `index.ts` turned that into `process.exit(1)`.

`startConfigWatcher` returns `{ stop, reloadNow }` rather than a bare stop function. `reloadNow()`
exists because a restored file cannot be trusted to produce an `fs.watch` event -- a recreated dotfile
emits none at all -- so `/config rollback` applies through this call and reports the resulting
`changed` / `rebootRequired` instead of hoping the watcher notices.

### Browser tool is always registered

To make `browser.enabled` toggleable at runtime, `delegate_browser_task` is now always registered; its
`execute` reads `config.browser.enabled` live and no-ops with an error when disabled. The sidecar client
is built per call, so a new `sidecarUrl` takes effect on the next delegation with no reconnection logic.

### Web search (re)registration

`web_search` is registered through a reusable closure. If `webSearch.baseUrl` is added at runtime, the
applier re-registers the tool (the registry overwrites by name). The tool already reads
`config.webSearch` live, so changing `baseUrl`/`language`/`token` needs no re-registration.

### External MCP servers

`mcp` is applied in place for live reads, but connections must also be opened/closed, so the applier calls
`McpManager.sync(config.mcp)`. `sync` diffs the map: it connects added servers, reconnects those whose
wiring changed, and drops removed/disabled ones. See `docs/hot-reload-extensions.md`.

### Skills watcher (separate from config)

Skills are not in `config.json`, so they have their own `fs.watch` (`src/skills/watcher.ts`): dropping or
editing a `SKILL.md` under the custom/workspace tiers refreshes the registry live, no restart. Bun's
recursive watch is unreliable on Linux, so it watches each tier dir plus every skill subdir. The built-in
tier stays boot-only (repo-synced). See `docs/hot-reload-extensions.md`.

### Observability

Each reload emits `config:reloaded` with `{ changed, rebootRequired }` and logs both lists. This is the
single source of truth for "what took effect" vs "what still needs a restart". Skills and MCP emit
`skills:reloaded` and `mcp:synced` respectively.

## Code map

- `src/core/config.ts` -- `parseConfig`, `readConfigFromDisk`, `CONFIG_PATH` (reusable, no workspace side
  effects)
- `src/core/config-watcher.ts` -- `applyHotReload` (pure diff + in-place mutation), `runReloadAppliers`
  (boot-snapshot setters), `startConfigWatcher` (fs.watch + debounce + hook emit)
- Setters: `ModelPicker.setModels`, `{Telegram,Matrix}` `ReactionManager.setConfig` /
  `ErrorReporter.setMode`, `{Telegram,Matrix}Adapter.applyConfigReload` / `setWhitelist`
- Wiring + shutdown cleanup: `src/index.ts`

## Tests

- `tests/config-watcher.test.ts` -- diff classification, in-place identity preservation, reboot-field
  skipping, appliers
- `tests/e2e/config-hot-reload.test.ts` -- real `fs.watch` end-to-end edit -> reload, plus invalid-JSON
  is skipped, plus a bare `.env` edit triggers a reload cycle
- `tests/config.test.ts` -- `readConfigFromDisk` force-refreshes a rotated secret; `loadConfig` (boot)
  keeps a value already set by the shell/systemd
