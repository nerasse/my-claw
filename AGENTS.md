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
- The browser sidecar (`sidecar/server.mjs`, Node) is exercised by the gated e2e in
  `tests-e2e/browser/` (`BROWSER_E2E=1`); the Bun unit tests mock its HTTP endpoints.

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
│   ├── config.ts          # App configuration + types
│   └── router.ts          # Message routing (router/ moved here)
├── agent/
│   ├── bridge.ts          # LLM agent orchestration
│   ├── iteration-budget.ts # Per-agent iteration budget (consume/refund/remaining)
│   ├── tool-status.ts     # Tool call formatting (verbose/compact with timing)
│   ├── approvals.ts
│   ├── blacklist.ts
│   ├── preprocess.ts     # Message preprocessing (audio/video/attachments)
│   ├── subagents/
│   │   └── browser.ts
│   └── prompt/
│       ├── builder.ts
│       ├── loader.ts
│       ├── core-prompts.ts
│       ├── anti-injection.ts
│       └── platform-hints.ts
├── channels/
│   ├── types.ts           # UnifiedMessage, ChannelAdapter, shared types
│   ├── model-picker.ts
│   ├── context-visibility.ts
│   ├── meta-commands.ts  # Meta-command filter (/help, /status, etc.)
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
│   └── openai-format.ts   # Tool definition + tool call format conversion
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
│   ├── browser.ts         # Browser navigation/interaction tools
│   ├── skills.ts          # Skill management tools
│   └── spawn.ts, send.ts, list-agents.ts, kill-agent.ts, reset-agent.ts
├── subagents/
│   ├── runner.ts          # Sub-agent execution (spawn, send, kill, reset)
│   ├── registry.ts        # Sub-agent ID generation + listing
│   └── types.ts
├── skills/
│   ├── registry.ts        # Skill registry (3-tier: built-in/custom/workspace)
│   ├── loader.ts          # Skill file loader + YAML frontmatter parser
│   ├── sync.ts            # Built-in skill auto-sync (SHA256 hash)
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
