# Telegram Phase 1 — Implementation Reference

## Status: Complete

All Phase 1 features are implemented, type-checked, and production-polished.
Patterns ported from OpenClaw's production Telegram extension, simplified for single-bot use.

## Toggle

- `channels.telegram.enabled: false` disables Telegram startup

## Logs

- `~/.my-claw/logs/telegram-YYYY-MM-DD(.N).log`

## File Map

| File | Lines | Role |
|---|---|---|
| `src/channels/telegram.ts` | ~830 | Adapter: bot init, handlers, send pipeline, retry, typing, batching, webhook |
| `src/channels/telegram-format.ts` | ~354 | Markdown to Telegram HTML via markdown-it tokenizer |
| `src/channels/telegram-split.ts` | ~199 | HTML-tag-aware message splitting + aligned plain text chunks |
| `src/channels/telegram-commands.ts` | ~20 | Command definitions + `setMyCommands()` registration |
| `src/channels/types.ts` | ~38 | Shared interfaces: UnifiedMessage, Attachment, OutgoingMessage, ChannelAdapter |
| `src/agent/bridge.ts` | ~130 | Agent loop: system prompt + history -> LLM -> tool calls -> loop -> response |
| `src/llm/provider.ts` | ~70 | OpenAI-compatible chat completion with tool call support |
| `src/router/router.ts` | ~40 | Auth guard + session resolution + agent bridge call |
| `src/sessions/manager.ts` | ~72 | In-memory session cache + disk persistence + reset/clear/info |
| `src/sessions/store.ts` | ~50 | Typed session messages, JSON file read/write/delete |
| `src/index.ts` | ~108 | Wiring: config -> tools -> sessions -> agent -> router -> adapter + shutdown |

## Adapter: `TelegramAdapter`

Constructor: `new TelegramAdapter(config: TelegramChannelConfig, whitelist: Set<string>)`

### Public API

- `start()` — init bot, register commands, start polling or webhook
- `stop()` — cleanup all timers/intervals, stop bot + webhook server
- `send(chatId, OutgoingMessage)` — send text (chunked) + media with caption logic
- `onMessage(handler)` — register inbound message handler
- `onCommand(handler)` — register command handler with `(chatId, userId, chatType, command, args)`
- `confirm(chatId, text, replyToId?)` — inline keyboard accept/deny, returns boolean promise

### Connection Modes

- **Polling** (default): `bot.start()`, no infra needed
- **Webhook**: Bun native HTTP server, returns 200 immediately after JSON parse, processes update async to prevent Telegram re-delivery on processing errors

Config field `mode: "polling" | "webhook"`. Webhook requires `webhook.url`, `webhook.secret`, `webhook.port`.

## Send Pipeline

```
OutgoingMessage.text
  -> extractMediaRefs() / stripMediaRefs()
  -> markdownToTelegramHtml()
  -> splitHtmlChunks() (4000 char limit)
  -> alignPlainTextChunks() (1:1 with HTML chunks for fallback)
  -> for each chunk: sendTextMessage()
    -> try HTML parse_mode
    -> on PARSE_ERR: retry with aligned plain text chunk
    -> on THREAD_NOT_FOUND: retry without thread_id (then fallback plain on parse err)
  -> send media with optional caption
```

### Caption Logic (OpenClaw: all-or-nothing at 1024)

- Text <= 1024 chars AND has media: text becomes `caption` on first media item (HTML with plain fallback)
- Text > 1024 chars OR no media: text sent as separate chunked messages

### Media Routing

Extension-based type detection:
- Photo: jpg, jpeg, png, gif, webp
- Video: mp4, avi, mkv, mov, webm
- Voice: ogg, oga
- Audio: mp3, wav, flac, m4a, aac
- Document: everything else

Supports both `MEDIA:/path` refs in text and `OutgoingMessage.attachments`.

## Retry (`withRetry`)

Ported from OpenClaw's exponential backoff:
- **Attempts**: 3
- **Base delay**: 400ms, doubles per attempt
- **Max delay**: 30s
- **Jitter**: +/-10%
- **Rate limit (429)**: waits `retry_after` seconds from Telegram's response
- **Pre-connect errors only**: ECONNREFUSED, ENOTFOUND, EAI_AGAIN, ENETUNREACH, EHOSTUNREACH
- Non-retryable errors break immediately

## Inbound Message Handling

### Text Batching

Buffers rapid consecutive messages from the same user in the same chat:
- **Trigger**: first message >= 4000 chars
- **Gap**: 1500ms timeout between messages
- **Constraints**: message_id gap <= 1, max 12 parts, max 50k chars total
- **Flush**: concatenates all text, processes as single message

