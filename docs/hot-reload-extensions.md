# Hot-reload extensions

> **Note historique** : ce document a été écrit quand my-claw servait aussi Telegram et Matrix.
> Ces deux canaux ont été supprimés (seul `my-claw-app` subsiste). Les mentions et chemins de
> fichiers `channels/telegram/*` et `channels/matrix/*` ci-dessous sont conservés pour la trace
> de la décision : ils ne décrivent plus le code.

## Why

`config.json` and `.env` already hot-reload (`docs/config-hot-reload.md`). The
remaining agent-shaping inputs are still boot-only: adding a skill, toggling a
tool, wiring an MCP server, or tuning the structural prompt each need a restart.
A restart is heavier than it looks -- it re-inits the Matrix E2E crypto store and
re-warms embeddings, and it interrupts in-flight runs. This spec extends live
reload to the inputs that can safely change on a running process, and states
clearly which ones cannot.

Four phases, ordered safest-first. Each ships independently.

Status: Phases 1-4 implemented. Block B (voice, cron, memory) implemented. A5
(tool plugins) implemented. A6b (Telegram identity recreate) implemented. A6
(Matrix identity recreate) is built-but-gated: the recreate mechanism ships and
Telegram uses it, but Matrix stays reboot-only until a live-homeserver Megolm test
passes (see the A6 entry). The grounded plan is in "## Implementation plan" below.

## Decisions

### Phase 1 -- Skills fs watcher (small, no risk)

- Watch `customDir` (`$MY_CLAW_DIR/skills`) and `workspaceSkillsDir`
  (`<workspace>/skills`). Not `.builtin`: that tier is repo-synced at boot only.
- On a debounced change, call the existing `refreshRegistry()` path
  (`loadAllSkills` -> `SkillRegistry.setAll`). `skillRegistry.list()` is already
  read per run (`backend.ts`, `bridge.ts`), so a new/edited `SKILL.md` is live on
  the next run.
- Emit `skills:reloaded` + log for observability. Reuse the config-watcher
  debounce/fail-safe shape.
- Built-in SHA256 sync (`syncBuiltIn`) stays boot-only: the repo skills are not
  editable on the live host.

### Phase 2 -- Tool denylist via config (small)

- New optional `tools.disabled: string[]`, a HOT config section.
- `ToolRegistry.getForAgent` filters these out after the existing per-agent
  exclusion lists. Read live per run (both backends call `getForAgent` per run),
  so a toggle takes effect on the next run.
- Non-breaking: absent/empty means everything on. Denylist, not allowlist, so new
  in-tree tools are on by default and nothing pre-existing breaks.
- Limit: this only toggles already-registered tools. It never adds tool code.

### Phase 3 -- External MCP servers via config (both backends)

Config: `mcp: Record<name, McpServerConfig>` (stdio / SSE / HTTP).

Implemented as a single unified path rather than the originally-planned 3a/3b
split, which is simpler and avoids double-spawning stdio servers:

- One `McpManager` (`src/mcp/manager.ts`) owns the live connections, built on the
  official `@modelcontextprotocol/sdk` client (stdio + SSE + Streamable HTTP
  transports), so we do not hand-roll JSON-RPC. Each remote tool is adapted into
  the my-claw `Tool` interface (`src/mcp/connection.ts`).
- The manager is wired into `ToolRegistry.setDynamicProvider`, so
  `getForAgent`/`get` surface MCP tools live. Both backends already build their
  tool set from `getForAgent`: the home loop uses them directly, and the Claude
  SDK sees them through its per-run in-process tool server. One connection per
  server feeds both -- no native `options.mcpServers`, no double-spawn.
- Hot-reload: `mcp` is a HOT section; the applier calls `McpManager.sync`, which
  diffs the map -- connect added, reconnect wiring-changed, drop removed/disabled.
- Namespacing: external tools are exposed as `mcp__<server>__<tool>`.
- Which agents receive MCP tools is a per-agent scope (`agents.<type>.mcp`, see
  `docs/agent-scoping.md`), not a hardcoded rule. The research sub-agent still
  gets **none by default** -- its absent field resolves to `[]` rather than
  inheriting the orchestrator -- but an explicit `agents.research.mcp` grants it
  servers, which ends the "read-only research agent" guarantee: its built-in
  tools are a read-only allowlist, an MCP server's tools are not.

