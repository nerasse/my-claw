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

Priority (highest first):

1. `config.llm.apiKey` (global key)
2. `process.env[provider.apiKeyEnv]` (provider-specific env var)
3. `process.env.FIREWORKS_API_KEY` (legacy fallback)
4. `process.env.OPENAI_API_KEY` (legacy fallback)

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

### Per-Agent Provider

Sub-agents can target different providers:

```json
"agents": {
  "general": {
    "llm": {
      "defaultProvider": "groq",
      "defaultModel": "llama-3.3-70b-versatile",
      "providers": { ... }
    }
  },
  "research": {
    "llm": {
      "defaultProvider": "fireworks",
      "defaultModel": "accounts/fireworks/routers/kimi-k2p6-turbo",
      "providers": { ... }
    }
  }
}
```

If `providers` is omitted in an agent config, the main `llm.providers` is used.

## Other Sections

- `whitelist`: array of user IDs who can interact with the agent
- `blacklist`: array of tool names requiring approval (e.g. `["bash", "write"]`)
- `channels.telegram`: Telegram bot configuration
- `channels.matrix`: Matrix bot configuration
- `voice`: STT/TTS configuration
- `webSearch`: SearXNG search configuration
- `browser`: Browser automation configuration

See `docs/architecture.md` for full architecture details.