### Media Group Buffering

- **Timeout**: 500ms to collect all parts
- **Sort**: by message_id
- **Primary**: message with caption, or first message
- **Downloads**: parallel via `Promise.all`
- **Normalization**: all attachments merged into single `UnifiedMessage`

### Message Normalization

`GrammyMessage` -> `UnifiedMessage` with:
- `id`: String(message_id)
- `platform`: "telegram"
- `userId`: String(from.id)
- `chatId`: String(chat.id)
- `chatType`: "dm" (private) or "group" (group/supergroup/channel)
- `attachments`: downloaded to `~/.my-claw/tmp/`, parallel extraction
- `isForwarded`: boolean from forward_origin
- `raw`: original grammy message

## Typing Indicator

Ref-counted per chatId:
- `startTyping(chatId)`: if first caller, starts interval (5s). Otherwise increments count.
- `stopTyping(chatId)`: decrements count. At 0, clears interval.
- Prevents concurrent message processing from clobbering each other's typing state.

## Thread ID Tracking

- Stores `message_id -> message_thread_id` for forum/topic support
- Pruned at 10,000 entries via FIFO eviction (delete oldest keys first)
- General topic (ID=1) excluded from `message_thread_id` params

## Confirmations (Blacklist)

- Sends message with `InlineKeyboard`: `[Accept] [Deny]` with callback data `cfm:{uuid}:y/n`
- 5-minute timeout auto-denies
- Callback query handler validates auth, resolves promise, edits message with result

## Markdown to Telegram HTML (`telegram-format.ts`)

Uses `markdown-it` for proper tokenization (NOT regex). Handles:
- **Bold** -> `<b>`, **Italic** -> `<i>`, **Strikethrough** -> `<s>`
- **Code** -> `<code>`, **Code blocks** -> `<pre><code class="language-X">`
- **Links** -> `<a href>`
- **Headings** -> `<b>` (Telegram has no heading tag)
- **Blockquotes** -> `<blockquote>` (trailing newlines trimmed)
- **Lists** -> Unicode bullets (depth-indented `"  "` per level), ordered with counter
- **Task lists** -> `[ ]` -> `☐`, `[x]` -> `☑`
- **Tables** -> ASCII pipe tables inside `<pre>` (Telegram has no table tag)
- **Horizontal rules** -> `───`
- **Spoilers** -> `||text||` -> `<tg-spoiler>`
- **Images** -> alt text only (no inline images in Telegram HTML)
- **HTML in markdown** -> escaped

### File Reference Wrapping

TLD collision extensions (md, go, py, pl, sh, am, at, be, cc) get `<code>` wrapped:
- `readme.md` -> `<code>readme.md</code>`
- Auto-linked anchors de-linkified: `<a href="http://readme.md">readme.md</a>` -> `<code>readme.md</code>`
- Skips text already inside `<code>`, `<pre>`, or `<a>` tags

## HTML-Aware Message Splitting (`telegram-split.ts`)

### `splitHtmlChunks(html, limit=4000)`

- Walks HTML with regex tag matching, maintains open tag stack
- At chunk boundary: closes all open tags, re-opens them at start of next chunk
- Entity-safe split: scans back up to 10 chars for `&` to avoid splitting HTML entities
- Self-closing tags (br) don't affect stack

### `alignPlainTextChunks(plainText, htmlChunkCount, limit=4000)`

Produces N plain text chunks aligned 1:1 with HTML chunks:
- Distributes text evenly across `htmlChunkCount` chunks
- Splits at newlines preferentially, then spaces, then hard limit
- Used for per-chunk fallback: if HTML chunk i fails to parse, send plain chunk i

### `splitPlainText(text, limit=4000)`

Standalone plain text splitting (newline > space > hard cut).

## Commands

| Command | Handler |
|---|---|
| `/new` | `sessionManager.resetSession()` — deletes file + creates fresh session |
| `/clear` | `sessionManager.clearHistory()` — empties messages array |
| `/model` | Returns current model name. Args not yet supported. |
| `/status` | Returns model, session ID, message count, created/last active dates |
| `/help` | Static list from `telegram-commands.ts` |

## Wiring (`index.ts`)

```
loadConfig()
  -> ToolRegistry (8 tools: bash, read, write, fetch, find, grep, ls, memory)
  -> SessionManager
  -> AgentBridge(config, toolRegistry)
  -> MessageRouter(whitelist, sessionManager, agentBridge)
  -> TelegramAdapter(telegramConfig, whitelistSet)
    -> onMessage: router.route() -> adapter.send() -> cleanupAttachments()
    -> onCommand: session commands (new/clear/model/status)
  -> adapter.start()
  -> SIGINT/SIGTERM -> adapter.stop()
```

