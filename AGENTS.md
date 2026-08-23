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
- The same preload moves `TMPDIR` inside that root, so `os.tmpdir()` scratch is deleted with
  the run and no test has to remember a cleanup. Keep using `mkdtemp(join(tmpdir(), ...))`;
  never rebuild an absolute `/tmp` path by hand, that is the one way back out of the sandbox.
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

Flow (mechanics in the `forgejo` skill):
```sh
export PATH="$HOME/.bun/bin:$PATH"      # else stdio MCP tests false-fail
bun run check && bun run check:test && bun test
git add <files> && git commit           # never -A
jq '.version="X.Y.Z"' package.json > /tmp/p && mv /tmp/p package.json
git add package.json && git commit -m "chore: bump X.Y.Z"
git push origin main                    # main FIRST: the tag is what CI builds
git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
fj actions tasks | grep <sha>           # wait for "Build & Release" = success
```

Traps:
- Two runs per release (`ci.yml` on main, `release.yml` on the tag). Only the tag run has `Build & Release`.
- Package registry answers **405 to HEAD**. Verify with `curl --range 0-0` → `206`.
  The asset is `my-claw-<v>-linux-x64.tar.gz`, not `my-claw-<v>.tar.gz` — the short name 404s and
  reads as a failed release. `fj release view "my-claw <v>"` prints the real URL.
- `fj release view v<v>` fails here: `release.yml` names it `my-claw <version>` and `fj` looks up by name. Use `fj release list`.
- REST reads need auth (private repo); unauth 404 reads as `target couldn't be found`. Prefer `fj`, it carries its own token.
- `release.yml` fails on tag ≠ `package.json`. Keep that step.
- Prod is never touched by hand. `my-claw-auto-update.timer` (15 min) skips while a run is in flight — an agent releasing from a my-claw session *is* that run, so the first tick skips. The user runs the update.

