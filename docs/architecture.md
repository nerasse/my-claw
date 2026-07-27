# Architecture - my-claw

## Implementation Status

| Component | Status |
|---|---|
| Telegram adapter (Phase 1) | Complete — see `docs/platform-features.md` |
| Telegram UX (Phase 2) | Complete — see `docs/plan/telegram-phase2.md` |
| Matrix adapter | Complete — see `docs/matrix.md` |
| Router + auth | Complete |
| Sessions (memory + disk) | Complete |
| Agent bridge | Complete — tool call loop, configurable iteration budgets (90/50), grace call summary, typed session messages |
| LLM provider | Complete — sync + streaming |
| Tools (8 base + voice, browser, skill, subagent, search, cron) | Complete: bash, read, write, fetch, find, grep, ls, memory + stt, tts, voice_mode, delegate_browser_task, spawn, send, list_agents, kill_agent, reset_agent, list_skills, read_skill, manage_skills, web_search, cron |
| System prompt builder | Complete (8-layer: hardcoded core + 3 workspace files + 4 dynamic) |
| Nested AGENTS.md | Complete — lazy per-tool discovery: the AGENTS.md chain from the git root down to a touched subtree is appended to the tool result (file tools via `path`, bash via `workdir`), scanned + byte-capped + deduped per run — see `docs/nested-agents.md` |
| Context pruning + auto-compaction | Complete — prompt-side stubbing of tool results older than 5 assistant turns (session file untouched), auto LLM compaction at 80% of the model context at run start — see `docs/context-pruning.md` |
| Sub-agents | Complete — persistent sessions, FIFO queueing, 5 tools, 2 types |
| Skills system | Complete — hybrid 3-tier (built-in/custom/workspace), progressive disclosure, multi-file, scripts |
| Cron / Scheduling | Complete — interval/cron/one-shot, at-most-once, tool-restricted cron agent type, [SILENT] delivery suppression, manual JSON editing + chat creation |
| Hooks / Event System | Complete — 95 hooks (83 void + 7 gate + 5 waterfall), instrumented across app/message/agent/tool/session/memory/skill/subagent/cron/stream/channel lifecycles |
| Run control (`/stop`) | Complete — aborts the session run + all sub-agents via one shared AbortSignal, abortable LLM/bash/fetch/web_search, live run tree in `/status` — see `docs/stop.md` |
| Mid-run injection (steering) | Complete — a message arriving during an active run is injected at the next iteration boundary (text + media), answered in its own threaded bubble, with correct reactions; per-session mailbox, cap + reroute fallback — see `docs/injection.md` |
| Active Memory | Complete — SQLite store (no cap), hybrid FTS5 + optional embeddings (local transformers.js / OpenAI-compatible http), dedup, background consolidation, soft-delete + 365d purge, MEMORY.md view — see `docs/memory.md` |
| Blacklist system | Complete — approval is purely blacklist-driven (empty by default = full autonomy); listed tools require an interactive accept/deny, everything else runs unconfirmed |
| Voice / Multimedia | Complete — STT auto (Groq + faster-whisper), TTS manual (Edge TTS + Piper), voice mode runtime, echo transcript, image vision (ffmpeg resize + base64), video frames (ffmpeg 1 frame/3s, max 20) |
| Full wiring (index.ts) | Complete — config -> skills -> tools -> sessions -> agent -> router -> adapter |

## Channel Structure

- `src/index.ts` wires channel adapters into the router/session stack
- `src/channels/telegram/adapter.ts` — Grammy bot, handler wiring, lifecycle, inbound processing, attachments
- `src/channels/matrix/adapter.ts` — Matrix timeline ingress, lifecycle, inbound buffering, attachments
- Both channel folders contain split modules: `send.ts`, `context.ts`, `commands.ts`, `errors.ts`, `format.ts`, `policy.ts`, `reactions.ts`, `stream.ts`, `session-handlers.ts`
- Matrix-specific: `client.ts` (SDK runtime, crypto), `decrypt-bridge.ts`, `ingress.ts`, `inbound-buffer.ts`, `inbound-dedupe.ts`, `sync-lifecycle.ts`

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
- Commands (unified both platforms): /new, /model, /models, /compact, /reload, /verbose, /status, /stop, /clear, /archive, /help, /commands
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
- `/new` archives and clears conversation state while preserving an explicitly selected model

### Auth & access

- Agent only responds to authorized users, no exceptions
- Forwarded messages from an authorized user are processed normally
- Global whitelist (an authorized user has access everywhere)

