# Telegram Phase 2 — Detailed Implementation Plan

## Overview

4 features that improve UX during and after LLM generation.
All build on top of Phase 1's adapter, send pipeline, and session system.

## Prerequisites

- Phase 1 complete (all features implemented and type-checked)
- `AgentBridge.handleMessage` is implemented with full tool call loop (max 10 iterations), typed session messages, and attachment descriptions. Returns `Promise<string>`.
- For streaming: needs a `handleMessageStreaming` variant + `chatCompletionStream` in `src/llm/provider.ts` (SSE with `stream: true`)

---

## Feature 1: Streaming Edit-in-Place

### What

Instead of waiting for the full LLM response, send an initial message after ~30 chars and edit it in place as tokens arrive. User sees the response being typed in real-time.

### UX Flow

```
User sends message
  -> typing indicator starts
  -> LLM starts streaming tokens
  -> after 30+ chars accumulated: send initial message (sendMessage)
  -> every ~1s: editMessageText with accumulated content
  -> if accumulated text > 4000 chars: stop editing current message, send new message for overflow
  -> on stream end: final editMessageText with complete content + markdown formatting
```

### File: `src/channels/telegram-stream.ts` (~150 lines)

```ts
export interface StreamOptions {
  chatId: string;
  threadId?: number;
  replyToId?: number;
  linkPreview?: boolean;
  minCharsBeforeSend: number;    // default 30
  editThrottleMs: number;         // default 1000
  chunkLimit: number;             // default 4000
}

export class MessageStreamer {
  private messageId: number | null = null;
  private buffer: string = "";
  private lastEditAt: number = 0;
  private editTimer: Timer | null = null;
  private overflowMessages: number[] = [];
  private finished: boolean = false;

  constructor(
    private bot: Bot,
    private opts: StreamOptions,
    private formatAndSend: (chatId: string, text: string, opts: Record<string, unknown>) => Promise<number>,
  ) {}

  async push(token: string): Promise<void> { ... }
  async finish(): Promise<void> { ... }
  async abort(errorText?: string): Promise<void> { ... }
}
```

### Algorithm

1. **Accumulate tokens** in `buffer`
2. **First send**: when `buffer.length >= minCharsBeforeSend` and no `messageId` yet
   - Call `sendMessage` (plain text, no HTML — intermediate content has incomplete markdown)
   - Store `messageId`
3. **Throttled edits**: every `editThrottleMs` (default 1s)
   - If `buffer` changed since last edit and elapsed >= throttle: `editMessageText`
   - Use plain text during streaming (markdown is incomplete mid-stream)
   - If `editMessageText` fails with "message is not modified": ignore (content unchanged)
   - If fails with "message to edit not found": abort streaming
4. **Overflow**: when `buffer.length > chunkLimit`
   - Final edit on current message with first `chunkLimit` chars
   - Send new message for overflow, reset `messageId` to new one
   - Continue streaming into new message
5. **Finish**: on stream end
   - Cancel pending edit timer
   - Format complete text with `markdownToTelegramHtml`
   - Split into chunks if needed
   - Final `editMessageText` on last sent message with HTML parse_mode
   - If parse fails: edit with plain text fallback
   - If content grew beyond what fits in edit: send remaining as new messages

### Edge Cases

- **Empty response**: don't send anything (no initial message was sent)
- **Very short response** (< minChars): send as normal message on finish, skip streaming
- **Rate limit on edit**: respect `retry_after`, skip that edit cycle
- **Network error on edit**: log and continue, next edit will catch up
- **User deletes message while streaming**: `editMessageText` returns "message to edit not found", abort gracefully
- **Concurrent streams in same chat**: each `MessageStreamer` is independent, tracks its own `messageId`
- **Streaming + tool calls**: when LLM returns tool_calls mid-loop, streaming pauses (final edit with current text + "Running tool..."), tools execute, then next LLM call resumes streaming into a new message. The `handleMessageStreaming` method drives the loop — each iteration either streams text or executes tools, never both.

### Integration Points