Quick log check:
```sh
journalctl -u my-claw.service --since "5 min ago" --no-pager | tail -30   # boot errors
ss -tlnp | grep 8080                                                      # up?
grep -m1 '"version"' /opt/my-claw/package.json                            # deployed version
tail -f ~/.my-claw/logs/my-claw-app-$(date +%F).log | jq -c '{t:.timestamp,m:.message,d:.data}'
```
Reading a red CI (job logs *are* reachable, contrary to the `forgejo` skill):
```sh
T=$(jq -r '.hosts["git.kssimi.fr"].token' ~/.local/share/forgejo-cli/keys.json)
A="https://git.kssimi.fr/api/v1/repos/claw/my-claw/actions"
curl -sS -H "Authorization: token $T" "$A/runs?limit=5"        | jq -r '.[]|"\(.id) \(.conclusion)"'
curl -sS -H "Authorization: token $T" "$A/runs/<run_id>/jobs"  | jq -r '.[]|"\(.id) \(.name) \(.status)"'
curl -sS -H "Authorization: token $T" "$A/jobs/<job_id>/logs"
```
The `#180` in `fj actions tasks` is the run **number**, not the API `run_id` — look the id up in `/runs`.

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
│   ├── dispatcher.ts      # BackendDispatcher: routes each run to the home loop for its resolved model
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
│   ├── context-menu.ts     # /model context submenu, shared by both channels -- docs/context-window.md
│   ├── context-visibility.ts
│   ├── meta-commands.ts  # Meta-command filter (/help, /status, etc.)
│   ├── command-log.ts    # Masks sensitive command arguments before they are logged
│   ├── auth-commands.ts  # /codex and /claude subcommands (login, status, logout, set-token)
│   ├── config-commands.ts # /config history|diff|rollback over the snapshot store
│   ├── introspect-commands.ts # /skills, /agents, /mcp, /instructions -- docs/agent-scoping.md
│   ├── status-command.ts  # /status diagnostics: context, tokens, cost -- docs/status-command.md
│   ├── compact-command.ts # /compact for every channel: engine choice + session hold -- docs/compaction.md
│   ├── agent-model-commands.ts # /model <agent>: per-agent model in config -- docs/agent-model.md
│   ├── recreate.ts
│   └── my-claw-app/
│       ├── adapter.ts     # WSS server, device auth, media serving, frame handling
│       ├── sessions.ts    # Thread list/history/archive, keyed by owner
│       ├── files.ts       # Per-thread uploads under $MY_CLAW_DIR/files/my-claw-app/
│       ├── stream.ts      # Token streaming + tool cards (chat.stream.* / chat.tool)
│       └── types.ts       # Wire protocol types -- docs/my-claw-app-channel.md
├── llm/
│   ├── provider.ts        # OpenAI-compatible API client (retry, timeout, safe parsing)
│   ├── tokens.ts          # Token estimation + context window trimming
│   ├── resolver.ts        # Multi-provider model resolution -- docs/model-identity.md
│   ├── model-ref.ts       # Model reference grammar: provider/apiId@endpoint -- docs/model-identity.md
│   ├── openrouter-endpoints.ts # OpenRouter per-model endpoints and provider names (lazy, cached)
│   ├── openai-format.ts   # Tool definition + tool call format conversion
│   ├── catalog.ts         # ModelCatalog: per-provider discovery, merge, cache, resilience
│   ├── pricing.ts         # models.dev price + context window table -- docs/status-command.md
│   ├── context-window.ts  # Window resolution, global cap, occupancy -- docs/context-window.md
│   ├── anthropic-models.ts # Versioned Claude models from /v1/models (families, per-model effort)
│   ├── codex.ts           # Codex Responses transport for the home loop
│   ├── codex-auth.ts      # ChatGPT subscription OAuth (device flow, token refresh)
│   └── claude-auth.ts     # Claude subscription token store
├── sessions/
│   ├── manager.ts         # LRU-cached session manager (max 100, autosave + flush) -- docs/session-durability.md
│   ├── store.ts           # Session persistence (JSON files)
│   └── compaction.ts      # Session context compaction (LLM summarization)
├── analytics/
│   └── usage-db.ts        # SQLite analytics (per-API-call token tracking)
├── approvals/
│   └── store.ts           # SQLite journal of every tool-approval outcome -- docs/my-claw-app-channel.md
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
│   ├── bash.ts, read.ts, write.ts, apply-patch.ts, fetch.ts, search.ts, ls.ts, memory.ts
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
├── agents/                # File-defined sub-agents (agents/*.md) -- docs/file-agents.md
│   ├── loader.ts          # 3-tier scan, frontmatter, per-tier cap, last-good retention
│   ├── registry.ts        # Name -> agent, spawn catalog vs browse catalog
│   ├── resolve.ts         # config entry > agent file > default: the one place a name becomes behaviour
│   ├── reload.ts, watcher.ts, sync.ts
│   ├── builtin/           # general.md, research.md, browser.md (repo-synced by hash at boot)
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
│   ├── logger.ts          # Scoped file logger (orchestrator, my-claw-app)
│   ├── media.ts           # Media ref extraction/dedup
│   ├── errors.ts          # Error formatting
│   ├── atomic-write.ts   # Atomic JSON file writes (temp + rename)
│   ├── invisible.ts       # Invisible-character class, shared -- docs/untrusted-content.md
│   ├── glob.ts            # `*` matching for flat ids (CDP methods, model ids)
│   ├── frontmatter.ts     # Flat `key: value` frontmatter, shared by skills/ and agents/
│   └── lru-map.ts         # LruMap + TtlSet utilities
└── index.ts               # Entry point: config -> skills -> tools -> sessions -> agent -> router -> adapters
```

### Splitting rules

- A channel folder (`channels/my-claw-app/`) contains:
  - `adapter.ts` : server boot, handler wiring, lifecycle only
  - `sessions.ts` / `files.ts` / `stream.ts` : thread state, uploads, outgoing stream
  - Telegram and Matrix were removed: the app/web surface is the only channel.
- Any file over **500 lines** is a candidate for extraction. Not automatic, but a signal.
- `core/` avoids dependencies on `channels/`, `agent/`, `tools/` where possible. `router.ts` bridges `channels/` and `agent/` by design.
- `skills/` contains the 3-tier skill system (registry, loader, sync). `subagents/` contains the sub-agent runner and registry.
- `agents/` contains the *definitions* (what an agent is: prompt, baseline, scopes); `subagents/`
  contains the *instances* (a spawned agent's session and lifecycle). Neither imports the other.
- The frontmatter parser is shared: `utils/frontmatter.ts`, used by both `skills/` and `agents/`.

### Workspace

- The agent operates inside `~/.my-claw/workspace/` (configurable via `config.workspace`).
- The workspace is created on boot if it does not exist.
- Default prompt templates (`SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`) are copied from `docs/prompt/` into the workspace on first start.
- All filesystem tools (`bash`, `read`, `write`, `apply_patch`, `ls`, `search`) resolve relative paths against the workspace.
- `bash` spawns with `cwd` set to the workspace.

### Imports

- Use `../types.ts` for shared channel types when inside a channel subfolder.
- Use `../../core/config.ts` for config when inside a channel subfolder.
- Use `../../utils/logger.ts` for logging when inside a channel subfolder.

- Specs and architecture docs go in `docs/`
- Specs are built incrementally through discussion with the user
