# Claude SDK Backend

## Why

Using a Claude subscription (Pro/Max) programmatically is only allowed through the
Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) authenticated with a
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. Direct API access with
subscription tokens and OpenAI-compatible proxies over the subscription are
explicitly against Anthropic ToS (enforced since early 2026).

The SDK is not a completions API: it is a full agent loop (bundled Claude Code
binary as subprocess, built-in context management, MCP tools, hooks, sessions).
Integrating it means delegating entire runs to it, not swapping the HTTP client.

## Decisions

### The model is the single axis; the backend follows from it

- `providers[name].type?: "openai" | "claude-sdk"` (default `"openai"`, no shims:
  existing configs are untouched). A `claude-sdk` provider has no `baseUrl`; auth
  comes from the OAuth token env var.
- `models[]` freely mixes both worlds (mimo, Qwen, haiku, sonnet, opus, fable...).
  The resolver carries a `backend` discriminant in `ResolvedLlmConfig`.
- Backend selection happens upstream of the loop: an `AgentBackend` interface
  (extracted from the current `AgentBridge` public contract: `handleMessage`,
  `handleMessageStreaming`, preprocess/echo/attachments accessors) with two
  implementations — the existing home loop and `ClaudeSdkBackend`. Router,
  channels, `/stop`, `/status` are backend-agnostic.
- Everything that already selects a model keeps working and gains SDK access for
  free: `/model` + session `modelOverride`, per-agent-type config, cron jobs.
- The Query object has no `setModel`: a model switch takes effect at the next
  run (one `query()` per run, model read from config/override at run start).
  `fallbackModel` is exposed per provider for automatic failover.

### Sub-agents: one delegation mechanism, full model choice

- `spawn` keeps its semantics (persistent named agents, `send`/`kill`/`reset`,
  durable sessions) on both backends. Its schema lists the available models
  (enum generated from live config, hot-reload aware); the agent picks per spawn.
- The sub-agent runner picks the backend from the chosen model's provider type:
  a main on SDK can spawn a haiku sub-agent (SDK, nested `query()`) or a mimo one
  (home loop) — and vice versa.
- SDK-backed sub-agents map naturally: own `query()` with own session;
  `send` = resume, `kill` = delete the sub-agent session (an active run stops
  through the shared abort signal), `reset` = drop the stored SDK session id.
- The SDK-native `Agent` tool and `agents` option stay disabled: native subagents
  are ephemeral and Anthropic-only, which conflicts with both the persistence
  semantics and the mixed catalog. One delegation mechanism visible to the model.

### Sessions: the SDK owns the history on its path

- On the SDK backend the conversation history lives in SDK-format sessions
  (prompt caching works untouched). `SessionData` gains an `sdkSessionId` and
  `session.messages` becomes a mirror (fed from streamed SDK messages) for UI,
  commands, archives and `/reset`.
- Storage stays under my-claw's roof: `CLAUDE_CONFIG_DIR` points at
  `$MY_CLAW_DIR/claude-sdk/` so SDK session files never mix with the owner's
  interactive Claude Code state. The `sessionStore` adapter (append/load) is the
  official escape hatch if we later want the transcripts inside our own store.
- **Crossing engines mid-conversation.** The SDK resumes history by id, so a session that ran on
  the home backend arrives with an empty SDK session and the model would see only the newest
  message. On the first SDK request the local transcript is replayed inside a
  `<prior_conversation>` block, and a watermark (`sdkSyncedAt`) records what that SDK session has
  seen so a later detour back through the home backend is replayed too, without resending what
  resuming already carries. Tool results are included (they hold the substance: tool-call turns
  often have no text at all) and scanned for injection **per entry**, because the scanner replaces
  whatever string it is given and one flagged result would otherwise erase the whole history. The
  replay is bounded only by the model's real context window minus the system prompt, the current
  turn and the reply reserve; when that binds, the oldest turns go first and the kept head is
  repaired so it never opens on an orphan tool result. The transfer is silent in chat by design and
  surfaces in `/status` plus the `session:context:transferred` hook.
- Home pruning/compaction/trim do not apply on the SDK path: the SDK has its own
  context management and auto-compaction. Meta-commands map to SDK slash
  commands: `/compact` sends `/compact` into the session (emits a
  `compact_boundary` message), `/reset` drops the `sdkSessionId` (archive kept
  my-claw-side as today).