- `TelegramAdapter.send()` gets a new `stream?: boolean` option, or a separate method `sendStreaming(chatId, tokenStream, opts)`
- `AgentBridge.handleMessage` needs a streaming variant:
  ```ts
  async handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: (token: string) => Promise<void>,
  ): Promise<string>
  ```
- `chatCompletion` in `src/llm/provider.ts` needs a streaming variant:
  ```ts
  async function chatCompletionStream(
    config: LlmConfig,
    messages: ChatMessage[],
    tools?: unknown[],
    onToken?: (token: string) => void,
  ): Promise<LlmResponse>
  ```
  Uses `stream: true` in the OpenAI API body, reads SSE lines from response body.

### LLM Streaming Implementation (`src/llm/provider.ts`)

Add to the existing file:

```ts
export async function chatCompletionStream(
  config: MyClawConfig["llm"],
  messages: ChatMessage[],
  onToken: (token: string) => void,
  tools?: unknown[],
): Promise<LlmResponse> {
  // Same as chatCompletion but with stream: true
  // Read response.body as ReadableStream
  // Parse SSE: lines starting with "data: "
  // Each SSE chunk: { choices: [{ delta: { content?: string } }] }
  // Call onToken(delta.content) for each non-empty delta
  // Accumulate full response for return value
  // Handle [DONE] sentinel
}
```

SSE parsing loop:
```
for await (const chunk of response.body)
  -> split by "\n"
  -> skip empty lines and "data: [DONE]"
  -> JSON.parse(line.slice(6))  // remove "data: " prefix
  -> extract delta.content
  -> call onToken if non-empty
```

### Config

```json
{
  "channels": {
    "telegram": {
      "streaming": {
        "enabled": true,
        "minChars": 30,
        "throttleMs": 1000
      }
    }
  }
}
```

Add to `TelegramChannelConfig`:
```ts
streaming?: {
  enabled?: boolean;
  minChars?: number;
  throttleMs?: number;
}
```

### Telegram API Limits for Edit

- `editMessageText`: same rate limits as `sendMessage`
- No special restrictions on edit frequency, but throttler handles it
- Edited message must differ from previous content (otherwise "message is not modified" error)
- Max message length same as send: 4096 chars for text, applies to edit too

---

## Feature 2: Reactions Lifecycle

### What

Visual feedback via emoji reactions on the user's message, showing processing state transitions:

| State | Emoji | When |
|---|---|---|
| Received | `eyes` (👀) | Message accepted by adapter |
| Thinking | `brain` (🧠) | Agent is processing / LLM is generating |
| Tool use | `gear` (⚙️) | Agent is executing a tool |
| Done | `white_check_mark` (✅) | Response sent successfully |
| Error | `warning` (⚠️) | Processing failed |

### File: `src/channels/telegram-reactions.ts` (~80 lines)

```ts
type ReactionState = "received" | "thinking" | "tool_use" | "done" | "error";

interface ReactionConfig {
  enabled: boolean;
  emojis: Record<ReactionState, string>;
}

const DEFAULT_EMOJIS: Record<ReactionState, string> = {
  received: "👀",
  thinking: "🧠",
  tool_use: "⚙️",
  done: "✅",
  error: "⚠️",
};

export class ReactionManager {
  constructor(private bot: Bot, private config: ReactionConfig) {}

  async set(chatId: string, messageId: number, state: ReactionState): Promise<void> {
    if (!this.config.enabled) return;
    const emoji = this.config.emojis[state] ?? DEFAULT_EMOJIS[state];
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [
        { type: "emoji", emoji },
      ]);
    } catch {
      // Reactions may not be available in all chats (groups with reactions disabled)
      // Fail silently — reactions are cosmetic, never block processing
    }
  }

  async clear(chatId: string, messageId: number): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // same — fail silently
    }
  }
}
```

### Integration Points

