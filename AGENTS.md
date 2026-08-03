# Development Rules

## Language & Runtime

- TypeScript, targeting Bun
- Strict types, no `any` unless absolutely necessary
- Top-level imports only, no dynamic imports

## Code Style

- No emojis in code, commits, or comments
- No comments unless the WHY is non-obvious
- Keep it simple, no premature abstractions
- No backward-compatibility shims

## Architecture Decisions

- All architecture and design decisions are documented in `docs/`
- Never decide on architecture, features, or design without explicit user approval
- When in doubt, ask

## Testing

- `bun test` must never touch the real `~/.my-claw`. `bunfig.toml` preloads
  `tests/setup.ts`, which points `MY_CLAW_DIR` at a throwaway temp dir before any
  module loads. Read filesystem roots from `MY_CLAW_DIR` (never hardcode `homedir()`).
- The browser sidecar (`sidecar/`, Node) is exercised by the gated e2e in
  `tests-e2e/browser/` (`BROWSER_E2E=1`); the Bun unit tests mock its HTTP endpoints.
- Module-level state in `src/` is shared by every test file and leaks across them. Reset it
  in `tests/setup-globals.ts` (second preload, loaded after `setup.ts` so `MY_CLAW_DIR` is
  already redirected), not per-file: a per-file reset only protects the files that remember.
- Never assert on a fixed sleep or a bounded polling loop; wait on the event itself. Check
  order-dependence with `bun test --randomize --seed=N` and timing assumptions by rerunning
  under CPU load.
- Bun's `fs.watch` is not active when `watch()` returns. A single write can beat registration
  and be lost outright, so a test must re-touch the file until the watcher reacts. Two measured
  gotchas: a dotfile created *after* the watcher attached produces no events at all (a
  pre-existing one does), and the retry interval must exceed the watcher's debounce or every
  poke re-arms the timer and starves the reload.
- Stub `fetch` through `tests/helpers/mock-fetch.ts`, never by assigning `globalThis.fetch`
  directly: the helper guarantees the restore and resets the circuit breaker on both ends.
- Tests that need the network or an external binary belong in `tests-e2e/` behind an env gate
  (`VOICE_E2E`, `BROWSER_E2E`), never in the default suite. CI runs a bare `bun test`, so a
  gated test only ever runs when someone runs it by hand.
- Test files under `src/**/__tests__/` are excluded from `tsconfig.json` (they import from
  `tests/helpers/`, outside the build `rootDir`) and type-checked by `tsconfig.test.json`
  instead: `bun run check` skips them, `bun run check:test` covers them.

## Git

- Never commit unless the user asks
- Never use `git add -A` or `git add .`
- Always add specific files
- Never force push
- Never use `--no-verify`

## Releases

**IMPORTANT: Always wait for explicit user approval before tagging or creating a release.**
- Never bump version, tag, or push a new release without the user saying "go" or explicitly asking for it
- The user controls the release cadence — even if the code is ready and CI is green, wait for the green light
- This rule takes precedence over any automation or script that might suggest tagging

## Project Structure