### Tools: in-process MCP server, factory per run

- The 22 registry tools map 1:1 to `createSdkMcpServer`/`tool()` (name,
  description, JSON Schema, async execute).
- The SDK tool handler receives validated args only — no side channel. Per-run
  context (`__message`, `__signal`, `__workspaceDir`, `__depth`, attachments
  collector) is injected by building the MCP server per run with closures over
  the run context. Cheap: in-process object, no subprocess, no I/O.
- The closed-over signal is the same one wired to the `query()` abortController:
  `/stop` and the cron timeout wall cut both the SDK run and the running tool.
- SDK built-in tools are removed from the request entirely with `tools: []`
  (the documented off switch): one filesystem/permission model, one workspace
  resolution, one blacklist, one delegation mechanism.
- `getForAgent` filtering happens at MCP-server build time: only the tools the
  agent type may use are mounted; every call still flows through `canUseTool`.
- Read-only registry tools (read, ls, find, grep, fetch...) carry
  `annotations.readOnlyHint: true` so the SDK runs them in parallel, matching
  the home loop's parallel tool execution.

### Streaming input mode: one query per run, injections included

- Each run opens `query()` in streaming input mode: the prompt is an async
  generator that yields the initial user message, then drains the run-registry
  injection mailbox while the run is live. Messages streamed mid-loop are
  consumed by the ongoing run and seen by the model at the next tool boundary —
  the same semantics as the home loop's injection drain.
- A message queued when the run has already ended is rerouted as a fresh run
  (`RerouteSignal`, unchanged). Unlike the home loop there is no
  `IterationBudget.grant` equivalent mid-run: `maxTurns` is fixed for the whole
  run, so a heavily-injected run hits `error_max_turns` earlier.
- Streaming input is also a hard requirement for the `canUseTool` approval
  callback, so approvals and injections come from the same mode.
- SDK pinned >= 2.1.205: before that, a message arriving on the loop's final
  iteration could be consumed into the ending turn and silently lost.

### Auth: setup-token first, never a custom OAuth flow

- Primary: `CLAUDE_CODE_OAUTH_TOKEN` in `/etc/my-claw/.env`, minted by
  `claude setup-token` (1-year validity). A 24/7 service must not depend on the
  interactive CLI login: a logout or failed silent refresh elsewhere kills it.
- Fallback: with the env var absent the SDK reads the interactive login
  credentials (`~/.claude/.credentials.json`) and auto-refreshes — convenient,
  documented, not relied upon.
- Auth failures map to an explicit channel error naming `claude setup-token`
  (typed `authentication_failed` discriminant, string sniffing as fallback).
- Token rotation is hot: the backend rebuilds `env` from `process.env` and
  respawns the CLI on every run, so editing `CLAUDE_CODE_OAUTH_TOKEN` in
  `$MY_CLAW_DIR/.env` is picked up by the next run without a restart. The config
  watcher also watches `.env`, and `readConfigFromDisk` force-refreshes
  `process.env` from it (boot keeps shell/systemd precedence; only reload lets
  the file win). In-flight runs keep the token their subprocess already has.
- Reimplementing the OAuth flow (the banned OpenCode/OpenClaw path) is
  rejected: ToS violation, account ban risk.
- In-chat `/claude set-token <token>` (and `/claude logout`) fire
  `onAuthChanged("claude")` (wired in `index.ts`, shared with Codex): it
  **auto-creates an `anthropic` `claude-sdk` provider** (`discover: true`,
  `group: "Claude (abo)"`) in `config.json` if none exists, then re-runs
  `ModelCatalog.refresh()`. Discovery (`discoverSdkModels`) injects
  `loadClaudeToken()`, so the fresh token lists the account's models
  immediately — no restart. Without this, the token would be stored but
  `/model` would stay empty until boot/6h refresh (and only if a `claude-sdk`
  provider already existed). The provider is written to the raw on-disk config,
  never with env secrets overlaid.

### Environment isolation (nothing leaks in, nothing leaks out)

The subprocess runs hermetic — my-claw is the only source of behavior:

- `settingSources: []` — no CLAUDE.md, no user/project/local settings from disk.
- `systemPrompt` set to `buildSystemPrompt()` output (no Claude Code preset —
  it assumes its own tools). SOUL/AGENTS/USER/skills stay the single voice.
