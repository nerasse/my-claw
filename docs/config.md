# Configuration

## `~/.my-claw/config.json`

Single JSON file. jq-compatible. Loaded at boot, then **hot-reloaded** on change for safe sections
(LLM, agents, allowlists, channel behavioral fields, browser, web search, injection). Connection,
crypto, memory, voice, cron and workspace changes still require a restart. See
`docs/config-hot-reload.md`.

Every version that ran is snapshotted, and a config that cannot be parsed -- or that starts but never
brings a channel up -- is reverted to the last one that worked, without ever rewriting your file.
`/config history`, `/config diff` and `/config rollback` (also `my-claw config ...` from a terminal)
browse and restore. `.env`, the workspace prompt files, custom skills, `tools.d/` and `cron/jobs.json`
are covered too. See `docs/config-backup.md`.

## LLM (Multi-Provider)

### New format (recommended)

```json
{
  "llm": {
    "defaultProvider": "fireworks",
    "defaultModel": "accounts/fireworks/routers/kimi-k2p6-turbo",
    "apiKey": "",
    "vision": true,
    "limit": {
      "context": 262000,
      "output": 64000
    },
    "providers": {
      "fireworks": {
        "baseUrl": "https://api.fireworks.ai/inference/v1",
        "apiKeyEnv": "FIREWORKS_API_KEY"
      },
      "groq": {
        "baseUrl": "https://api.groq.com/openai/v1",
        "apiKeyEnv": "GROQ_API_KEY",
        "headers": { "x-groq-foo": "bar" }
      },
      "custom": {
        "baseUrl": "http://192.168.1.50:8000/v1",
        "apiKeyEnv": "LOCAL_API_KEY"
      }
    },
    "models": [
      {
        "id": "accounts/fireworks/routers/kimi-k2p6-turbo",
        "label": "Kimi K2.6 Turbo",
        "provider": "fireworks",
        "vision": true,
        "limit": { "context": 262000, "output": 64000 }
      },
      {
        "id": "llama-3.3-70b-versatile",
        "label": "Llama 3.3 70B",
        "provider": "groq",
        "limit": { "context": 128000, "output": 32768 }
      }
    ],
    "visionFallback": "accounts/fireworks/routers/kimi-k2p6-turbo"
  }
}
```

`visionFallback` (optional): model id to reroute a run to when the incoming message carries
images and the resolved model (default or per-session override) has `vision: false`. The whole
run uses the fallback model so it can see the image in context. The target must be a declared
model with `vision: true`; otherwise the setting is ignored. Provider-agnostic: the switch
happens in my-claw before the request, so it works with any backend (proxy, direct API, local).

### Claude SDK provider (subscription)

A provider with `"type": "claude-sdk"` runs its models through the Claude Agent SDK on
the owner's Claude subscription instead of an OpenAI-compatible endpoint (full design:
`docs/claude-sdk-backend.md`). No `baseUrl`; auth is the `claude setup-token` token
(valid ~1 year). Manage it like Codex:
- Terminal: `myclaw claude login` wraps `claude setup-token` (browser/TTY) and stores the
  token; `myclaw claude status` / `logout`; `myclaw claude set-token <token>` to paste a
  token generated elsewhere.
- In-chat (DM only): `/claude set-token <token>`, `/claude status`, `/claude logout`.
  `/claude login` cannot run a browser OAuth from chat, so it replies with instructions.
The token is stored in `~/.my-claw/claude/auth.json` (mode `0600`) and injected into the
SDK subprocess per run (survives restarts; wins over any `CLAUDE_CODE_OAUTH_TOKEN` env).

```json
"providers": {
  "anthropic": { "type": "claude-sdk", "fallbackModel": "claude-haiku-4" }
},
"models": [
  { "id": "claude-sonnet-5", "label": "Sonnet", "provider": "anthropic", "vision": true }
]
```

- The engine follows the model: `/model claude-sonnet-5` moves a chat to the SDK,
  `/model <litellm model>` moves it back. Cron jobs (`model` on the job) and sub-agents
  (`model` on `spawn`) pick per run.
- On SDK-backed sessions the SDK owns the history (`/compact` maps to the SDK's own
  compaction; `/reset` starts a fresh SDK session). Home context pruning/auto-compaction
  do not apply there.
- `fallbackModel` (optional): SDK-side automatic failover if the primary model errors.
- Token rotation is hot: edit `CLAUDE_CODE_OAUTH_TOKEN` in `~/.my-claw/.env` and the
  next run uses it — no restart. The config watcher watches `.env` and a hot reload
  makes the file authoritative for `process.env` (at boot the shell/systemd env still
  wins). Channel tokens (Telegram/Matrix) also refresh in `process.env` but the live
  client keeps its connection until reboot.

