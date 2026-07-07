# Configuration

## `~/.my-claw/config.json`

Single JSON file. jq-compatible. Loaded at boot, then **hot-reloaded** on change for safe sections
(LLM, agents, allowlists, channel behavioral fields, browser, web search, injection). Connection,
crypto, memory, voice, cron and workspace changes still require a restart. See
`docs/config-hot-reload.md`.

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

Sub-agents inherit the global `llm.providers`. You only need to specify a different model if desired:

```json
"agents": {
  "general": {
    "llm": {
      "defaultModel": "llama-3.3-70b-versatile"
    }
  },
  "research": {
    "llm": {
"defaultModel": "accounts/fireworks/models/kimi-k2p6-turbo"
    }
  }
}
```

If `defaultProvider` is omitted, the global `llm.defaultProvider` is used. If `defaultModel` is omitted, the global `llm.defaultModel` is used.

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
- `stt.language` — Whisper language code (default: `"fr"`).
- `tts.mode` — override for TTS. Cloud uses Edge TTS, local uses Piper.
- `tts.voice` — voice ID (Edge TTS voice name or Piper model name).

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
  "research": { "maxIterations": 50 }
}
```

- `maxIterations` — max tool-calling loops before forcing a summary response.
- `llm` — optional per-agent LLM config override (inherits providers from global `llm`).

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