In `TelegramAdapter.processMessage`:
```ts
private async processMessage(msg, textOverride?, extraMessages?): Promise<void> {
  const chatId = String(msg.chat.id);
  const msgId = msg.message_id;

  await this.reactions.set(chatId, msgId, "received");
  this.startTyping(chatId, msg.message_thread_id);

  try {
    await this.reactions.set(chatId, msgId, "thinking");
    await this.messageHandler(unified);
    await this.reactions.set(chatId, msgId, "done");
  } catch {
    await this.reactions.set(chatId, msgId, "error");
  } finally {
    this.stopTyping(chatId);
  }
}
```

For tool_use state: the agent bridge needs to emit tool execution events. Two options:
1. **Simple**: skip tool_use reaction, just use thinking/done/error (3 states)
2. **Full**: add an `onToolUse` callback to AgentBridge that triggers reaction change

Recommend starting with option 1 (3 states), add tool_use later when the agent loop supports tool execution events.

### Telegram API: `setMessageReaction`

```ts
bot.api.setMessageReaction(chatId, messageId, [
  { type: "emoji", emoji: "👀" }
]);
```

- Only works with standard Telegram emojis (not custom emoji unless bot is premium)
- Available emojis: limited set defined by Telegram (the ones above are all supported)
- Replaces previous reaction (only one reaction per bot per message)
- Empty array `[]` removes the reaction
- Fails silently in chats where reactions are disabled

### Config

```json
{
  "channels": {
    "telegram": {
      "reactions": {
        "enabled": true,
        "received": "👀",
        "thinking": "🧠",
        "toolUse": "⚙️",
        "done": "✅",
        "error": "⚠️"
      }
    }
  }
}
```

Add to `TelegramChannelConfig`:
```ts
reactions?: {
  enabled?: boolean;
  received?: string;
  thinking?: string;
  toolUse?: string;
  done?: string;
  error?: string;
}
```

---

## Feature 3: Model Picker

### What

`/model` opens an interactive inline keyboard to browse and select models.
Current model is marked with a checkmark. Selection persists to session config.

### UX Flow

```
User sends /model
  -> bot sends message with inline keyboard:
     "Current model: kimi-k2p5-turbo"
     [kimi-k2p5-turbo ✓] [llama-v3p3-70b]
     [qwen3-235b]        [deepseek-v3]
  -> user taps a model button
  -> bot edits message: "Model changed to llama-v3p3-70b"
  -> session config updated, next LLM call uses new model
```

### File: `src/channels/telegram-model-picker.ts` (~120 lines)

```ts
interface ModelOption {
  id: string;       // full model ID for API (e.g., "accounts/fireworks/models/kimi-k2p5-turbo")
  label: string;    // display name (e.g., "Kimi K2.5 Turbo")
}

export class ModelPicker {
  constructor(private models: ModelOption[]) {}

  buildKeyboard(currentModelId: string): InlineKeyboard { ... }
  parseCallback(data: string): string | null { ... }  // returns model ID or null
}
```

### Callback Data Format

`mdl:{index}` where index is the position in the models array.
Keep callback data short (Telegram limit: 64 bytes).

### Integration

In `telegram.ts`:
- Add handler for callback data matching `mdl:*`
- On callback: update session's model override, edit message to confirm
- `/model` without args: send picker keyboard
- `/model {name}`: direct model switch (fuzzy match against known models)

### Session Model Override

Add to `SessionData`:
```ts
export interface SessionData {
  // ... existing fields
  modelOverride?: string;  // overrides config.llm.model for this session
}
```

`AgentBridge.handleMessage` checks `session.modelOverride ?? this.config.llm.model` when calling the LLM.

### Model List Source

Config-driven. Add to `MyClawConfig`:
```ts
llm: {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  models?: Array<{ id: string; label: string }>;  // available models for picker
}
```

If `models` is not set, `/model` just shows the current model (no picker).
The list is static in config — no API call to list models (Fireworks/OpenRouter model list APIs vary too much).

### Config Example