### Voice / Multimedia

- **STT auto**: inbound audio transcribed automatically before agent processing
  - Cloud: Groq API (whisper-large-v3), requires GROQ_API_KEY
  - Local: faster-whisper server on :8000 (matches the my-claw-whisper systemd unit; override via `FASTER_WHISPER_ENDPOINT`)
  - No fallback — error explicit if chosen mode fails
  - Echo transcript sent as visible message: `📝 "transcription"`
- **TTS manual**: agent calls `tts` tool only when user asks for audio
  - Cloud: Edge TTS (fr-FR-RemyMultilingualNeural)
  - Local: Piper (fr_FR-siwis-medium)
  - No automatic TTS post-response
- **Images (vision)**: inbound images converted to base64 and sent via `image_url` in content array
  - ffmpeg resize if > 2MB (scale to max 2000px)
  - Only sent when `llm.vision: true` in config
  - Session store keeps text representation only (not base64 blob)
- **Video**: inbound videos converted to image frames before processing
  - ffmpeg extracts 1 frame every 3 seconds, max 20 frames
  - Frames become `image` attachments, processed by the image pipeline
  - Original video attachments removed after extraction
  - Text note `[Video]: "filename" (N frames extracted)` added to message
- **Voice mode**: runtime switchable without reboot
  - `voice_mode(mode="cloud", feature="all")`
  - Priority: per-call > feature-level > global > auto-detect
- Config: `voice.mode`, `voice.stt.mode`, `voice.tts.mode`, `voice.tts.voice`, `llm.vision`
- See `docs/config.md` for full LLM configuration reference

### Storage

```
~/.my-claw/
├── config.json              # global config (providers, models, whitelist, blacklist, voice, etc.)
├── workspace/               # agent's working directory (filesystem tools resolve here)
│   ├── SOUL.md              # system prompt files (seeded from docs/prompt/ on first boot)
│   ├── AGENTS.md
│   ├── USER.md
│   ├── MEMORY.md            # human-readable memory view (source of truth is memory.db)
│   └── skills/              # workspace-tier (agent-generated) skills
├── skills/                  # custom (user-managed) skills; built-in live under skills/.builtin/
├── cron/
│   ├── jobs.json            # scheduled jobs (atomic writes)
│   └── output/<jobId>/<timestamp>.md   # per-run execution history
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
├── analytics.db             # SQLite — per-API-call token usage (WAL mode)
├── memory.db                # SQLite — long-term memory: entries + FTS5 (WAL mode)
├── tmp/                     # transient media/temp files (cleaned on boot)
└── logs/
```

Hooks are an in-process event bus (`src/hooks/`), not persisted to disk.

- Runtime logs are split by scope: `orchestrator`, `telegram`, `matrix`, `matrix-sdk`
- Every command is recorded (`command received`, with the resolved `sessionId`, plus
  `command not recognized`), because a session whose history changed could not otherwise be tied to
  the command that changed it. Menu interactions are recorded too: `telegram button action` and
  `matrix menu action`.
- Command arguments are masked by `src/channels/command-log.ts` before they are logged or emitted
  on the `command:received` hook. `/claude set-token <token>` carries a live credential and used to
  be written to disk in clear.

- Config format: JSON (jq-compatible)

### pi-mono integration

- SDK direct import as primary method (same process)
- RPC or subprocess when needed (isolation, crash recovery)

### LLM

- Standard API: OpenAI-compatible (universal format)
- **Multi-provider**: unlimited OpenAI-compatible providers via `config.llm.providers`
- Any provider works: Fireworks, Groq, OpenRouter, Anthropic (via OpenRouter), Together, Ollama, vLLM, LM Studio, or any custom endpoint
- Current default: Fireworks AI (FirePass, Kimi K2.6 Turbo)
- Model configurable per session/agent — `/model` command switches provider at runtime
- Auth: API key per provider via env vars (`apiKeyEnv` in provider config), with global fallback
- Custom headers per provider supported
- Backward-compatible: legacy `{baseUrl, model}` configs auto-migrate on boot
- **Retry**: 3 attempts with exponential backoff + jitter for 429/5xx, respects `Retry-After`
- **Timeout**: 120s non-streaming, 300s streaming (AbortController)
- **Safe parsing**: malformed JSON in SSE chunks or tool args logged + skipped, never crashes
- Error responses read and included in thrown error messages
- **Context window**: auto-trims old messages before each LLM call when `limit.context` is set (4 chars/token heuristic, 15% safety margin, respects tool-call/result pairs)
- **Usage tracking**: captures `prompt_tokens`/`completion_tokens` from every API response (including streaming via `stream_options.include_usage`), accumulates per session in `tokenUsage`, persisted to disk, shown in `/status`
- **Analytics DB**: SQLite at `~/.my-claw/analytics.db` — one row per API call with session, model, tokens, duration, caller type. WAL mode. Queryable via `sqlite3` or any SQL tool