### Phase 4 -- Externalize CORE_PROMPT to CORE.md (medium)

- Add `CORE.md` to the prompt loader's `PROMPT_FILES` (mtime cache, hot like the
  others). Seed it from `docs/prompt/CORE.md` at boot (add to `PROMPT_TEMPLATES`).
- `buildSystemPrompt` Layer 0 uses the file content; if the file is missing,
  empty, or blank it falls back to the hardcoded `CORE_PROMPT` constant. The
  constant stays in code as both the seed source and the safety net.
- `CORE.md` is distinct from the existing `SYSTEM.md` (which is reference-only
  documentation, not injected).
- Stays hardcoded (safety): `OWNER_STEERING_NOTE`. An editable file must never
  break the mid-run owner-steering contract the SDK backend depends on. The
  anti-injection pattern denylist it used to sit beside was removed outright --
  see `docs/untrusted-content.md`.

### Phase 5 -- Live tool-code plugins (DEFERRED, feasible)

Not scheduled; captured so the feasibility research is not lost.

- Feasibility confirmed empirically on Bun 1.3.13: `import()` loads a `.ts`
  written after process start, and `import(path + "?v=" + Date.now())` reloads a
  changed version (query-string cache-bust works; bare re-import returns cache).
- So loading new tool code live is technically possible; the "no dynamic imports"
  rule in `AGENTS.md` is a self-imposed constraint, not a Bun limit. It would be
  relaxed only for a dedicated owner-only `tools.d/` path.
- Design sketch: watcher over `tools.d/` -> dynamic-import modules exporting a
  `Tool` -> `ToolRegistry.register` (already overwrite-by-name) -> live per run.
- Why deferred (the real cost): loading arbitrary code is an in-process RCE
  surface. Requires owner-only dir, Zod validation of the exported shape, and
  try/catch isolation at load AND exec (a plugin throwing at top level must not
  kill the process). Old versions leak in the module cache (minor).

### Phase 6 -- Matrix identity hot-recreate (DEFERRED, feasible with care)

Not scheduled; captured for the same reason.

- `MatrixClientRuntime` already has clean `start()` and `stop()`
  (`src/channels/matrix/client.ts:196-240`): listener teardown, `stopClient()`,
  crypto snapshot persisted to disk, sync store flushed. The crypto store is fully
  disk-persistent (`restoreIdbFromDisk` at boot / `persistCryptoSnapshot` at stop).
- So identity hot-reload = `stop()` old runtime -> new runtime with new config ->
  `start()` -> re-wire adapter timeline handlers. Sequential, never concurrent
  (respects the SDK "one client at a time on the same store" warning).
- The gate: calling `initRustCrypto` a second time in one process on the shared
  fake-IndexedDB global is undocumented (official docs silent). Must be validated
  by an integration test against a real homeserver before implementing.
- Reframe: "reboot-only" for the Matrix token was about implementation safety, not
  data safety. Changing accessToken/deviceId changes the tokenHash-keyed crypto
  store and makes old Megolm undecryptable -- but a restart with a new token does
  the same. The Megolm loss is inherent to changing the token, not to the reload
  method.

## Scope and limits

- Until Block A/B land, new tool *implementations* and Matrix/Telegram identity are
  boot-only; `memory`/`voice`/`cron` are reboot sections. The plan below moves the
  feasible ones to hot; `workspace` path changes and the safety constants stay out.
- Genuinely never hot: `workspace` path (re-seed + re-resolve every tool cwd) and
  `OWNER_STEERING`. A5 gates tool-code loading behind an opt-in switch.
- MCP: using the official SDK client for all transports avoids a hand-rolled
  JSON-RPC stack. stdio servers are spawned once by the manager and shared by both
  backends. A stdio server that changes wiring is fully torn down before reconnect.
- `CORE.md` is structurally powerful and only normalised, not otherwise guarded;
  `OWNER_STEERING` stays in code.

## Where

- Phase 1: `src/skills/reload.ts` (shared `reloadSkills`), `src/skills/watcher.ts`
  (hybrid tier + subdir watch), wired in `src/index.ts`; `manage_skills` reuses
  `reloadSkills`.
- Phase 2: `src/core/config.ts` (`ToolsConfig` type), `src/tools/registry.ts`
  (`getForAgent` denylist filter), `src/core/config-watcher.ts` (`tools` HOT
  section), call sites `backend.ts` / `bridge.ts` (the browser loop that also read it is gone since 0.7: the browser runs through the bridge).