```json
{
  "llm": {
    "provider": "fireworks",
    "baseUrl": "https://api.fireworks.ai/inference/v1",
    "model": "accounts/fireworks/models/kimi-k2p5-turbo",
    "models": [
      { "id": "accounts/fireworks/models/kimi-k2p5-turbo", "label": "Kimi K2.5 Turbo" },
      { "id": "accounts/fireworks/models/llama-v3p3-70b-instruct", "label": "Llama 3.3 70B" },
      { "id": "accounts/fireworks/models/qwen3-235b-a22b", "label": "Qwen3 235B" },
      { "id": "accounts/fireworks/models/deepseek-v3", "label": "DeepSeek V3" }
    ]
  }
}
```

---

## Feature 4: Error Policy

### What

Configurable behavior for how errors are shown to the user:

| Mode | Behavior |
|---|---|
| `always` | Every error sends a message to the user (current behavior) |
| `once` | Show error once per type, suppress duplicates for N minutes |
| `silent` | Never show errors to the user (log only) |

### File: `src/channels/telegram-errors.ts` (~60 lines)

```ts
type ErrorPolicy = "always" | "once" | "silent";

interface ErrorPolicyConfig {
  mode: ErrorPolicy;
  onceCooldownMs: number;  // default 5 minutes
}

export class ErrorReporter {
  private lastShown = new Map<string, number>();  // error key -> timestamp

  constructor(private config: ErrorPolicyConfig) {}

  shouldReport(errorKey: string): boolean {
    if (this.config.mode === "silent") return false;
    if (this.config.mode === "always") return true;

    // mode === "once"
    const last = this.lastShown.get(errorKey);
    const now = Date.now();
    if (last && now - last < this.config.onceCooldownMs) return false;
    this.lastShown.set(errorKey, now);
    return true;
  }

  errorKey(err: unknown): string {
    // Group errors by type: "parse_error", "rate_limit", "agent_error", "network_error", etc.
    // Prevents flooding the user with repeated identical errors
  }
}
```

### Error Key Heuristics

| Error | Key |
|---|---|
| GrammyError (parse) | `parse_error` |
| GrammyError (429) | `rate_limit` |
| GrammyError (other) | `telegram_{error_code}` |
| HttpError (pre-connect) | `network_{code}` |
| Agent/LLM error | `agent_error` |
| Unknown | `unknown` |

### Integration

In `TelegramAdapter` and `MessageRouter`, wrap error reporting:
```ts
catch (err) {
  log("error", "...", { error: String(err) });
  const key = this.errorReporter.errorKey(err);
  if (this.errorReporter.shouldReport(key)) {
    await this.send(chatId, { text: "An error occurred while processing your message." });
  }
}
```

### Config

```json
{
  "channels": {
    "telegram": {
      "errorPolicy": "always"
    }
  }
}
```

Add to `TelegramChannelConfig`:
```ts
errorPolicy?: "always" | "once" | "silent";
```

Default: `always` (backward compatible with current behavior).

---

## Implementation Order

Recommended order based on dependencies and impact:

### Step 1: LLM Streaming (`src/llm/provider.ts`)
- Add `chatCompletionStream` function
- SSE parser for OpenAI-compatible streaming
- No Telegram changes yet — just the LLM layer
- **Test**: call Fireworks with `stream: true`, verify tokens arrive

### Step 2: Reactions Lifecycle (`src/channels/telegram-reactions.ts`)
- Implement `ReactionManager`
- Integrate into `TelegramAdapter.processMessage`
- Start with 3 states (received/thinking/done+error), skip tool_use for now
- **Test**: send message, verify emoji transitions appear
- Independent of streaming — works with current sync response

### Step 3: Error Policy (`src/channels/telegram-errors.ts`)
- Implement `ErrorReporter`
- Integrate into adapter and router error paths
- Add config field
- **Test**: trigger errors, verify policy modes work
- Independent of other Phase 2 features

### Step 4: Streaming Edit-in-Place (`src/channels/telegram-stream.ts`)
- Implement `MessageStreamer`
- Add streaming variant to `AgentBridge`
- Wire adapter: detect streaming support, use `MessageStreamer` when enabled
- Combine with reactions: received -> thinking -> (streaming edits) -> done
- **Test**: send message, verify real-time token display + final formatted message