### Sub-agents

- 2 types: **general** (full tools) and **research** (read-only: read, grep, find, ls, fetch)
- Mode `run` = one-shot (max 3 concurrent, depth 2), mode `session` = persistent on disk
- Persistent sessions stored in `~/.my-claw/sessions/subagent/${name}-${hex4}.json`
- 5 tools: `spawn`, `send`, `list_agents`, `kill_agent`, `reset_agent`
- FIFO queueing: concurrent `send` to same sub-agent queues instead of rejecting
- Configurable LLM per type via `config.agents.{general,research}.llm.model` (any provider/model)
- Optional `workspaceDir` per sub-agent for filesystem isolation

### Skills

- Hybrid 3-tier: **built-in** (repo, versioned, auto-sync), **custom** (user-managed), **workspace** (agent-generated)
- Format: `SKILL.md` with YAML frontmatter (agentskills.io standard)
- Progressive disclosure: only index (name + description) in system prompt; full content loaded on-demand via `read_skill`
- Multi-file skills: `references/`, `examples/`, `scripts/` subdirectories supported
- Script execution: `${SKILL_DIR}` placeholder substituted with absolute skill directory path in `read_skill` output
- 3 tools: `list_skills` (read), `read_skill` (read), `manage_skills` (write)
  - `manage_skills` actions: `create`, `update`, `delete`, `reload`
  - Auto-reload: registry refreshes automatically after create/update/delete
  - User command: `/reload-skills` forces rescan from disk
- Shared globally: main agent and all sub-agents see the same skills regardless of `workspaceDir`
- Resolution priority: workspace > custom > built-in
- Auto-update: SHA256 hash comparison at boot, manifest.json tracking
- Built-in skills read-only for agent

### Invocation

- DM: responds to every message from an authorized user
- Group: responds to every message from an authorized user (no mention required)
- Forwarded messages from an authorized user: processed normally

### System prompt

- Hybrid architecture: hardcoded core + workspace files + dynamic content
- Inspired by Hermes Agent (safety/tool-use) + OpenClaw (two-zone cache concept, simplified)
- Ultra-minimal hardcoded base (~15 lines) — models are smart enough
- Rich tool/skill descriptions do the heavy lifting

#### Prompt build order

| # | Layer | Source | Content |
|---|---|---|---|
| 0 | Core directives | **Hardcoded** (incassable) | Tool-use enforcement, safety, verification, skill reload, memory rules |
| 1 | Identity | SOUL.md (workspace) | Personality, tone, style |
| 2 | Directives | AGENTS.md (workspace) | Workspace rules, red lines |
| 3 | User context | USER.md (workspace) | User profile |
| 4 | Skills | Dynamic | Available skills index + `read_skill()` injonction |
| 5 | Tools | Dynamic | Available tools with rich descriptions |
| 6 | Platform hints | Dynamic | Telegram/Matrix formatting |
| 7 | Runtime | Dynamic | Date, model, channel, session ID |

Long-term memory is no longer a prompt layer. Relevant entries are recalled per turn and injected into the user message (see `docs/memory.md`).

Layer 2 is only the **workspace-root** AGENTS.md. AGENTS.md files in subtrees the run
touches are surfaced lazily, appended to the relevant tool result rather than preloaded
here (see `docs/nested-agents.md`).

Layers 1-3 are re-read per run and cached on mtime only, with no time-based staleness
window: editing a workspace prompt file applies from the very next message. This holds on
both engines -- the Claude Agent SDK receives the freshly built prompt in its `initialize`
request on every run, and a changed prompt takes effect even when resuming an existing SDK
session.

#### Anti-injection

- All workspace files scanned before injection, plus every nested AGENTS.md discovered in
  a subtree (untrusted external content) -- see `docs/nested-agents.md`
- 10 threat patterns + invisible unicode characters
- Blocked files replaced with `[BLOCKED: potential prompt injection]`

#### SYSTEM.md

- Reference document (not injected into prompt)
- Documents hardcoded rules for user reference
- Auto-seeded from `docs/prompt/SYSTEM.md` template