```
src/
├── core/
│   ├── config.ts          # App configuration + types, per-agent scoping -- docs/agent-scoping.md
│   ├── config-watcher.ts  # Hot-reload of ~/.my-claw/config.json (fs.watch)
│   ├── config-store.ts    # Config snapshots: boot fallback, health gate, rollback -- docs/config-backup.md
│   ├── config-edit.ts     # Targeted config.json writes from chat -- docs/agent-model.md
│   ├── config-health.ts   # A/B loop: quarantines a config that never brings a channel up
│   ├── router.ts          # Message routing (router/ moved here)
│   ├── run-registry.ts    # Live run tree (main + sub-agents) for /status and /stop
│   └── aborted.ts         # rethrowIfAborted + shared abort helpers
├── agent/
│   ├── backend.ts         # AgentBackend interface (router/channels depend on this, not on a concrete engine)
│   ├── dispatcher.ts      # BackendDispatcher: routes each run to the engine of its resolved model
│   ├── claude-sdk/        # Claude Agent SDK backend (subscription auth) — docs/claude-sdk-backend.md
│   │   ├── backend.ts     # ClaudeSdkBackend: run lifecycle, streaming, injections, usage
│   │   ├── tools.ts       # Per-run in-process MCP server factory (closures = run context)
│   │   ├── schema.ts      # JSON Schema -> Zod conversion for tool()
│   │   ├── models.ts      # discoverSdkModels: supportedModels() over the SDK control channel
│   │   └── history.ts     # Replays local history into a fresh SDK session (engine switch)
│   ├── bridge.ts          # LLM agent orchestration (home OpenAI-compatible loop)
│   ├── iteration-budget.ts # Per-agent iteration budget (consume/refund/remaining)
│   ├── context-pruning.ts # Prunes old tool results from the prompt (home loop)
│   ├── tool-status.ts     # Tool call formatting (verbose/compact with timing)
│   ├── approvals.ts
│   ├── blacklist.ts
│   ├── preprocess.ts     # Message preprocessing (audio/video/attachments)
│   ├── subagents/
│   │   └── browser.ts     # delegate_browser_task sub-agent
│   └── prompt/
│       ├── builder.ts
│       ├── loader.ts
│       ├── core-prompts.ts
│       ├── normalize-untrusted.ts
│       ├── nested-agents.ts   # Per-directory AGENTS.md collected from the paths tools touch
│       └── platform-hints.ts
├── channels/
│   ├── types.ts           # UnifiedMessage, ChannelAdapter, shared types
│   ├── model-picker.ts   # /model menu: nested groups, identity-addressed callbacks, effort
│   ├── context-visibility.ts
│   ├── meta-commands.ts  # Meta-command filter (/help, /status, etc.)
│   ├── command-log.ts    # Masks sensitive command arguments before they are logged
│   ├── auth-commands.ts  # /codex and /claude subcommands (login, status, logout, set-token)
│   ├── config-commands.ts # /config history|diff|rollback over the snapshot store
│   ├── introspect-commands.ts # /skills, /agents, /mcp, /instructions -- docs/agent-scoping.md
│   ├── status-command.ts  # /status diagnostics: context, tokens, cost -- docs/status-command.md
│   ├── agent-model-commands.ts # /model <agent>: per-agent model in config -- docs/agent-model.md
│   ├── recreate.ts
│   ├── telegram/
│   │   ├── adapter.ts     # Grammy boot, handler wiring, lifecycle
│   │   ├── send.ts        # All outgoing send/edit/delete methods
│   │   ├── context.ts     # History, thread roots, reply context
│   │   ├── commands.ts
│   │   ├── errors.ts
│   │   ├── format.ts
│   │   ├── offset-store.ts
│   │   ├── policy.ts
│   │   ├── reactions.ts
│   │   ├── session-handlers.ts
│   │   ├── split.ts
│   │   └── stream.ts
│   └── matrix/
│       ├── adapter.ts     # Timeline ingress, handler wiring, lifecycle
│       ├── send.ts        # All outgoing send/edit/upload methods
│       ├── context.ts     # Room history, thread context, reply context
│       ├── actions.ts
│       ├── approval-store.ts
│       ├── client.ts
│       ├── commands.ts
│       ├── crypto-idb.ts
│       ├── decrypt-bridge.ts
│       ├── errors.ts
│       ├── file-sync-store.ts
│       ├── format.ts
│       ├── helpers.ts
│       ├── history.ts
│       ├── inbound-buffer.ts
│       ├── inbound-dedupe.ts
│       ├── ingress.ts
│       ├── policy.ts
│       ├── polls.ts
│       ├── reactions.ts
│       ├── retry.ts
│       ├── session-handlers.ts
│       ├── storage.ts
│       ├── stream.ts
│       ├── sync-lifecycle.ts
│       ├── text.ts
│       └── types.ts
├── llm/
│   ├── provider.ts        # OpenAI-compatible API client (retry, timeout, safe parsing)
│   ├── tokens.ts          # Token estimation + context window trimming
│   ├── resolver.ts        # Multi-provider model resolution
│   ├── openai-format.ts   # Tool definition + tool call format conversion
│   ├── catalog.ts         # ModelCatalog: per-provider discovery, merge, cache, resilience
│   ├── pricing.ts         # models.dev price table + cost resolution -- docs/status-command.md
│   ├── anthropic-models.ts # Versioned Claude models from /v1/models (families, per-model effort)
│   ├── codex.ts           # Codex Responses transport for the home loop
│   ├── codex-auth.ts      # ChatGPT subscription OAuth (device flow, token refresh)
│   └── claude-auth.ts     # Claude subscription token store
├── sessions/
│   ├── manager.ts         # LRU-cached session manager (max 100, persist-on-evict)
│   ├── store.ts           # Session persistence (JSON files)
│   └── compaction.ts      # Session context compaction (LLM summarization)
├── analytics/
│   └── usage-db.ts        # SQLite analytics (per-API-call token tracking)
├── memory/                # Active memory: SQLite store, hybrid recall, dedup, consolidation
│   ├── db.ts              # SQLite (entries + FTS5), CRUD, soft-delete, purge
│   ├── embedding.ts       # embed() local (transformers.js) / http, warm-up, cosine
│   ├── dedup.ts           # hash + semantic dedup (add/skip/review)
│   ├── recall.ts          # hybrid FTS5 + cosine retrieval
│   ├── consolidate.ts     # per-category LLM merge (soft-delete old)
│   ├── export.ts          # DB <-> MEMORY.md view, legacy migration
│   ├── cache.ts, types.ts, index.ts  # recall cache, domain types, public API
├── tools/
│   ├── types.ts           # Tool interface + safe arg helpers (str, num, bool)
│   ├── registry.ts
│   ├── workspace.ts       # Workspace path resolution
│   ├── bash.ts, read.ts, write.ts, fetch.ts, find.ts, grep.ts, ls.ts, memory.ts
│   ├── web-search.ts
│   ├── browser/           # Browser tools: state, navigation, actions, lowlevel, delegate
│   ├── plugins.ts         # PluginLoader: external tool plugins
│   ├── skills.ts          # Skill management tools
│   ├── cron.ts            # Schedule/list/pause/resume/trigger cron jobs
│   ├── stt.ts, tts.ts, voice-mode.ts  # Manual voice tools (thin wrappers over voice/)
│   └── spawn.ts, send.ts, list-agents.ts, kill-agent.ts, reset-agent.ts
├── subagents/
│   ├── runner.ts          # Sub-agent execution (spawn, send, kill, reset) -- docs/subagent-visibility.md
│   ├── registry.ts        # Sub-agent ID generation + listing
│   └── types.ts
├── skills/
│   ├── registry.ts        # Skill registry (3-tier: built-in/custom/workspace), per-agent scope
│   ├── loader.ts          # Skill file loader + YAML frontmatter parser
│   ├── sync.ts            # Built-in skill auto-sync (SHA256 hash)
│   ├── reload.ts          # Re-scans the skill dirs into the registry (/reload-skills)
│   ├── retrieval.ts       # Skill suggestion: embedding vectors + keyword fallback
│   └── types.ts
├── mcp/
│   ├── manager.ts         # External MCP servers: connect/reconnect, per-server status()
│   └── connection.ts      # One server connection (stdio/SSE transports, tool listing)
├── cron/
│   ├── scheduler.ts       # Tick loop, at-most-once dispatch, timeout wall
│   ├── store.ts           # jobs.json CRUD, schedule parsing, next-run compute
│   └── types.ts
├── hooks/
│   ├── bus.ts             # emit (void), check (gate), waterfall dispatch
│   ├── index.ts           # Shared hooks singleton + registration
│   └── types.ts
├── voice/
│   ├── manager.ts         # Voice mode resolution (cloud/local/auto)
│   ├── stt.ts             # Speech-to-text (Groq cloud + faster-whisper local)
│   ├── tts.ts             # Text-to-speech (Edge TTS + Piper)
│   └── types.ts
├── browser/
│   ├── client.ts          # HTTP client to the Node browser sidecar (pages = opaque ids)
│   └── types.ts           # Snapshot, Attachment, TabInfo, Result
│   # NOTE: Playwright lives in the top-level sidecar/ (Node), not here — connectOverCDP
│   # hangs under Bun. The sidecar owns navigate/snapshot/click/type/screenshot + tabs.
├── media/
│   ├── image.ts           # Image resize + base64 conversion
│   └── video.ts           # Video frame extraction (ffmpeg)
├── utils/
│   ├── logger.ts          # Scoped file logger (orchestrator, telegram, matrix)
│   ├── media.ts           # Media ref extraction/dedup
│   ├── errors.ts          # Error formatting
│   ├── atomic-write.ts   # Atomic JSON file writes (temp + rename)
│   ├── invisible.ts       # Invisible-character class, shared -- docs/untrusted-content.md
│   └── lru-map.ts         # LruMap + TtlSet utilities
└── index.ts               # Entry point: config -> skills -> tools -> sessions -> agent -> router -> adapters
```