### Codex provider (ChatGPT subscription)

A provider with `"type": "codex"` runs its models on the owner's ChatGPT Plus/Pro
subscription through the OpenAI Codex Responses backend, instead of a per-token API key
(full design: `docs/codex-backend.md`). It reuses the home agent loop with a Codex
transport; no `baseUrl` or `apiKeyEnv` needed (auth is the stored OAuth token).

```json
"providers": {
  "chatgpt": { "type": "codex", "discover": true, "group": "ChatGPT (abo)" }
},
"models": [
  { "id": "gpt-5.6-sol", "label": "GPT-5.6 Sol", "provider": "chatgpt" }
]
```

- Login (device-code, headless-friendly). Two ways:
  - Terminal: `myclaw codex login` (or `bun run <entry> codex login`) — open the shown
    URL, enter the code. Also `myclaw codex status` / `logout`.
  - In-chat (DM only): `/codex login` — the bot posts the URL + code and confirms in the
    same chat once approved. Also `/codex status`, `/codex logout`.
  Tokens are stored in `~/.my-claw/codex/auth.json` (mode `0600`) and auto-refreshed; a
  login done in the terminal is picked up by the running service on the next request (no
  restart, the token file is read fresh).
- The engine follows the model, exactly like the Claude SDK path: `/model gpt-5.6-sol`
  moves a chat onto Codex, `/model <other>` moves it back. Effort is native (reasoning
  models): `/effort high` sends `reasoning.effort`.
- `discover: true` lists the subscription's models from the Codex backend (best-effort;
  requires a prior login), with their display names and per-model reasoning levels.
  ChatGPT-account model slugs are e.g. `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.4` (not the
  API-only `gpt-5-codex`). Curated `models[]` entries work without discovery.

### Legacy format (auto-migrated on boot)

```json
{
  "llm": {
    "provider": "fireworks",
    "baseUrl": "https://api.fireworks.ai/inference/v1",
    "model": "accounts/fireworks/models/kimi-k2p6-turbo"
  }
}
```

Migrates automatically to the new format internally. No manual action needed.

## Tool gating (`tools`)

```json
"tools": { "disabled": ["browser", "cron"], "pluginsEnabled": false }
```

- `disabled`: denylist of tool names filtered out of every agent's tool set. Absent or empty
  means everything is on, so new built-in tools are enabled by default. Hot-reloadable (read
  live per run); disabling a tool takes effect on the next message. Only toggles
  already-registered tools. MCP tools can be disabled by their full namespaced name
  (`mcp__<server>__<tool>`).
- `pluginsEnabled` (default `false`): load owner-authored tool modules from
  `$MY_CLAW_DIR/tools.d/` at runtime. Off by default because loading arbitrary code is an
  in-process RCE surface. Each module exports `tool` (or `default`) as
  `{ name, description, parameters?, execute(args) }`; the shape is validated, names that
  collide with a built-in are skipped, and a throwing plugin is isolated (never crashes the
  process). Editing a file in `tools.d/` hot-reloads it. See `docs/hot-reload-extensions.md` (A5).

## Browser (`browser`)

```json
"browser": {
  "enabled": true,
  "sidecarUrl": "http://127.0.0.1:9223",
  "novncUrl": "http://localhost:6080",
  "viewport": { "width": 1920, "height": 1080 },
  "maxSteps": 60,
  "allowEval": false,
  "allowCdp": false,
  "cdpAllowlist": ["DOM.*", "Input.*", "Runtime.evaluate"],
  "downloadDir": "~/.my-claw/workspace/downloads",
  "timeoutsMs": { "default": 30000, "navigate": 45000 }
}
```

- `enabled` (default `true`): read live, so `delegate_browser_task` can be turned off without a
  restart.
- `sidecarUrl` / `novncUrl`: where the Node sidecar and the live-browser view are reachable.
- `maxSteps` (default 60): step budget of one browsing task. The subagent walks an escalation
  ladder rather than asking for a human, which costs steps on purpose.
- `allowEval` / `allowCdp` (default `false`): register `browser_eval` and `browser_cdp`. Off by
  default because the subagent reads untrusted page content, so these widen the prompt-injection
  surface; `browser_eval` also implies access to non-`HttpOnly` cookies. Every call is written to
  the audit log. When disabled the tools are not registered at all and are absent from the
  subagent prompt.
- `cdpAllowlist`: glob patterns, replacing the default list entirely when set. The sidecar's own
  denylist (`Browser.*`, `Target.*`, `Storage.*`, `Security.*`, `Fetch.*`, `Network` cookie and
  header methods) is always enforced on top and cannot be opened up from config.