- Phase 3: `src/core/config.ts` (`McpServerConfig` type), `src/mcp/connection.ts`
  + `src/mcp/manager.ts` (official MCP SDK client, adapter),
  `src/tools/registry.ts` (`setDynamicProvider`, `get`/`getForAgent`),
  `src/core/config-watcher.ts` (`mcp` HOT section + `syncMcp` applier),
  `src/index.ts` (manager wiring + shutdown).
- Phase 4: `src/agent/prompt/loader.ts` (`loadCorePrompt`, scanned + fallback),
  `src/agent/prompt/builder.ts` (Layer 0; the browser reads it through the bridge since 0.7),
  `src/agent/prompt/core-prompts.ts` (constant kept as fallback/seed),
  `docs/prompt/CORE.md` (new seed), `src/core/config.ts` `PROMPT_TEMPLATES`.

## Implementation plan (Block A + B)

Goal: push everything safely hot-reloadable to hot. Ordered easiest-first so each
step ships and de-risks the next. Source-of-truth findings are cited inline; the
deep-check read the real dependency source in `node_modules`, not just docs.

The shared recipe (from Phase 3): move the section out of `REBOOT_SECTIONS` into
`HOT_OBJECT_SECTIONS`, add a callback to `ConfigReloadContext`, add one
`if (changed.includes(...)) ctx.applier(...)` line in `runReloadAppliers`, and
implement the applier in `index.ts` as a closure (mirror `syncMcp`).

### B1 -- voice config (EASY)

`VoiceManager` captures the root `config` and reads `config.voice` live on every
call (`src/voice/manager.ts:14-20`); it already mutates in place for the `audio` tool's `mode`.
Pipelines are stateless, no teardown. So: make `voice` a HOT object section --
the in-place mutation is picked up live, no recreate, no applier. Tests: assert
`voice` hot-applies and preserves object identity.

### B2 -- cron config (EASY)

`CronScheduler` has clean `start()`/`stop()` (`src/cron/scheduler.ts:35-48`);
`timeoutMs` is already read live per tick, only the tick interval is baked into
`setInterval` at start (`scheduler.ts:36-37`). Add a `restart()` that re-arms the
timer with the new interval. Make `cron` HOT + a `reloadCron` applier that calls
`restart()`. No re-pointing: the cron tool holds the same instance. Tests:
`restart()` re-arms with the new interval; `cron` hot change is not reboot.

### B3 -- memory config (MODERATE, split)

Recall knobs (`recallMaxEntries`, `recallMaxChars`, `ftsCandidates`) are read live
per call (`src/memory/recall.ts:60-62`); making `memory` HOT (in-place mutate) is
enough for them -- the tool/consolidation closures hold `config.memory` by
reference so they see it. The embedding model/dimensions need a re-warm: an
applier that, when `memory.embedding` changed, calls `warmupEmbedding` +
`backfillEmbeddings` (the per-row `embedding_model` signature already makes
re-embedding safe and incremental, `src/memory/db.ts:220-230`). The SQLite DB is
never reopened for a config change (only a DB *path* change would need
`closeMemoryDb()` -- left reboot-only). Tests: recall knobs hot; an embedding
model change triggers exactly one re-warm + backfill.

### A5 -- tool-code plugins (MODERATE)

Confirmed on Bun 1.3.13: dynamic `import()` loads a `.ts` written after start, and
`import(path + "?v=" + Date.now())` reloads a changed version. Design:
- A second dynamic provider on `ToolRegistry` (the `setDynamicProvider` pattern
  already exists for MCP), so plugins need no `unregister` API -- swapping the
  provider's backing set is add/remove, reflected live by `getForAgent`.
- A `PluginLoader` over an owner-only `tools.d/` dir: dynamic-import each module,
  validate the exported `Tool` shape with Zod, wrap `execute` in try/catch so a
  throwing plugin cannot crash the process, and skip (log) a bad module.
- An fs watcher (reuse the skills-watcher shape) re-imports with a cache-bust
  query on change.
Guardrails (why this was deferred): loading arbitrary code is RCE by design.
Mitigations: owner-only dir, Zod validation, load+exec isolation, and a config
switch (`tools.pluginsEnabled`, default false) so it is opt-in. Tests: load a
temp plugin, hot-swap it, a malformed plugin is skipped without crashing.