### Step 5: Model Picker (`src/channels/telegram-model-picker.ts`)
- Implement `ModelPicker`
- Add `modelOverride` to SessionData
- Wire into `/model` command and callback handler
- Update AgentBridge to use session model override
- **Test**: `/model`, select model, verify next response uses new model

## Files to Create

| File | Est. Lines | Step |
|---|---|---|
| `src/channels/telegram-reactions.ts` | ~80 | 2 |
| `src/channels/telegram-errors.ts` | ~60 | 3 |
| `src/channels/telegram-stream.ts` | ~150 | 4 |
| `src/channels/telegram-model-picker.ts` | ~120 | 5 |

## Files to Modify

| File | Changes | Step |
|---|---|---|
| `src/llm/provider.ts` | Add `chatCompletionStream` (SSE parser, `stream: true`) | 1 |
| `src/agent/bridge.ts` | Add `handleMessageStreaming` (tool call loop with onToken callback) | 4 |
| `src/channels/telegram.ts` | Integrate reactions, errors, streaming, model picker callbacks | 2-5 |
| `src/sessions/store.ts` | Add `modelOverride?: string` to `SessionData` | 5 |
| `src/config.ts` | Add streaming, reactions, errorPolicy to `TelegramChannelConfig` | 2-4 |
| `src/router/router.ts` | Use streaming variant when available, pass error reporter | 3-4 |
| `src/index.ts` | Pass new config to adapter, wire model picker | 2-5 |

## Config Changes Summary

```ts
export interface TelegramChannelConfig {
  token: string;
  mode?: "polling" | "webhook";
  webhook?: { url: string; secret: string; port: number };
  linkPreview?: boolean;
  // Phase 2 additions:
  streaming?: { enabled?: boolean; minChars?: number; throttleMs?: number };
  reactions?: { enabled?: boolean; received?: string; thinking?: string; toolUse?: string; done?: string; error?: string };
  errorPolicy?: "always" | "once" | "silent";
}
```

---

## Step 6: Test Suite (Phase 1 + Phase 2)

After Phase 2 features are stable, add a full test suite covering both phases.
Framework: `bun:test` (built-in, zero deps).

### Strategy

Integration tests with mocked externals (Telegram API, LLM API), real everything else.
No unit tests for trivial glue code. Unit tests only where logic is dense.

### Test Files

| File | Covers | Type |
|---|---|---|
| `tests/telegram-format.test.ts` | `telegram-format.ts` | Unit |
| `tests/telegram-split.test.ts` | `telegram-split.ts` | Unit |
| `tests/agent-bridge.test.ts` | `agent/bridge.ts` | Integration (LLM mocked) |
| `tests/send-pipeline.test.ts` | `telegram.ts` send path | Integration (bot.api mocked) |
| `tests/inbound-flow.test.ts` | Full inbound pipeline | Integration (bot.api + LLM mocked) |
| `tests/commands.test.ts` | `/new`, `/clear`, `/model`, `/status` | Integration (sessions real) |
| `tests/streaming.test.ts` | `telegram-stream.ts` + edit loop | Integration (bot.api mocked) |
| `tests/reactions.test.ts` | `telegram-reactions.ts` | Unit |
| `tests/error-policy.test.ts` | `telegram-errors.ts` | Unit |
| `tests/model-picker.test.ts` | `telegram-model-picker.ts` | Unit + Integration |

### Mock Strategy

**Telegram bot.api mock**: thin wrapper that records calls and returns canned responses.
```ts
function createMockBotApi() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    sendMessage: async (...args) => { calls.push({ method: "sendMessage", args }); return { message_id: calls.length }; },
    editMessageText: async (...args) => { calls.push({ method: "editMessageText", args }); return true; },
    sendPhoto: async (...args) => { calls.push({ method: "sendPhoto", args }); return { message_id: calls.length }; },
    setMessageReaction: async (...args) => { calls.push({ method: "setMessageReaction", args }); },
    // ... other methods as needed
  };
}
```

