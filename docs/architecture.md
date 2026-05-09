# Architecture - my-claw

## Implementation Status

| Component | Status |
|---|---|
| Telegram adapter (Phase 1) | Complete — see `docs/platform-features.md` |
| Telegram UX (Phase 2) | Complete — see `docs/plan/telegram-phase2.md` |
| Matrix adapter | Complete — see `docs/matrix.md` |
| Router + auth | Complete |
| Sessions (memory + disk) | Complete |
| Agent bridge | Complete — tool call loop, max 10 iterations, typed session messages |
| LLM provider | Complete — sync + streaming |
| Tools (8) | Complete: bash, read, write, fetch, find, grep, ls, memory |
| System prompt builder | Complete (7-layer architecture) |
| Sub-agents | Complete — persistent sessions, FIFO queueing, 5 tools, 2 types |
| Blacklist system | Scaffolded (`ActionBlacklist`), confirmation UI works |
| Full wiring (index.ts) | Complete — config -> tools -> sessions -> agent -> router -> adapter |

## Channel Structure

- `src/index.ts` wires channel adapters into the router/session stack
- `src/channels/telegram.ts` remains a mostly self-contained adapter
- `src/channels/matrix.ts` is the public Matrix adapter facade
- `src/channels/matrix-client.ts` owns Matrix SDK runtime, crypto bootstrap, sync persistence, and shutdown handling
- `src/channels/matrix/` holds split Matrix modules for ingress, policy, lifecycle, decrypt retry, sync store, storage paths, and inbound dedupe

## Decisions

### Channels

- Telegram: classic bot (Bot API), grammy, long polling + webhook -- priority
- Matrix: classic bot -- priority
- Discord: classic bot (bot token) -- on hold until further notice
- Startup toggle: `channels.<name>.enabled: false`

#### Telegram specifics

- Library: grammy + @grammyjs/runner + @grammyjs/transformer-throttler
- Connection: long polling (dev) and webhook (prod), configurable
- Format: HTML parse mode with plain text fallback
- Message split: 4000 chars, HTML-tag-aware
- Text batching: 1s debounce for split messages
- Native commands: /new, /model, /status, /clear, /help
- Inline buttons: accept/deny for blacklisted actions
- Media: photo, voice, audio, video, document (in/out)
- No dependency injection, no plugin SDK, no multi-account

### Scope & permissions

- Full access on the VM (filesystem, shell, network, everything)
- Blacklist system for sensitive actions:
  - Commands/tools on the blacklist require explicit accept (interactive accept/deny button in the channel)
  - No accept -> automatically denied (not executed)
  - Everything NOT on the blacklist runs without confirmation
  - Blacklist empty by default (everything passes), populated over time
  - Planned for: email sending, sensitive skills, etc.

### Sessions & isolation

- One session per DM (per authorized user)
- One session per group (each Matrix/Telegram group has its own isolated session)
- One file per actual session
- Sessions persist across restarts
- Sessions stored in `~/.my-claw/sessions/`

### Auth & access

- Agent only responds to authorized users, no exceptions
- Forwarded messages from an authorized user are processed normally
- Global whitelist (an authorized user has access everywhere)

### Storage

```
~/.my-claw/
├── config.json              # global config (providers, models, whitelist, blacklist, etc.)
├── prompt/                  # system prompt files
│   ├── SOUL.md
│   ├── AGENTS.md
│   ├── USER.md
│   └── MEMORY.md
├── sessions/
│   ├── telegram/
│   │   ├── dm/
│   │   │   └── <user_id>.json
│   │   └── group/
│   │       └── <group_id>.json
│   ├── matrix/
│   │   ├── dm/
│   │   │   └── <user_id>.json
│   │   └── room/
│   │       └── <room_id>.json
│   └── subagent/            # persistent sub-agent sessions
│       └── <name>-<hex4>.json
├── sessions-archive/        # archived sessions (reset, clear)
└── logs/
```

- Runtime logs are split by scope: `orchestrator`, `telegram`, `matrix`, `matrix-sdk`

- Config format: JSON (jq-compatible)

### pi-mono integration

- SDK direct import as primary method (same process)
- RPC or subprocess when needed (isolation, crash recovery)

### LLM

- Standard API: OpenAI-compatible (universal format)
- Any OpenAI-compatible provider works (Fireworks, OpenRouter, Ollama, LM Studio, etc.)
- Current provider: Fireworks AI (FirePass, Kimi K2.5 Turbo, $7/week)
- Model configurable per session/agent
- Auth: API key per provider (env vars)

### Sub-agents

- 2 types: **general** (full tools) and **research** (read-only: read, grep, find, ls, fetch)
- Mode `run` = one-shot (max 3 concurrent, depth 2), mode `session` = persistent on disk
- Persistent sessions stored in `~/.my-claw/sessions/subagent/${name}-${hex4}.json`
- 5 tools: `spawn`, `send`, `list_agents`, `kill_agent`, `reset_agent`
- FIFO queueing: concurrent `send` to same sub-agent queues instead of rejecting
- Configurable LLM per type via `config.agents.{general,research}.llm`
- Optional `workspaceDir` per sub-agent for filesystem isolation

### Invocation

- DM: responds to every message from an authorized user
- Group: responds to every message from an authorized user (no mention required)
- Forwarded messages from an authorized user: processed normally

### System prompt

- Layered architecture (ordered layers, joined with newlines)
- Inspired by Hermes Agent + OpenClaw
- Format: markdown files (SOUL.md, AGENTS.md, USER.md, MEMORY.md)
- Configurable (not hardcoded)

#### Prompt build order

| # | Layer | Source |
|---|---|---|
| 1 | Identity | SOUL.md |
| 2 | Directives | AGENTS.md |
| 3 | User context | USER.md |
| 4 | Memory | MEMORY.md (frozen snapshot) |
| 5 | Tools | Available tool list |
| 6 | Platform hints | Telegram vs Matrix formatting guidance |
| 7 | Runtime | Date, model, channel, session ID |
