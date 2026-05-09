# Telegram Implementation Plan

> **Phase 1: COMPLETE** — See `docs/platform-features.md` for platform comparison and implementation details.
> **Phase 2: COMPLETE** — See `docs/plan/telegram-phase2.md` for detailed plan and `tests/` for coverage.

## Overview

Implement the Telegram channel adapter for my-claw using grammy, with support for
both long polling and webhook modes. Based on patterns from OpenClaw's Telegram
extension, stripped down to what we actually need.

## Library

- `grammy` — Telegram Bot API framework for TypeScript
- `@grammyjs/runner` — for webhook/polling runner
- `@grammyjs/transformer-throttler` — API rate limiting

## Connection Modes

### Long Polling (default, dev)
- `bot.start()` — no infra needed, just internet
- Good for dev and personal VM usage

### Webhook (production)
- Telegram pushes updates to an HTTPS endpoint
- Requires: domain, SSL cert (or reverse proxy like nginx/caddy)
- Config: webhook url, secret, port
- Bun native HTTP server to receive updates
- grammy's `webhookCallback()` to process updates

### Config decides which mode
```json
{
  "channels": {
    "telegram": {
      "token": "BOT_TOKEN",
      "mode": "polling",
      "webhook": {
        "url": "https://example.com/telegram/webhook",
        "secret": "random-secret",
        "port": 8443
      }
    }
  }
}
```

## Feature Set

### Phase 1 — Core

| Feature | Description | Source |
|---|---|---|
| Text messages | Receive and send text | grammy basics |
| Auth (whitelist) | Only authorized users | our auth.ts |
| Markdown → HTML | Convert agent markdown to Telegram HTML | adapted from OpenClaw format.ts |
| Message splitting | Split > 4000 chars, HTML-tag-aware | adapted from OpenClaw send.ts |
| Text batching | Debounce 1s for split messages from Telegram | adapted from OpenClaw |
| Long polling | `bot.start()` | grammy |
| Webhook | Bun HTTP server + `webhookCallback()` | grammy |
| Typing indicator | `sendChatAction("typing")` while processing | grammy |
| Media in | photo, voice, audio, video, document → download, pass as attachment | grammy |
| Media out | MEDIA:/path → route by extension (sendPhoto/Voice/Video/Document) | adapted from OpenClaw |
| Forwarded messages | Treat as normal message from authorized user | grammy |
| Native commands | /new, /model, /status, /clear, /help via setMyCommands() | grammy |
| Inline buttons | Accept/deny for blacklisted actions via InlineKeyboard | adapted from OpenClaw |
| Rate limiting | apiThrottler() + retry_after handling | @grammyjs/transformer-throttler |
| Reply-to threading | Agent reply is threaded to user's message | grammy reply_parameters |
| Link preview control | Disable link previews in agent responses | grammy link_preview_options |

### Phase 2 — UX

| Feature | Description | Source |
|---|---|---|
| Streaming edit-in-place | Send initial msg, edit as tokens arrive, throttle 250ms-1s | adapted from OpenClaw draft-stream.ts |
| Reactions (ACK lifecycle) | Emoji on received msg: queued → thinking → tool use → done/error | adapted from OpenClaw |
| Model picker | Browse providers → models via inline keyboard, persist choice | adapted from OpenClaw |
| Message pinning | Agent can pin messages in chat | grammy pinChatMessage |
| Agent-initiated actions | Agent can: send, edit, delete messages, react, create polls, pin | new tools in tools/ |
| Error policy | Configurable: always, once (cooldown), silent | new |
| Media groups (albums) | Buffer and coalesce multi-photo/video sends | adapted from OpenClaw |

### Phase 3 — Later

| Feature | Description | Source |
|---|---|---|
| Voice transcription | Transcribe inbound voice messages to text | external STT service |
| Forum/topic support | Per-topic sessions and config | adapted from OpenClaw |
| Per-group config | Different system prompt, tools, settings per group | config extension |
| Group history ingestion | Silent ingest of non-mentioned messages for context | adapted from OpenClaw |
| Heartbeat / proactive | Agent does periodic checks and notifies | cron + agent |

## Files

### Phase 1 files

| File | Lines est. | Role |
|---|---|---|
| `src/channels/telegram.ts` | ~500 | Main adapter: bot init, handlers, send, polling+webhook, reactions, reply threading |
| `src/channels/telegram-format.ts` | ~150 | Markdown → Telegram HTML conversion |
| `src/channels/telegram-split.ts` | ~80 | Message splitting (4000 chars, HTML-aware) |
| `src/channels/telegram-commands.ts` | ~120 | Native /commands + registration via setMyCommands() |

### Phase 2 files

| File | Lines est. | Role |
|---|---|---|
| `src/channels/telegram-stream.ts` | ~150 | Edit-in-place streaming with throttle |
| `src/channels/telegram-reactions.ts` | ~80 | ACK lifecycle reactions (queued→thinking→done→error) |
| `src/channels/telegram-model-picker.ts` | ~120 | Inline keyboard model browser |
| `src/channels/telegram-agent-actions.ts` | ~150 | Agent-initiated send/edit/delete/react/poll/pin |
| `src/channels/telegram-errors.ts` | ~60 | Error policy (always/once/silent) |