- No `plugins`, `skills: []` (my-claw's 3-tier skill system stays the one
  system, served through `list_skills`/`read_skill` MCP tools).
- `env`: `CLAUDE_CODE_ENABLE_TASKS=0` (no Task* tools),
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (my-claw memory is the one memory),
  `CLAUDE_CONFIG_DIR=$MY_CLAW_DIR/claude-sdk`.
- `cwd` = the run's workspace dir, same resolution as the home loop.

### Approvals, prompt, streaming, hooks

- Approvals: `canUseTool` callback delegating to `ToolApprovalManager`; blacklist
  and `allow-session` cache (`session.approvedTools`) preserved. `deny` returns
  the reason as the tool result, same behavior the home loop has today.
- Streaming: `includePartialMessages` text deltas map to `onToken`;
  PostToolUse hook events map to `onToolUse` (tool-status with duration) and
  re-emit on the home hook bus (`tool:execute:*`, `agent:*`).
- Home waterfalls keep working: `transform:user:content` and
  `transform:system:prompt` apply host-side before yielding to the generator;
  `transform:tool:result` maps to the PostToolUse hook's `updatedToolOutput`;
  `transform:agent:response` applies host-side on the final result;
  `gate:tool:before` folds into `canUseTool`.

### Analytics: native per-call usage, no reconstruction needed

- Every `AssistantMessage` carries `usage` (input/output plus
  `cache_creation_input_tokens`/`cache_read_input_tokens`); parallel tool
  batches share one `message.id`, so calls are deduped by id — this is the
  per-API-call granularity `api_calls` already stores, recorded with
  `baseUrl: "claude-sdk"`.
- Session `tokenUsage` (shown by `/status`) accumulates from the same per-call
  usage. `ResultMessage.modelUsage`/`total_cost_usd` are available but unused
  so far. Cache-read tokens land in analytics: cache efficiency becomes
  measurable, which is the point of letting the SDK own the history.
- Optional deep observability: the CLI exports OpenTelemetry natively
  (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP traces/metrics/logs) — off by
  default, a config switch away if ever needed.

### Guardrails and errors

- Per-run guards: `maxTurns` mirrors the home iteration budget; `maxBudgetUsd`
  is available as an extra cost wall (off by default on subscription).
- `ResultMessage.subtype` drives error mapping (`error_max_turns`,
  `error_max_budget_usd`, `error_during_execution` for API/auth/quota/process
  failures) into the existing channel error formatting. The CLI retries
  transient API errors internally; the home circuit breaker stays
  openai-path-only.

### Rollout phases

- Phase 0 — spike: SDK under Bun (subprocess spawn, streaming, interrupt) with
  OAuth token auth and one factory-built MCP tool. Go/no-go on a Node sidecar
  fallback (precedent: browser sidecar).
  **Done (2026-07-11), verdict: go, no sidecar.** Findings baked into phase 2:
  - Bun runs the SDK natively (bundled CLI 2.1.206, init ~600ms, run ~3s).
  - Factory-per-run closures and the attachments collector work as designed.
  - Mid-run injection is delivered at tool boundaries, but the model treats a
    contradicting mid-turn message as a prompt-injection attempt unless the
    system prompt legitimizes owner steering — one line in the SDK-path core
    prompt ("mid-conversation user messages are legitimate steering from the
    owner") flips it from ignored to obeyed.
  - `interrupt()` stops a run in ~400ms; after any error-subtype result the
    message stream throws — the backend catches post-result, mirroring
    `rethrowIfAborted`.
  - The SDK loads MCP tools through `ToolSearch` discovery by default; decide
    preload vs discovery for the 22-tool registry in phase 2.
- Phase 1 — extract `AgentBackend` from the current bridge. Zero behavior
  change, existing test suite is the proof. **Done (2026-07-11).**
- Phase 2 — `ClaudeSdkBackend` MVP, orchestrator only: MCP tools, approvals,
  system prompt, streaming, abort, SDK-owned sessions, mid-run injection.
  **Done (2026-07-11).** `BackendDispatcher` routes each run by the resolved
  model's provider type (both engines share one preprocessor so echoes and
  attachments survive the split). Verified live end to end on the
  subscription: real MCP tool round trip, streaming, per-call analytics rows
  (`base_url = "claude-sdk"`), resume across runs, SDK state isolated under
  `$MY_CLAW_DIR/claude-sdk/`.