### Splitting rules

- A channel folder (`channels/telegram/`, `channels/matrix/`) contains:
  - `adapter.ts` : Grammy/SDK boot, handler wiring, lifecycle only
  - `send.ts` : All outgoing methods (send, edit, delete, upload)
  - `context.ts` : Room/thread history, reply context, sender resolution
- Any file over **500 lines** is a candidate for extraction. Not automatic, but a signal.
- `core/` avoids dependencies on `channels/`, `agent/`, `tools/` where possible. `router.ts` bridges `channels/` and `agent/` by design.
- `skills/` contains the 3-tier skill system (registry, loader, sync). `subagents/` contains the sub-agent runner and registry.

### Workspace

- The agent operates inside `~/.my-claw/workspace/` (configurable via `config.workspace`).
- The workspace is created on boot if it does not exist.
- Default prompt templates (`SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`) are copied from `docs/prompt/` into the workspace on first start.
- All filesystem tools (`bash`, `read`, `write`, `ls`, `find`, `grep`) resolve relative paths against the workspace.
- `bash` spawns with `cwd` set to the workspace.

### Imports

- Use `../types.ts` for shared channel types when inside a channel subfolder.
- Use `../../core/config.ts` for config when inside a channel subfolder.
- Use `../../utils/logger.ts` for logging when inside a channel subfolder.

- Specs and architecture docs go in `docs/`
- Specs are built incrementally through discussion with the user