- `downloadDir` (default `<workspace>/downloads`): where `browser_download` saves files. Keep it
  inside the workspace for the agent to be able to `read` them afterwards.
- `timeoutsMs`: HTTP budget per sidecar endpoint (`navigate`, `upload`, `select-option`,
  `wait-for`, `download-wait`, `pdf`, `screenshot`) plus `default`.

Hot-reloadable as a whole. Details and rationale in `docs/browser.md`.

## Skills (`skills`)

```json
"skills": { "suggest": { "enabled": true, "minScore": 0.35, "topK": 5 } }
```

On top of the always-present skill catalog in the system prompt, `suggest` appends a short soft
"possibly relevant" reminder at the very end of the prompt for the skills that best match the
incoming message (semantic ranking via `memory.embedding` when configured and warm, keyword
fallback otherwise). Hot-reloadable (read live per run).

- `enabled` (default `true`) — keyword fallback needs no embedding setup.
- `minScore` (default `0.35`) — minimum cosine similarity in semantic mode; ignored by the keyword
  fallback.
- `topK` — omit for a dynamic cap that scales with the registry (`clamp(round(N*0.5), 5, 15)`), or
  pin an explicit ceiling.

Full details in `docs/skill-suggestions.md`.

## External MCP servers (`mcp`)