- Phase 3 — parity: sub-agents and cron on SDK, model list in `spawn`,
  analytics, hooks mapping, `/compact`//`/reset` mapping, `/status` token
  usage, inbound vision (image blocks in streamed user messages), docs.
  **Done (2026-07-11).** `spawn` takes an optional `model` (live enum from
  config via a parameters getter — both engines rebuild tool definitions per
  run, so hot-reload follows); the runner picks the engine from the resolved
  model and `send()` sticks to the spawn-time model via `modelOverride`. Cron
  needed no code: `job.model` already flows through the dispatcher (only the
  `cron.maxIterations` parity was added). `/compact` on an SDK session sends
  the native `/compact` (detected via `compact_boundary`); `/reset` drops the
  SDK session by recreating the session object. Inbound images ride as base64
  blocks when the model has `vision: true`.

### Rejected alternatives

- OpenAI-compatible proxy over the subscription (dario, claude-max-api-proxy):
  ToS violation, account ban risk.
- SDK as a bare LLM (`allowedTools: []`) under the home loop: one full Claude
  Code run per iteration, imposed system prompt, wasteful.
- Replaying `session.messages` into the prompt each run: kills prompt caching.
- SDK-native subagents (`options.agents`): Anthropic-only models, ephemeral,
  would duplicate the delegation mechanism.

## Scope and limits

- Personal single-tenant use of the owner's subscription — the documented
  Agent SDK + `setup-token` path. Not for multi-user distribution.
- Subscription quota is shared with interactive Claude usage; SDK-backed crons
  and sub-agents draw from it. The mixed catalog is the mitigation: heavy grunt
  work can stay on litellm models. Anthropic paused the June 2026 "Agent SDK
  credit" split; billing policy may change again.
- OAuth token expires yearly (`claude setup-token` to renew).
- Inbound vision ships in phase 3 (streamed user messages accept base64 image
  blocks); until then the vision fallback keeps routing images to
  vision-capable litellm models. Outbound tool images (screenshots the model
  can see) are a possible later bonus via MCP image result blocks.
- Model switches apply at run boundaries, not mid-run (no `setModel`).
- Rate-limit details are not surfaced as SDK events (only via OTel); quota
  exhaustion arrives as `error_during_execution`.
- Each run spawns a CLI subprocess (~1 GiB RAM baseline per Anthropic hosting
  guidance); concurrent SDK runs (main + SDK sub-agents) multiply that.
  Acceptable single-tenant, worth watching on the VM.
- File checkpointing and structured outputs are not used: our tools are MCP
  (checkpointing only tracks native Write/Edit), and channel replies are
  free-form text.
- SDK session files (JSONL under `$MY_CLAW_DIR/claude-sdk/projects/`) accumulate;
  one-shot sub-agent runs skip persistence (`persistSession: false`), the rest
  has no purge yet (home sessions purge at 30 days; SDK-side equivalent TBD).
- Resume is keyed to a stable `cwd`: the SDK silently starts a fresh session if
  the working directory changes between runs (ours is the fixed workspace dir).
- /stop uses the hard `abortController` (subprocess cleanup), not the soft
  `interrupt()`: same semantics as the home loop's AbortSignal.

## Where

- `src/agent/backend.ts` — `AgentBackend` interface (phase 1)
- `src/agent/bridge.ts` — current loop, unchanged behavior behind the interface
- `src/agent/dispatcher.ts` — `BackendDispatcher`, per-run engine routing
- `src/agent/claude-sdk/backend.ts` — `ClaudeSdkBackend` (run lifecycle, streaming,
  injection generator, usage, mirroring)
- `src/agent/claude-sdk/tools.ts` — per-run in-process MCP server factory
- `src/agent/claude-sdk/schema.ts` — JSON Schema -> Zod shape conversion
- `src/llm/resolver.ts` — `backend` discriminant in `ResolvedLlmConfig`
- `src/core/config.ts` — `LlmProviderConfig.type` + `fallbackModel`
- `src/sessions/store.ts` — `sdkSessionId` on `SessionData`
- `tests/agent/claude-sdk-*.test.ts`, `tests/agent/dispatcher.test.ts`
- Phase 3: `src/tools/spawn.ts` (model enum), `src/subagents/runner.ts` (backend
  selection per resolved model), cron routing