### Phase 3 files

| File | Lines est. | Role |
|---|---|---|
| `src/channels/telegram-voice.ts` | ~100 | Voice transcription (STT integration) |
| `src/channels/telegram-forum.ts` | ~150 | Forum/topic support |

## What we take from OpenClaw

### Copy (self-contained)
- InlineKeyboard builder logic
- Network error codes list (retryable, rate limit, safe-to-retry)
- Reaction emoji sets (with fallbacks)

### Adapt (rewrite simpler)
- format.ts → telegram-format.ts (regex instead of IR parser)
- send.ts split logic → telegram-split.ts
- draft-stream.ts → telegram-stream.ts (no state machine, simple edit loop)
- bot-handlers.runtime.ts debounce → simple setTimeout in telegram.ts
- model-buttons.ts → telegram-model-picker.ts (no session store, just config)
- Reaction lifecycle → telegram-reactions.ts (no scoping, just per-message state)

### Skip
- Plugin SDK / dependency injection (40+ modules)
- Multi-account support
- DM pairing (whitelist is enough)
- Thread bindings / conversation runtime
- SSRF protection
- Sticker vision analysis
- 401 circuit breaker
- Reply history tracking
- Channel activity recording
- Auto topic labeling
- Plugin interactive handlers

## Message Flow

### Inbound
```
Telegram Update
  → grammy handler (bot.on("message"))
    → text batching debounce (1s)
      → normalize to UnifiedMessage
        → set ACK reaction (emoji: received)
          → adapter.onMessage(handler) callback
            → router handles auth + session
              → update reaction (emoji: thinking)
                → agent processes
                  → update reaction (emoji: done or error)
```

### Outbound (normal)
```
Agent response text
  → format markdown to HTML (telegram-format.ts)
    → split if > 4000 chars (telegram-split.ts)
      → send each chunk via sendMessage(chatId, html, { parse_mode: "HTML", reply_parameters })
        → on parse error: retry as plain text
          → extract MEDIA:/path refs → send as photo/document/voice
            → disable link preview
```

### Outbound (streaming)
```
Agent starts streaming tokens
  → sendChatAction("typing")
    → after 30+ chars: send initial message
      → every 250ms-1s: editMessageText with new content
        → if > 4000 chars: stop editing, send overflow as new message
          → on finish: final edit with complete text
```

### Agent-initiated actions
```
Agent calls tool: telegram_send / telegram_edit / telegram_delete / telegram_react / telegram_poll / telegram_pin
  → tool validates args
    → execute via bot.api.*
      → return result to agent
```

## Inline buttons

### Blacklist confirmation
```
Agent wants to execute blacklisted action
  → send message with InlineKeyboard: [Accept] [Deny]
    → bot.on("callback_query")
      → check user is authorized
        → resolve: execute or skip
          → edit message to show decision
```

### Model picker
```
User sends /model
  → send InlineKeyboard: list of providers
    → user clicks provider
      → edit message: paginated model list (current marked with checkmark)
        → user clicks model
          → persist to session config
            → edit message: "Model changed to X"
```

## Error Policy

| Mode | Behavior |
|---|---|
| `always` | Show every error to user |
| `once` | Show error once per scope, suppress duplicates for N minutes |
| `silent` | Never show errors to user (log only) |

Default: `always`. Configurable in config.json.

## Error Handling

- Send failures: 1 retry on network error, skip on bad request
- Parse failures: fallback to plain text (strip HTML)
- Rate limit (429): wait retry_after seconds, then retry
- Connection loss (polling): grammy handles reconnection
- Connection loss (webhook): Telegram retries delivery
- Agent errors: displayed according to error policy

## Reactions Lifecycle

| State | Emoji | When |
|---|---|---|
| Received | eyes | Message accepted |
| Thinking | brain | Agent processing |
| Tool use | gear | Running a tool |
| Done | checkmark | Response sent |
| Error | warning | Something went wrong |

Configurable emojis. Reaction removed or changed at each state transition.

## Native Commands

| Command | Action |
|---|---|
| `/new` | Clear session, start fresh |
| `/model` | Show current model / open model picker |
| `/status` | Show: model, provider, session age, message count |
| `/clear` | Clear session history (keep session) |
| `/help` | List all commands |

## Config Example

```json
{
  "channels": {
    "telegram": {
      "token": "123456:ABC-DEF...",
      "mode": "polling",
      "webhook": {
        "url": "https://my-server.com/telegram/webhook",
        "secret": "a-random-secret-string",
        "port": 8443
      },
      "reactions": {
        "enabled": true,
        "received": "eyes",
        "thinking": "brain",
        "toolUse": "gear",
        "done": "white_check_mark",
        "error": "warning"
      },
      "streaming": {
        "enabled": true,
        "minChars": 30,
        "throttleMs": 1000
      },
      "errorPolicy": "always",
      "linkPreview": false
    }
  },
  "whitelist": ["123456789", "987654321"],
  "blacklist": [],
  "llm": {
    "provider": "fireworks",
    "baseUrl": "https://api.fireworks.ai/inference/v1",
    "model": "accounts/fireworks/models/kimi-k2p5-turbo"
  }
}
```