**LLM mock**: returns predefined responses, optionally with tool_calls.
```ts
function createMockLlm(responses: LlmResponse[]) {
  let i = 0;
  return async () => responses[i++] ?? { content: "", toolCalls: [] };
}
```

For streaming tests: mock that yields tokens via async generator.

### telegram-format.test.ts (~150 lines)

Dense edge cases — this is where most formatting bugs live.

| Case | Input | Expected |
|---|---|---|
| Bold | `**text**` | `<b>text</b>` |
| Italic | `*text*` | `<i>text</i>` |
| Strikethrough | `~~text~~` | `<s>text</s>` |
| Inline code | `` `code` `` | `<code>code</code>` |
| Code block | ` ```js\ncode\n``` ` | `<pre><code class="language-js">code</code></pre>` |
| Link | `[text](url)` | `<a href="url">text</a>` |
| Heading | `## Title` | `<b>Title</b>` |
| Blockquote | `> text` | `<blockquote>text</blockquote>` |
| Nested blockquote | `> > text` | Nested `<blockquote>` |
| Unordered list | `- a\n- b` | `• a\n• b` |
| Ordered list | `1. a\n2. b` | `1. a\n2. b` |
| Task list unchecked | `- [ ] todo` | `• ☐ todo` |
| Task list checked | `- [x] done` | `• ☑ done` |
| Table | `\|a\|b\|\n\|--\|--\|\n\|1\|2\|` | `<pre>` pipe table |
| Spoiler | `\|\|secret\|\|` | `<tg-spoiler>secret</tg-spoiler>` |
| HR | `---` | `───` |
| File ref TLD collision | `readme.md` | `<code>readme.md</code>` |
| File ref in code | `` `readme.md` `` | No double-wrap |
| De-linkify file ref | `http://readme.md` auto-linked | `<code>readme.md</code>` |
| HTML in markdown | `<script>` | `&lt;script&gt;` |
| Asterisk in text | `5 * 3 = 15` | No italic trigger |
| Mixed nested | `**bold *italic* bold**` | Correct nesting |

### telegram-split.test.ts (~100 lines)

| Case | Input | Expected |
|---|---|---|
| Short text | `"hello"` | `["hello"]` |
| Over limit | 5000 chars plain | 2 chunks, each <= 4000 |
| HTML tag spanning | `<b>` + 5000 chars + `</b>` | Chunk 1 ends with `</b>`, chunk 2 reopens `<b>` |
| Nested tags | `<b><i>` + long text | Both tags closed/reopened at boundaries |
| Entity safety | `&amp;` at split boundary | Not split mid-entity |
| Self-closing tags | `<br>` in text | No stack corruption |
| Aligned plain text | 3 HTML chunks | 3 aligned plain chunks |

### agent-bridge.test.ts (~120 lines)

LLM mocked, tools real (or mocked depending on test).

| Case | Setup | Expected |
|---|---|---|
| Simple response | LLM returns text only | Text returned, 2 messages in session (user + assistant) |
| Single tool call | LLM returns tool_call then text | Tool executed, 4 messages in session (user + assistant+tc + tool + assistant) |
| Multi-turn tools | LLM returns tool_calls 3 times then text | All tools executed in order, correct message count |
| Max iterations | LLM always returns tool_calls | Stops at 10, returns fallback message |
| Unknown tool | LLM calls nonexistent tool | Error string returned to LLM, loop continues |
| Tool throws | Tool.execute throws | Error caught, string returned to LLM |
| Attachments | Message with attachments | User content includes `[Attachments]` block |
| Session history | Messages from previous turns in session | All sent to LLM as context |

### send-pipeline.test.ts (~100 lines)

bot.api mocked.