Declare external [Model Context Protocol](https://modelcontextprotocol.io) servers; their
tools become available to the agent on both backends (home loop and Claude SDK), exposed
as `mcp__<server>__<tool>`. See `docs/hot-reload-extensions.md`.

```json
"mcp": {
  "filesystem": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
    "env": { "FOO": "bar" }
  },
  "weather": {
    "transport": "http",
    "url": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer ..." }
  }
}
```

- `transport`: `stdio` (spawn a child process via `command`/`args`/`env`), `sse`, or
  `http` (Streamable HTTP; `url`/`headers`).
- `enabled` (optional): set `false` to declare but not connect a server.
- Hot-reloadable: adding, removing, disabling, or re-wiring a server (re)connects it on
  the next config save — no restart. A stdio server is spawned once and shared by both
  backends. External MCP tools are not exposed to the read-only `research` sub-agent.

### API Key Resolution

Env vars are loaded from `~/.my-claw/.env` at boot. Use the same name in `.env` as in `config.json` `apiKeyEnv`.

Priority (highest first):

1. `config.llm.apiKey` (global key — legacy mode only)
2. `process.env[provider.apiKeyEnv]` (provider-specific env var)
3. `process.env.FIREWORKS_API_KEY` (fallback for legacy configs)
4. `process.env.OPENAI_API_KEY` (fallback for legacy configs)

Example:
```json
"providers": {
  "fireworks": {
    "baseUrl": "https://api.fireworks.ai/inference/v1",
    "apiKeyEnv": "FIREWORKS_API_KEY"
  }
}
```

```bash
# ~/.my-claw/.env
FIREWORKS_API_KEY=sk-...
```

### Model Switching

Runtime switch via channel commands:

| Command | Works on |
|---|---|
| `/model` | Telegram, Matrix |
| `/model <name>` | Telegram, Matrix |
| `/models` | Telegram, Matrix |

Search works on `id`, `label`, and the tail segment after the last `/`.

Examples:
```
/model llama-3.3-70b-versatile
/model "Llama 3.3 70B"
/model 70b
```

### Grouping models into a submenu

Give models an optional `group` label to collapse them behind a single submenu entry in
`/model` (keeps the root menu short when a provider exposes many models). Models without a
`group` stay at the root; `/model <name>` and `/models` still reach every model directly.

```json
"models": [
  { "id": "mimo-v2.5-pro", "label": "MiMo v2.5 Pro", "provider": "litellm" },
  { "id": "claude-sonnet-5", "label": "Sonnet", "provider": "anthropic", "group": "Claude (abo)" },
  { "id": "opus",  "label": "Opus",  "provider": "anthropic", "group": "Claude (abo)" },
  { "id": "haiku", "label": "Haiku", "provider": "anthropic", "group": "Claude (abo)" },
  { "id": "fable", "label": "Fable", "provider": "anthropic", "group": "Claude (abo)" }
]
```

The root menu shows `MiMo v2.5 Pro` and a `Claude (abo) >` entry; tapping it opens the group
(with a `< Back` entry). On Matrix the same levels work via reactions and number/name replies.
The Claude Agent SDK accepts both aliases (`sonnet`, `opus`, `haiku`, `fable`) and full ids
(`claude-sonnet-5`, `claude-opus-4-8`); availability depends on your subscription.

A `"/"`-separated `group` nests submenus, e.g. a version picker `Claude > Opus > [Latest / 4.8]`.
Discovery builds exactly this shape on its own for a `claude-sdk` provider (see
`docs/model-discovery.md`), so curated entries are only needed to override what it produces:

```json
"models": [
  { "id": "opus",            "label": "Latest", "provider": "anthropic", "group": "Claude/Opus" },
  { "id": "claude-opus-4-8", "label": "4.8",    "provider": "anthropic", "group": "Claude/Opus" },
  { "id": "sonnet",          "label": "Latest", "provider": "anthropic", "group": "Claude/Sonnet" },
  { "id": "haiku",           "label": "Haiku",  "provider": "anthropic", "group": "Claude" }
]
```

### Reasoning effort

Effort controls how much the model thinks. Native on the Claude Agent SDK (query `effort`)
and on Codex models (sent as `reasoning.effort`); sent as `reasoning_effort` to other
OpenAI-compatible providers **only** when the model sets `supportsEffort: true` (avoids 400s
on providers that reject the param).

- Levels: `low`, `medium`, `high`, `xhigh`, `max`, `ultra` (SDK default is `high`). This is the
  superset across providers; `ultra` is Codex-only, and the Claude SDK clamps it to `max`.
- The effort submenu shows only the levels the selected model actually supports, taken from the
  provider's own capabilities (`supportedEffortLevels`). A model the provider reports as having no
  effort at all (`supportsEffort: false`, e.g. Haiku 4.5) offers none and is not chained into the
  effort step. Only a model with **unknown** support (neither field set, typically a curated entry)
  falls back to the full global list.
- Precedence: session `/effort` > per-model `effort` > global `llm.effort`.
- The `/model`, `/models` and `/effort` headers show the **effective** effort with its origin:
  `high (session)`, `medium (model default)`, `low (config)`, `high (SDK default)`, or
  `provider default (nothing sent)`. The origin matters, because "high because you asked for it"
  and "high because the SDK falls back to it" are different answers. Only the Claude SDK documents
  its own fallback (`high`); Codex and opt-in OpenAI-compatible providers do not, so nothing is
  named for them rather than guessed.
- The effort line and the `Effort >` entry are **hidden** when the current model discards effort
  (an OpenAI-compatible model without `supportsEffort`, or one the provider reports as
  `supportsEffort: false`), and `/effort` answers `Effort has no effect on <model>`. Both used to
  show up for every model as soon as any model supported effort, advertising a setting that could
  not take effect. `ModelPicker.syncFromConfig` is the single place that resolves this, since the
  answer depends on the backend and the picker cannot see it.
- Selecting a model in `/model` chains straight into the effort choice (levels + a
  `Keep current` entry), so model + effort is one flow with no back-and-forth. The root
  `/model` menu also shows an `Effort >` entry to adjust effort without re-selecting a model;
  alternatively, `/effort` and `/effort <level>` work as a quick standalone shortcut. A model that
  discards effort is never chained into the step.

```json
"llm": {
  "effort": "high",
  "models": [
    { "id": "claude-sonnet-5", "label": "Sonnet", "provider": "anthropic" },
    { "id": "grok-reasoner", "label": "Grok", "provider": "litellm", "supportsEffort": true, "effort": "medium" }
  ]
}
```

### Model discovery

Set `discover: true` on a provider to auto-populate its models at runtime instead of listing
them by hand. `type: "claude-sdk"` providers use the SDK's `supportedModels()` (subscription
OAuth); OpenAI-compatible providers use `GET {baseUrl}/models`. Discovered models merge with
`config.models` (config wins on id collision) and land under the provider's `group` label.

```json
"providers": {
  "litellm":   { "baseUrl": "https://litellm.example/v1", "apiKeyEnv": "LITELLM_API_KEY", "discover": true, "group": "LiteLLM" },
  "anthropic": { "type": "claude-sdk", "discover": true, "group": "Claude (abo)" }
}
```

Discovery is cached to `~/.my-claw/model-catalog.json`, refreshed at boot + every 6h + on config
edit, and falls back to the last known list when a provider is unreachable. Full details in
`docs/model-discovery.md`.

### Prompt caching

Set `promptCache: true` on an OpenAI-compatible provider whose endpoint honors Anthropic-style
`cache_control` (proxies like LiteLLM and OpenRouter) to cache the stable system+tools prefix and
cut input-token cost on long tool-calling runs. Opt-in per provider because some strict endpoints
reject unknown fields in message content; ignored on `claude-sdk` (SDK caches itself) and `codex`
(subscription) backends.

