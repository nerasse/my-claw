# Configuration

## `~/.my-claw/config.json`

Single JSON file. jq-compatible. Loaded at boot.

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
    ]
  }
}
```

### Legacy format (auto-migrated on boot)

```json
{
  "llm": {
    "provider": "fireworks",
    "baseUrl": "https://api.fireworks.ai/inference/v1",
    "model": "accounts/fireworks/models/kimi-k2p5-turbo"
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
| `/models` | Matrix |

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
      "defaultModel": "accounts/fireworks/routers/kimi-k2p6-turbo"
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

## Other Sections

- `whitelist`: array of user IDs who can interact with the agent
- `blacklist`: array of tool names requiring approval (e.g. `["bash", "write"]`)
- `channels.telegram`: Telegram bot configuration
- `channels.matrix`: Matrix bot configuration
- `voice`: STT/TTS configuration
- `webSearch`: SearXNG search configuration
- `browser`: Browser automation configuration

See `docs/architecture.md` for full architecture details.