| Case | Setup | Expected |
|---|---|---|
| Short text | Text < 4000 | Single `sendMessage` with HTML |
| Long text | Text > 4000 | Multiple `sendMessage` calls, chunked |
| Parse error fallback | `sendMessage` throws parse error | Retried with plain text |
| Thread not found | `sendMessage` throws thread error | Retried without `message_thread_id` |
| Caption on media | Text <= 1024 + MEDIA ref | `sendPhoto` with caption, no separate text |
| No caption long text | Text > 1024 + MEDIA ref | Separate text messages + `sendPhoto` without caption |
| Caption parse fallback | `sendPhoto` with HTML caption throws parse error | Retried with plain caption |
| Retry on network error | `sendMessage` throws ECONNREFUSED | Retried with backoff |
| No retry on other error | `sendMessage` throws 400 | Not retried |
| Link preview disabled | Config `linkPreview: false` | `link_preview_options.is_disabled` in params |

### inbound-flow.test.ts (~80 lines)

Full pipeline mock: simulated Telegram message -> adapter -> router -> bridge -> mock LLM -> adapter.send.

| Case | Setup | Expected |
|---|---|---|
| Happy path DM | Authorized user sends text | LLM called, response sent to chat |
| Unauthorized | Unknown user sends text | No processing, no response |
| Text batching | 2 messages > 4000 chars, rapid fire | Batched into single LLM call |
| Media group | 3 photos in album | Single message with 3 attachments |
| Tmp cleanup | Message with photo | Tmp file deleted after processing |
| Tmp cleanup on error | LLM throws | Tmp file still deleted |

### commands.test.ts (~60 lines)

| Case | Setup | Expected |
|---|---|---|
| /new | Active session | Session reset, "New session started." |
| /clear | Session with messages | Messages cleared, session preserved |
| /model no args | Default config | "Current model: ..." |
| /status active | Session with 5 messages | All fields present |
| /status no session | No prior messages | "none active" |
| /help | Any state | All commands listed |

### streaming.test.ts (~80 lines, Phase 2)

| Case | Setup | Expected |
|---|---|---|
| Normal stream | 200 chars streamed | Initial send after 30 chars, edits every ~1s, final edit with HTML |
| Short response | 10 chars | No streaming, single send on finish |
| Overflow | 5000 chars streamed | First message edited to limit, second message sent |
| Edit fails "not modified" | Same content twice | Ignored, no error |
| Edit fails "not found" | User deleted msg | Stream aborted gracefully |
| Stream + tool call | LLM streams then tool_call | Edit with current text, tool executes, new message for next response |

### reactions.test.ts (~40 lines, Phase 2)

| Case | Setup | Expected |
|---|---|---|
| Full lifecycle | Message processed | received -> thinking -> done |
| Error lifecycle | Processing fails | received -> thinking -> error |
| Disabled | Config `enabled: false` | No API calls |
| API fails | `setMessageReaction` throws | Silently ignored |

### error-policy.test.ts (~40 lines, Phase 2)

| Case | Setup | Expected |
|---|---|---|
| always | Any error | `shouldReport` returns true |
| silent | Any error | `shouldReport` returns false |
| once first | New error key | `shouldReport` returns true |
| once duplicate | Same key within cooldown | `shouldReport` returns false |
| once after cooldown | Same key after cooldown | `shouldReport` returns true |

### model-picker.test.ts (~50 lines, Phase 2)

| Case | Setup | Expected |
|---|---|---|
| Build keyboard | 4 models, current = 2nd | 4 buttons, 2nd marked with checkmark |
| Parse callback | `mdl:2` | Returns 3rd model ID |
| Invalid callback | `mdl:99` | Returns null |
| No models config | `models` field absent | Shows current model, no picker |
| Model override | User picks model | `sessionData.modelOverride` updated |

### Running Tests

Add to `package.json`:
```json
{
  "scripts": {
    "test": "bun test",
    "test:watch": "bun test --watch"
  }
}
```

Tests live in `tests/` at project root. No test config file needed — `bun test` finds `*.test.ts` automatically.

### Estimated Work

~820 lines across 10 test files. Phase 1 tests (~610 lines) can be written before Phase 2 features.
Phase 2 tests (~210 lines) are written as each feature is completed.

## Total Estimated Work (Phase 2 + Tests)

~410 new lines for Phase 2 features + ~100 lines modifications + ~820 lines tests.
Each step is independently testable. Steps 2 and 3 can be done in parallel.
