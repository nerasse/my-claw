# Config hot-reload

## Why

`config.json` was read exactly once at boot (`loadConfig`) and the parsed object was passed by
reference everywhere. Changing a model, a limit, an allowlist or a reaction emoji meant restarting the
whole process -- which on Matrix re-inits the E2E crypto session and re-warms embeddings, i.e. a heavy,
disruptive operation for a trivial change.

Hot-reload watches `~/.my-claw/config.json` and applies the **safe** subset of changes in place, with no
restart. Fields that genuinely cannot be swapped on a live process (channel identity/crypto, tokens,
boot-wired timers) are detected, skipped, and reported as `rebootRequired`.

## The golden rule: mutate in place, never replace the reference

Every consumer holds a reference to the live config object (or a sub-object). The watcher therefore
**mutates the existing objects/arrays in place** (`replaceContents` / `Array.splice`) and never reassigns
a section to a fresh reference. If it replaced `config.llm = {...}`, components that captured
`config.llm` (or a derived value) at boot would keep pointing at the stale object -- divergent state.

Two consumption patterns exist and both are covered:

- **Live reads through the shared root config** (`this.config.llm`, `config.browser?.cdpUrl`, ...):
  picked up automatically on the next use once the contents are mutated.
- **Boot-time snapshots** (ModelPicker's model list, the channel reaction/error managers, the adapter
  whitelist `Set`): these copy values out at construction, so a small setter is called by an *applier*
  after the mutation (`setModels`, `setConfig`, `setMode`, `setWhitelist`, `applyConfigReload`).

## What hot-reloads vs what needs a reboot

Hot-reloadable (applied in place, effective on the next message/call):

- `llm.*` (defaultProvider, defaultModel, providers, limit, vision, models)
- `agents.*` (maxIterations, llm)
- `injection`, `browser` (enabled/cdpUrl/maxSteps/...), `webSearch`
- `whitelist`, `blacklist`
- Telegram/Matrix **behavioral** fields: dm/group policy + allowFrom, groups, contextVisibility,
  historyLimit, streaming, replyToMode, threadReplies, reactions, errorPolicy, chunking, mediaMaxMb,
  displayName, autoJoin, ...

Reboot-only (detected, **not** applied, reported in `rebootRequired`):

- `channels.telegram`: `token`, `mode`, `webhook`, `enabled` (the Grammy Bot + polling loop bake these in)
- `channels.matrix`: `homeserver`, `accessToken`, `userId`, `password`, `deviceId`, `encryption`,
  `initialSyncLimit` -- the Rust E2E crypto store is keyed by `sha256(accessToken)` and initialized
  once; recreating it risks losing inbound Megolm sessions (undecryptable history)
- Adding/removing a channel entirely
- Top-level `memory`, `voice`, `cron`, `workspace` (boot-wired timers, clients, env)

## Decisions

### Fail-safe on bad input

A save mid-write or invalid JSON makes the re-parse throw. The watcher catches it, logs a warning, and
**keeps the running config** -- a broken file never takes down or corrupts the live state. Events are
debounced (300ms) so editors that emit multiple writes trigger a single reload.

### Browser tool is always registered

To make `browser.enabled` toggleable at runtime, `delegate_browser_task` is now always registered; its
`execute` reads `config.browser.enabled`/`cdpUrl` live and no-ops with an error when disabled. The CDP
pool is built per call, so a new `cdpUrl` takes effect on the next delegation with no reconnection logic.

### Web search (re)registration

`web_search` is registered through a reusable closure. If `webSearch.baseUrl` is added at runtime, the
applier re-registers the tool (the registry overwrites by name). The tool already reads
`config.webSearch` live, so changing `baseUrl`/`language`/`token` needs no re-registration.

### Observability

Each reload emits `config:reloaded` with `{ changed, rebootRequired }` and logs both lists. This is the
single source of truth for "what took effect" vs "what still needs a restart".

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
  is skipped