```json
"providers": {
  "litellm":    { "baseUrl": "https://litellm.example/v1", "apiKeyEnv": "LITELLM_API_KEY", "promptCache": true },
  "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY", "promptCache": true }
}
```

Full details (breakpoint placement, what actually gets cached, cost model) in `docs/prompt-caching.md`.

Cache hits are now measured: `/status` reports them per model, and cost is computed at the cache
rate rather than the full one -- often two orders of magnitude apart.

### Pricing provider

`pricingProvider` names the [models.dev](https://models.dev) provider whose prices apply to an
endpoint, for `/status` cost reporting only. It is an escape hatch and normally stays unset: a
proxy that reports its own cost or its upstream in response headers (LiteLLM does both) is resolved
without it, and so is any endpoint whose host matches a known provider.

```json
"providers": {
  "myproxy": { "baseUrl": "https://proxy.example/v1", "apiKeyEnv": "PROXY_KEY", "pricingProvider": "xiaomi" }
}
```

Without it, such an endpoint falls back to the median market price, reported as an estimate. See
`docs/status-command.md`.

### Provider-Specific Headers

Add custom headers per provider:

```json
"providers": {
  "anthropic": {
    "baseUrl": "https://api.anthropic.com/v1",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "headers": { "anthropic-version": "2023-06-01" }
  }
}
```

### Per-Agent Model

Every agent inherits the global `llm.providers`; an entry is only needed to pin a different model.
Settable from chat with `/model <agent>` (`docs/agent-model.md`), which writes this exact shape.

```json
"agents": {
  "orchestrator": { "llm": { "defaultModel": "claude-opus-5", "defaultProvider": "anthropic" } },
  "general":      { "llm": { "defaultModel": "llama-3.3-70b-versatile" } },
  "research":     { "llm": { "defaultModel": "mimo-v2.5" } },
  "cron":         { "llm": { "defaultModel": "mimo-v2.5-pro" } }
}
```

Precedence for one run: the session's own `/model` first, then the agent's `defaultModel`, then the
global `llm.defaultModel`. A per-chat choice is never overruled by a config edit.

If `defaultProvider` is omitted the model's own `provider` field decides, then the global
`llm.defaultProvider`. Writing it explicitly is what `/model <agent>` does, because most models come
from provider discovery and are absent from this file: with the discovery endpoint down after a
restart, an id alone would resolve against whatever `llm.defaultProvider` happens to be.

`cron` inherits `orchestrator` when it has no entry. `general` and `research` do not: their absent
entry means the global default, not whatever the owner picked for his own chats.

### Per-Agent Skills and MCP Servers

`skills` and `mcp` narrow what an agent sees. Full spec: `docs/agent-scoping.md`.

```json
"agents": {
  "orchestrator": { "skills": ["*"], "mcp": ["*"] },
  "general":      { "skills": ["forgejo", "nextcloud"], "mcp": ["mailcow"] },
  "research":     { "skills": ["web-browsing"], "mcp": [] }
}
```

- Entries are **exact names**, or the single entry `["*"]` for all. No prefix globs: a renamed skill
  would silently change scope.
- An **absent** field inherits the orchestrator's; absent there too means all. So a config without
  these fields behaves exactly as before.
- `[]` means **none**, and is never read as "unset". `skills: []` gives that agent no skills at all.
- The orchestrator's own list restricts the orchestrator, it is not merely a value children inherit.
- `cron` has its own optional entry; when absent it inherits the orchestrator.
- **Exception, `research.mcp`:** an absent field resolves to `[]`, not to the orchestrator's list.
  The research agent had zero MCP servers before this existed, so inheriting `["*"]` would hand it
  every server on upgrade. Only an explicit `agents.research.mcp` grants it servers.
- Granting MCP to `research` **ends the "read-only research agent" guarantee**: its built-in tools
  are a read-only allowlist, but an MCP server's tools are arbitrary and may write.
- The scope binds visibility *and* execution: the prompt catalog, `list_skills` and `read_skill` all
  agree, and out-of-scope MCP tools are not exposed. It scopes the skill system, not the filesystem —
  `read` can still open a `SKILL.md` by path.
- A name matching no installed skill and no declared MCP server is reported to the owner at boot and
  logged at `warn`. It never blocks a boot.

`agents` is a hot section, so a scope edit lands on the next message with no restart.

### Inspecting it from chat

Four commands on every channel, all accepting an optional agent (`orchestrator`/`main`, `general`,
`research`, `cron`, or a live `subagent/<name>-<hex>` id, which resolves through its type since scope
is per type). No argument means the orchestrator, and an unknown name lists the accepted values.

- `/skills [agent]` — the skills that agent sees, with its scope, whether it can write skills
  (`manage_skills` is orchestrator-only), and any configured name matching no installed skill.
- `/agents` — the three configured types with iterations, model, tool class and both scopes; then
  `cron` (inherits the orchestrator when it has no entry of its own); then the live sub-agents; then the browser
  sub-agent, which is hardcoded, has no skills or MCP, and is invisible to `list_agents`.
- `/mcp [agent]` — every **declared** server with its state (`connected`/`disabled`/`failed`, with the
  connect error), marked in or out of that agent's scope. A failed server stays listed, which is the
  point: it used to be logged and dropped. Warns when `research` has servers.
- `/instructions [agent]` — the composed system prompt as a `.md` attachment plus a summary. Shown as
  actually sent: the `transform:system:prompt` hook is applied and the SDK steering note is appended
  for a `claude-sdk` agent. A `cron` dump has no platform-hint layer, because a cron run has no
  channel. Two things a static dump cannot reproduce, and the summary says so: the suggested-skills
  layer depends on the message text, and nested `AGENTS.md` are injected into tool results during a
  run rather than into the prompt.

## Context Limits

Per-model or global `limit` controls context window and output cap:

```json
{
  "llm": {
    "limit": {
      "context": 128000,
      "output": 8192
    },
    "models": [
      {
        "id": "accounts/fireworks/models/kimi-k2p6-turbo",
        "label": "Kimi K2.6",
        "provider": "fireworks",
        "limit": { "context": 262144, "output": 65536 }
      }
    ]
  }
}
```

- `limit.context` — max tokens for the full prompt (system + messages + tools). When exceeded, old messages are auto-trimmed (head preserved, middle dropped, tail preserved, tool pairs kept intact). Estimation: 4 chars/token, 15% safety margin.
- `limit.output` — sent as `max_tokens` to the provider.
- Per-model `limit` overrides the global `limit`.

## Analytics

Every LLM API call is logged to `~/.my-claw/analytics.db` (SQLite, WAL mode).

**Table `api_calls`**: `timestamp`, `session_id`, `platform`, `model`, `base_url`, `streaming`, `caller` (orchestrator/subagent/compaction/browser), `prompt_tokens`, `completion_tokens`, `total_tokens`, `tool_calls`, `iteration`, `duration_ms`, `error`.

Query with `sqlite3`:
```bash
# tokens per day
sqlite3 ~/.my-claw/analytics.db "SELECT date(timestamp) d, sum(total_tokens) t, count(*) c FROM api_calls GROUP BY d"

# by model
sqlite3 ~/.my-claw/analytics.db "SELECT model, sum(total_tokens), count(*) FROM api_calls GROUP BY model"

# avg latency by caller
sqlite3 ~/.my-claw/analytics.db "SELECT caller, avg(duration_ms), count(*) FROM api_calls GROUP BY caller"
```

## Whitelist & Blacklist

```json
{
  "whitelist": ["123456789", "@user:matrix.org"],
  "blacklist": ["bash", "write"]
}
```

- `whitelist` — User IDs allowed to interact. Telegram: numeric IDs. Matrix: `@user:server` format (auto-normalized at boot).
- `blacklist` — Tool names requiring approval before execution. Approval is **strictly opt-in**:
  an empty blacklist means full autonomy (no tool ever asks, by design — the app runs in its own
  encapsulated VM). When blacklisted, `bash` and `memory` are re-confirmed on every call
  (never session-cached); other tools support "allow for session".

## Channels

### Telegram

```json
"channels": {
  "telegram": {
    "enabled": true,
    "token": "BOT_TOKEN",
    "mode": "polling",
    "dm": { "enabled": true, "policy": "allowlist", "allowFrom": ["123"] },
    "groupPolicy": "allowlist",
    "groupAllowFrom": ["123"],
    "groups": { "-100123": { "enabled": true, "requireMention": true } },
    "streaming": { "enabled": true, "minChars": 30, "throttleMs": 1000 },
    "reactions": { "enabled": true },
    "threadReplies": "inbound",
    "replyToMode": "first",
    "historyLimit": 10,
    "errorPolicy": "once"
  }
}
```

Key fields:
- `mode` — `"polling"` or `"webhook"`. Webhook requires `webhook.url`, `webhook.secret`, `webhook.port`.
- `dm.policy` — `"open"` (anyone), `"allowlist"` (only `dm.allowFrom`), `"disabled"`.
- `groupPolicy` — same as dm.policy but for groups.
- `groups` — per-group config keyed by chat ID. `"*"` matches all groups.
- `requireMention` — group messages only routed when bot is mentioned.
- `streaming` — live token streaming via message edits.
- `reactions` — emoji feedback on messages (received/thinking/tool_use/done/error).
- `threadReplies` — `"off"`, `"inbound"` (reply in thread if user is in thread), `"always"`.
- `replyToMode` — `"off"`, `"first"` (reply to first chunk only), `"all"`.
- `errorPolicy` — `"always"` (report every error), `"once"` (one per session), `"silent"`.

### Matrix

```json
"channels": {
  "matrix": {
    "enabled": true,
    "homeserver": "https://matrix.org",
    "accessToken": "syt_...",
    "userId": "@bot:matrix.org",
    "deviceId": "ABCDEF",
    "encryption": true,
    "dm": { "enabled": true, "policy": "allowlist", "allowFrom": ["@user:matrix.org"] },
    "groupPolicy": "allowlist",
    "groups": { "!room:matrix.org": { "enabled": true, "requireMention": true } },
    "streaming": { "enabled": true, "minChars": 30, "throttleMs": 1000 },
    "reactions": { "enabled": true },
    "contextVisibility": "all",
    "errorPolicy": "once"
  }
}
```

Additional Matrix fields:
- `encryption` — enable E2EE (requires `userId` + `deviceId`).
- `contextVisibility` — `"all"` (include all room context), `"allowlist"` (only allowed senders), `"allowlist_quote"` (allowlist + quoted replies from anyone).
- `displayName` — override bot display name for mention detection.
- `autoJoin` — `"off"`, `"always"`, or use `autoJoinAllowlist`.

## Voice

```json
"voice": {
  "mode": "auto",
  "stt": { "mode": "cloud", "echoTranscript": true, "language": "fr" },
  "tts": { "mode": "cloud", "voice": "fr-FR-RemyMultilingualNeural" }
}
```

- `mode` — global default: `"cloud"`, `"local"`, `"auto"` (cloud if credentials available, local otherwise).
- `stt.mode` — override for STT. Cloud uses Groq Whisper, local uses faster-whisper at `FASTER_WHISPER_ENDPOINT`.
- `stt.echoTranscript` — send transcription as reply before routing (default: true).
- `stt.language` — Whisper language code. **No default: absent means auto-detect**, and it
  applies to the owner's voice notes only. Other audio files are always auto-detected, since
  forcing the wrong language makes Whisper emit confident nonsense rather than an error. The
  `stt` tool takes a per-call `language` for the cases the agent is sure about.
- `tts.mode` — override for TTS. Cloud uses Edge TTS, local uses Piper.
- `tts.voice` — voice ID (Edge TTS voice name or Piper model name).

### Tests

- **Unit**: `tests/tools/voice-tools.test.ts` (stub pipeline: argument forwarding, attachment
  and error mapping), `tests/voice/stt-groq.test.ts`, `tests/voice/stt.test.ts` (failure paths,
  no network — the file read fails before the request).
- **E2E**, real binaries and real network, so they never run in CI: `tests-e2e/voice/tts.test.ts`
  spawns edge-tts/piper (`VOICE_E2E=1`), `tests-e2e/voice/stt-language.test.ts` synthesizes
  speech then transcribes it through Groq (`VOICE_E2E=1` + `GROQ_API_KEY`). Run them by hand
  after touching the voice pipeline.

## Web Search

```json
"webSearch": {
  "baseUrl": "https://search.example.com",
  "token": "",
  "language": "fr"
}
```

- `baseUrl` — SearXNG instance URL. Required to enable the `web_search` tool.
- `token` — optional Bearer token for authenticated instances.
- `language` — default search language (default: `"fr"`).

## Browser

```json
"browser": {
  "enabled": false,
  "sidecarUrl": "http://127.0.0.1:9223",
  "novncUrl": "http://localhost:6080",
  "viewport": { "width": 1920, "height": 1080 },
  "maxSteps": 30
}
```

- `enabled` — enable the `delegate_browser_task` tool (default: true).
- `sidecarUrl` — where the app reaches the Node browser sidecar (default `http://127.0.0.1:9223`). Playwright runs in that sidecar because `connectOverCDP` hangs under Bun. See `browser.md`. The Chromium CDP endpoint itself is set via the sidecar's `CDP_URL` env, not here.
- `novncUrl` — live-browser URL surfaced to the user on a human-handoff (default `http://localhost:6080`).
- `viewport` — browser viewport size.
- `maxSteps` — max LLM iterations for the browser sub-agent (default: 30).

Tabs are persistent and never auto-closed (the shared browser stays open for reuse across tasks).

## Agents

```json
"agents": {
  "orchestrator": { "maxIterations": 90 },
  "general": { "maxIterations": 50, "llm": { "defaultModel": "llama-3.3-70b" } },
  "research": { "maxIterations": 50 },
  "nested": { "enabled": true, "maxBytes": 32768 }
}
```

- `maxIterations` — max tool-calling loops before forcing a summary response.
- `llm` — optional per-agent LLM config override (inherits providers from global `llm`).
- `nested` — lazy nested `AGENTS.md` discovery. When a tool operates in a subtree (file
  tools via their `path`, `bash` via its `workdir`), the `AGENTS.md` files from the git
  root down to that directory are injected into that tool's result, closest last. The
  workspace-root `AGENTS.md` is excluded (already in the system prompt) and external files
  are normalised (invisible characters stripped, see `docs/untrusted-content.md`). `enabled` (default true) toggles it; `maxBytes` (default
  32768) caps the total nested content injected per run. See `docs/nested-agents.md`.

## Context

```json
"context": {
  "pruning": { "enabled": true, "keepLastAssistantTurns": 5, "headChars": 200 },
  "autoCompact": { "enabled": true, "thresholdRatio": 0.8 },
  "cap": 512000,
  "capExempt": ["claude-*", "Qwen3.6-*"]
}
```

Context weight management for long sessions (see `docs/context-pruning.md` and
`docs/context-window.md`). Every stage defaults to enabled; the whole section is optional and
hot-reloadable.

- `pruning` — at prompt-build time, tool results older than the last
  `keepLastAssistantTurns` assistant turns (default 5) are replaced by their first
  `headChars` chars (default 200) plus a marker. The persisted session keeps full outputs;
  the agent can re-run a tool to recover anything pruned.
- `autoCompact` — at run start (main agent only), if the occupied history exceeds
  `thresholdRatio` (default 0.8) of the effective context window, the session is compacted
  with the same LLM summarization as `/compact`. "Occupied" is the prompt size the provider
  last billed plus an estimate of the turns since, not a plain `chars/4` count: the estimate
  under-counts by roughly 2.3x on real traffic, which made the gate fire far too late.
- `cap` — ceiling applied to every resolved context window, **active at 512 000 without
  configuration**. A provider allowing 1M does not mean we agree to send 1M: long contexts
  degrade attention and bill linearly. Set `0` to disable the ceiling entirely. The cap never
  raises a window, only lowers it.
- `capExempt` — glob patterns matched against the model id (anchored, case-insensitive). A
  match uses the model's full window. Patterns rather than exact ids so one line can cover a
  self-hosted family with a dozen quantisation variants.

A `limit.context` declared on a model in `llm.models` **is still capped**: the cap is
unconditionally the last step, and `capExempt` is the only way past it. One rule rather than a
precedence table. A single conversation can opt out for itself, which wins over both.

Windows that no model declares and discovery does not report are filled in from the models.dev
table (98% coverage of 6 044 models), and `/status` names the source so a surprising number can
be traced. Anything still unresolved falls back to 262 144.

## Cron

```json
"cron": {
  "enabled": true,
  "tickIntervalMs": 60000,
  "maxIterations": 90,
  "timeoutMs": 1800000
}
```

- `enabled` — run the scheduler (default: true).
- `tickIntervalMs` — how often the scheduler checks for due jobs (default: 60000).
- `timeoutMs` — hard wall-clock limit per job; on expiry the run is aborted and the job is
  marked failed. Default is deliberately long (1800000 = 30 min) so heavy/voluminous jobs can
  finish; it only kills genuine runaways. See `cron.md`.
- `maxIterations` — tool-calling loop budget for cron runs (defaults to the orchestrator's 90).
  Raise it for jobs that legitimately need many steps.

## Memory

```json
"memory": {
  "enabled": true,
  "consolidation": { "enabled": true, "every": 20 },
  "embedding": { "backend": "local", "model": "Xenova/multilingual-e5-large" }
}
```

- `enabled` — master switch (default: true).
- `embedding` — optional. Omit for FTS5-only keyword recall (zero-config, no download/key). `backend: "local"` runs in-process via transformers.js; `backend: "http"` hits any OpenAI-compatible `/embeddings` endpoint (also set `baseUrl` and `apiKeyEnv`).
- `consolidation.every` — writes between background merge passes (default: 20). `consolidation.model` overrides the merge LLM (default: main agent).
- `recallMaxEntries` (5), `recallMaxChars` (2000), `ftsCandidates` (20), `supersededRetentionDays` (365).

See `docs/memory.md` for design rationale.
