# Telegram Implementation Plan

## Overview

Implement the Telegram channel adapter for my-claw using grammy, with support for
both long polling and webhook modes. Based on patterns from OpenClaw's Telegram
extension (232 files, 74k lines), stripped down to what we actually need.

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
- Config: `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET`
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

## Files to create/modify

### `src/channels/telegram.ts` (~400 lines)
Main adapter. Responsibilities:
- Create grammy Bot instance with throttler
- Register message handlers (text, media, commands, callback queries)
- Normalize incoming messages to UnifiedMessage
- Send responses (text, media, buttons)
- Start in polling or webhook mode based on config
- Text batching (debounce split messages from Telegram)

### `src/channels/telegram-format.ts` (~150 lines)
Markdown to Telegram HTML conversion. Adapted from OpenClaw's format.ts:
- Bold `**text**` → `<b>text</b>`
- Italic `*text*` → `<i>text</i>`
- Strikethrough `~~text~~` → `<s>text</s>`
- Inline code `` `code` `` → `<code>code</code>`
- Code blocks ` ```code``` ` → `<pre><code>code</code></pre>`
- Links `[text](url)` → `<a href="url">text</a>`
- Spoilers `||text||` → `<tg-spoiler>text</tg-spoiler>`
- Headers `## Title` → `<b>Title</b>`
- HTML entity escaping (`<`, `>`, `&`)
- Fallback to plain text on parse error

### `src/channels/telegram-split.ts` (~80 lines)
Message splitting for the 4096 char limit. Adapted from OpenClaw:
- Split at 4000 chars (room for overhead)
- Prefer splitting at newlines, then spaces
- HTML-tag-aware: close/reopen tags at chunk boundaries
- Code block aware: close ``` and reopen at next chunk

### `src/channels/telegram-commands.ts` (~100 lines)
Native Telegram slash commands:
- `/new` — start a new session
- `/model` — show/change current model
- `/status` — show agent status (model, session, uptime)
- `/clear` — clear session history
- `/help` — list available commands
- Register commands via `bot.api.setMyCommands()`
- Handle via `bot.command("new", ...)`

### `src/channels/types.ts` (modify)
Add webhook config types, telegram-specific config.

### `src/config.ts` (modify)
Add telegram webhook config to MyClawConfig.

## What we take from OpenClaw

### Copy (self-contained, no core deps)
- `inline-keyboard.ts` logic → InlineKeyboardMarkup builder for accept/deny buttons
- Network error classification (retryable codes list)

### Adapt (take the logic, rewrite simple)
- Markdown → HTML conversion (format.ts) — drop the IR parser, write direct regex
- Message splitting (send.ts) — drop retry/activity tracking, keep split logic
- Text batching — simple setTimeout debounce, not their multi-lane system
- Media detection — simple type checks on message object
- Forward handling — treat as normal message from authorized user
- Typing indicator — `sendChatAction("typing")` before processing

### Skip (not needed)
- Plugin SDK / dependency injection (40+ modules)
- Multi-account support
- DM pairing / group policy system (we have simple whitelist)
- Thread bindings / conversation runtime
- Model picker buttons
- Reply history tracking
- Channel activity recording
- SSRF protection
- Sticker vision analysis
- 401 circuit breaker
- Draft stream state machine (maybe later for streaming)

## Message flow

```
Telegram Update
  → grammy handler (bot.on("message"))
    → text batching debounce (1s)
      → normalize to UnifiedMessage
        → adapter.onMessage(handler) callback
          → (router handles auth + session from here)

Response from agent
  → format markdown to HTML (telegram-format.ts)
    → split if > 4000 chars (telegram-split.ts)
      → send each chunk via bot.api.sendMessage(chatId, html, { parse_mode: "HTML" })
        → on parse error: retry as plain text
          → extract MEDIA:/path refs → send as photo/document/voice
```

## Inline buttons (for blacklist confirmation)

```
Agent wants to execute blacklisted action
  → send message with InlineKeyboard: [Accept] [Deny]
    → bot.on("callback_query") fires
      → check user is authorized
        → resolve: execute or skip action
          → edit message to show decision
```

## Error handling

- Send failures: 1 retry on network error, skip on bad request
- Parse failures: fallback to plain text (strip HTML)
- Rate limit (429): wait retry_after seconds, then retry
- Connection loss (polling): grammy handles reconnection automatically
- Connection loss (webhook): Telegram retries delivery

## Media handling

### Inbound
- `message.photo` → download largest, pass as attachment
- `message.document` → download, pass as attachment
- `message.voice` → download .ogg, pass as attachment
- `message.video` → download, pass as attachment
- `message.audio` → download, pass as attachment

### Outbound
- Detect MEDIA:/path in agent response
- Route by extension: .png/.jpg/.webp → sendPhoto, .ogg → sendVoice, .mp4 → sendVideo, other → sendDocument
- Strip MEDIA: refs from text, send text + media separately

## Native commands

| Command | Action |
|---------|--------|
| `/new` | Clear session, start fresh |
| `/model` | Show current model, optionally switch |
| `/status` | Show: model, provider, session age, message count |
| `/clear` | Clear session history (keep session) |
| `/help` | List all commands |

Commands are registered on bot start via `setMyCommands()` so they appear in Telegram's command menu.

## Config example

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
      }
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