### Tmp File Cleanup

Attachments downloaded to `~/.my-claw/tmp/{timestamp}-{uuid}.{ext}`.
Cleaned up in `finally` block after message processing completes (even on error).

## Router

- Double auth: adapter checks whitelist (fast reject at Telegram level), router checks via AuthGuard (defense in depth)
- Session ID: `{platform}/{dm|group}/{userId|chatId}`
- Delegates all message history management to AgentBridge
- Persists session to disk after each exchange
- Catches agent errors, returns generic error message

## Agent Bridge (`AgentBridge`)

Full agent loop with tool calling:

```
1. Build user content (text + attachment descriptions)
2. Push user message to session history
3. Build system prompt (7-layer architecture)
4. Convert session history to OpenAI ChatMessage format
5. Convert tools to OpenAI function calling format
6. Call LLM (chatCompletion)
7. If no tool_calls -> push assistant message, return content
8. If tool_calls -> execute each tool, push results, go to step 6
9. Max 10 iterations, then return fallback message
```

### Tool Call Format (OpenAI-compatible)

Request tools: `[{ type: "function", function: { name, description, parameters } }]`
Response tool_calls: `[{ id, function: { name, arguments } }]`
Follow-up: assistant message with tool_calls, then tool messages with tool_call_id + result

### Session Message Types

Typed union stored in `SessionData.messages`:
- `{ role: "user", content, timestamp }` — user message (text + attachment descriptions)
- `{ role: "assistant", content, timestamp, toolCalls? }` — LLM response (with optional tool calls)
- `{ role: "tool", toolCallId, content, timestamp }` — tool execution result

History is persisted to disk and restored across restarts. Full conversation context (including intermediate tool calls) is sent to the LLM on each turn.

### Attachment Handling

Attachments are described textually in the user message content:
```
User's text

[Attachments]
- image: /path/to/file.jpg (image/jpeg)
- file: /path/to/doc.pdf (application/pdf)
```

The agent can use the `read` tool to access file contents.

### Tool Execution

- Unknown tool name: returns error string (no crash)
- Tool throws: caught, returns error string
- Tool result: `success` -> output string, `!success` -> error string
- 8 tools available: bash, read, write, fetch, find, grep, ls, memory

### LLM Provider (`chatCompletion`)

- OpenAI-compatible API (works with Fireworks, OpenRouter, Ollama, etc.)
- API key from config or env vars (`FIREWORKS_API_KEY` / `OPENAI_API_KEY`)
- ChatMessage is a union type supporting system/user/assistant/tool roles
- Tool calls parsed from response, arguments JSON-parsed into `Record<string, unknown>`

## Constants Reference

| Constant | Value | Source |
|---|---|---|
| CHUNK_LIMIT | 4000 | Telegram message length limit |
| TEXT_BATCH_THRESHOLD | 4000 | Min chars to start batching |
| TEXT_BATCH_GAP_MS | 1500 | Max gap between batched messages |
| TEXT_BATCH_MAX_PARTS | 12 | Max messages in a batch |
| TEXT_BATCH_MAX_CHARS | 50000 | Max total chars in a batch |
| TEXT_BATCH_MAX_ID_GAP | 1 | Max message_id gap for consecutive messages |
| MEDIA_GROUP_TIMEOUT_MS | 500 | Buffer time for media group collection |
| CAPTION_LIMIT | 1024 | Telegram caption length limit |
| TYPING_INTERVAL_MS | 5000 | Typing action repeat interval |
| RETRY_ATTEMPTS | 3 | Max retry attempts |
| RETRY_MIN_DELAY_MS | 400 | Base retry delay |
| RETRY_MAX_DELAY_MS | 30000 | Max retry delay |
| RETRY_JITTER | 0.1 | +/-10% jitter on retry delay |
| CONFIRM_TIMEOUT_MS | 300000 | 5 min auto-deny for confirmations |
| MAX_THREAD_ID_ENTRIES | 10000 | FIFO eviction threshold |
| GENERAL_TOPIC_ID | 1 | Excluded from thread params |
| MAX_TOOL_ITERATIONS | 10 | Agent loop safety limit |

## Dependencies

| Package | Version | Role |
|---|---|---|
| grammy | ^1.42.0 | Telegram Bot API |
| @grammyjs/runner | ^2.0.3 | Polling/webhook runner |
| @grammyjs/transformer-throttler | ^1.2.1 | API rate limiting |
| markdown-it | ^14.1.1 | Markdown tokenizer |
| @types/markdown-it | ^14.1.2 | TypeScript types |