### A6b -- Telegram identity recreate (MODERATE-HARD)

`bot.stop()` is clean (grammy.dev): it cancels `getUpdates` and confirms the
offset; the 409 conflict only hits *concurrent* pollers on one token, so a
*sequential* swap (await stop, then new bot) is safe. `TelegramAdapter.stop()`
already tears down fully (`adapter.ts:224-243`). Plan: extract adapter
construction + full handler wiring (the closure at `index.ts:176-238`) into a
factory; on a `TELEGRAM_REBOOT_FIELDS` change, `await old.stop()` then build+start
a new adapter via the factory, update `telegramRef`, and re-point the holders that
captured the concrete instance (cron `adapters` map, approval-handler closure).

Shipped: the sequential swap + list surgery + ref re-point live in a channel-agnostic
helper `recreateChannelAdapter` (`src/channels/recreate.ts`), so the ordering contract
(fully stop old before build new) and the failure isolation (a throwing `stop` is
logged, not fatal) are unit-tested (`tests/channels/recreate.test.ts`) independently of
grammy/index wiring. `recreateTelegramChannel` in `index.ts` is now a thin adapter over
it, and Matrix (A6) can reuse the same helper once flipped.

### A6 -- Matrix identity recreate (HARD) -- GATED, not flipped

Shipped state: the recreate mechanism exists and is proven by A6b (Telegram) --
`applyChannelReload` takes a `supportsRecreate` flag and a `recreate` output list,
and the config-watcher drives a `recreateChannel` applier. Matrix is wired with
`supportsRecreate=false`, so identity fields stay reboot-only. Flipping it to hot
is intentionally gated on a live-homeserver Megolm test (below) that cannot run in
the dev sandbox/CI; shipping unvalidated crypto teardown+reinit code would risk the
E2E history. To flip once validated: (1) run the live test proving stop -> recreate
-> start preserves decryption; (2) set `supportsRecreate=true` for matrix in
`applyHotReload`; (3) add a `recreateMatrix` applier that mirrors `recreateTelegram`
but also reconstructs the runtime + reactions (bound to the new `sdk`) and re-runs
the timeline + `RoomEvent.MyMembership` subscriptions against the new runtime.

Design (validated against source):

Source of truth (`node_modules/matrix-js-sdk/lib/`): `initRustCrypto` no-ops on a
re-call of the same client (`client.js:1087`), so recreation must use a fresh
`createClient` -- which a new `MatrixClientRuntime` already does. `RustCrypto.stop()`
calls `olmMachine.close()`, which closes the IndexedDB connections
(`rust-crypto.js:155-172`), reached via `stopClient()` in `runtime.stop()`
(`client.ts:234`). So an in-process recreate is safe iff the old runtime is fully
`stop()`-ed (store released + snapshot persisted) BEFORE the new one opens the same
`cryptoDatabasePrefix` -- no overlap. Plan: add a runtime-replace path to
`MatrixAdapter` (today `private runtime` has no setter): `await runtime.stop()`,
build a new runtime, re-run the `onTimeline` subscription and `RoomEvent.MyMembership`
binding against it (handler methods live on the adapter, only the subscription
wiring must be redone -- `adapter.ts:214-216`), then `await runtime.start()`. Gate
before coding: an integration test against a real homeserver proving stop ->
recreate -> start preserves Megolm decryption (the fake-indexeddb snapshot/restore
dance under Bun is the risk). If it fails, Matrix identity stays reboot-only.
Note: changing the accessToken still loses old Megolm (tokenHash re-keys the store)
-- but a restart loses it identically, so this is not a regression.

### Ordering and gates

B1, B2, A5 are independent and low-risk -- do first. B3 next (embedding re-warm).
A6b (Telegram) before A6 (Matrix): same recreate pattern, lower crypto risk, and
it exercises the adapter-factory refactor A6 also needs. A6 only lands if its live
homeserver test passes; otherwise it stays documented-but-reboot.

Decided: (1) plugins load from `tools.d/`, gated by `tools.pluginsEnabled`
(default false, opt-in). (2) Both Telegram (A6b) and Matrix (A6) identity recreate
are in scope; Matrix only merges if its live-homeserver Megolm test passes,
otherwise it stays reboot-only and documented as such.
