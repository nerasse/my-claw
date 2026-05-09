# Platform Feature Comparison

## Overview

This document lists implemented features for Telegram and Matrix channels in `my-claw`, with a comparative table showing platform-specific limitations and why certain features are not implemented on each platform.

## Telegram Features

### Implemented

| Feature | Description | Limitations |
|---------|-------------|-------------|
| **Polling Mode** | Long-polling via `getUpdates` | Default mode, no infra needed |
| **Webhook Mode** | HTTP server receiving push updates | Requires valid SSL cert, specific ports (443, 80, 88, 8443) |
| **Command Registration** | `setMyCommands()` publishes commands in Telegram UI | Platform-native feature |
| **Inline Keyboards** | Callback buttons with `callback_query` | Only inline buttons, no reaction-based actions |
| **Reply Modes** | `off`, `first`, `all` | `"batched"` not available — Telegram API sends messages one-by-one, no batch text API |
| **Message Batching** | Rapid consecutive messages merged into single input | Input-side only (buffering), not output-side |
| **Media Group Buffering** | Albums merged into single `UnifiedMessage` | Uses `media_group_id` from Telegram |
| **Retry Logic** | Exponential backoff with rate-limit wait | 3 attempts, 400ms base delay, max 30s |
| **HTML Parse Fallback** | Falls back to plain text if HTML parsing fails | Telegram-specific feature |
| **Caption Pipeline** | Short text (<=1024 chars) attached to first media item | Telegram caption limit: 1024 chars |
| **Poll Normalization** | Polls converted to plain text for routing | Normalized text only, no rich poll lifecycle |
| **Replay Safety** | Persistent offset store with claim/commit/release | `update_id` watermark — server forgets acked updates immediately |
| **Typing Indicator** | Ref-counted per chatId | 5s interval |
| **Thread ID Tracking** | `message_id -> message_thread_id` mapping | Forum topics only, general topic (ID=1) excluded |
| **Confirmations** | Accept/Deny inline keyboard with 5min timeout | Inline-only, no reaction alternative |
| **Markdown to HTML** | Full markdown-it tokenization | Telegram HTML subset |
| **HTML-Aware Splitting** | Tag-aware chunking at 4000 chars | Hard limit: 4096 chars per message (API-enforced) |
| **Voice Handling** | Native voice message support | Platform-specific |
| **Link Preview Toggle** | `linkPreview: false` | Telegram-specific |
| **Thread-Not-Found Fallback** | Retry without `message_thread_id` | Telegram-specific error handling |
| **Session Scoping** | DM per-user/per-chat, group, thread | Full support |
| **Policy & Gating** | DM/group policy, allowlists, mention gating, bot gating | Full support |
| **Context Visibility** | `all`, `allowlist`, `allowlist_quote` | Full support |

### Not Implemented (Platform Limitations)

| Feature | Why Not Implemented | Platform Constraint |
|---------|---------------------|---------------------|
| **`replyToMode: "batched"`** | Telegram Bot API has no batch text message API | `sendMessage` sends one message per HTTP call. Only `sendMediaGroup` batches media (max 10 items). `"batched"` would behave identically to `"first"`. |
| **Clean-Shutdown Marker** | Telegram's `update_id` mechanism is stateless | Server forgets updates immediately after ack. No sync token lifecycle like Matrix. `drop_pending_updates` already covers startup cleanup. |
| **Cold-Start Backlog Drop** | Not applicable to Telegram's model | `getUpdates` without offset returns only recent unconfirmed window (not deep backlog). No `full_state` sync like Matrix. |
| **Persistent Inbound Dedupe** | Not needed — watermark sufficient | `update_id` is monotonic per update. Watermark dedupe (`update_id <= lastSeen`) covers all cases without persistent storage. |
| **Cross-Process Overlap Protection** | Live claim files not needed | Offset-based processing naturally handles overlaps. Only one update processed at a time per bot. |
| **`textChunkLimit` Configurable** | Hard limit enforced by API | Telegram rejects messages > 4096 chars. Configurable limit below 4096 is possible but provides marginal value. |
| **`chunkMode: "newline"`** | Risk of API errors | Pure newline splitting could produce chunks > 4096 chars, causing `message_too_long` errors. HTML-aware length-based splitting is required. |
| **Read Receipts** | Not in Bot API | Telegram bots cannot send read receipts. Only message delivery confirmation. |
| **Notice/Quiet Mode** | Not in Bot API | No `m.notice` equivalent. All bot messages are normal messages. |
| **E2EE** | Not available for bots | Bot API does not support encryption. Only client-to-client E2EE exists in Telegram. |
| **Encrypted Media** | Not available for bots | Same E2EE limitation. |
| **Auto-Join** | Not applicable | Telegram bots are added by users, cannot auto-join. |

---

## Matrix Features

### Implemented

| Feature | Description | Limitations |
|---------|-------------|-------------|
| **SDK Sync Loop** | Matrix SDK `startClient()` with sync events | Full state sync, initial sync limit configurable |
| **Auto-Join** | Auto-join invited rooms per config | Based on allowlist |
| **Read Receipts** | `m.read` receipts sent for processed events | Standard Matrix feature |
| **Notice/Quiet Mode** | `m.notice` message type + `quiet` streaming mode | Platform-native |
| **Reaction-Driven Actions** | Menu actions via reactions on messages | No inline buttons, reactions only |
| **Reply Modes** | `off`, `first`, `all`, `batched` | Full support including `"batched"` (behaves as single-use reply) |
| **Thread Relations** | True thread relations end-to-end | `m.thread` relations on inbound/outbound |
| **Thread-Scoped Sessions** | Sessions per thread ID | Full support |
| **Chunking Policy** | `textChunkLimit` + `chunkMode: "length" \| "newline"` | Configurable, Matrix events support ~65KB |
| **Persisted Sync Store** | Sync state saved locally | Enables restart recovery |
| **Clean-Shutdown Marker** | Trust replay only after clean shutdown | Prevents bad replay after crash |
| **Cold-Start Backlog Drop** | Drop pre-startup backlog if sync untrusted | Prevents stale processing |
| **Persistent Inbound Dedupe** | `claim -> commit` with TTL pruning | Survives restarts |
| **Cross-Process Overlap Protection** | Live claim files + lock | Prevents duplicate processing with `bun --watch` |
| **E2EE** | Encrypted event handling | Full SDK decryption support |
| **Encrypted Media Download** | Decrypt media attachments | Requires crypto ready |
| **Encrypted Media Upload** | Encrypt uploads for encrypted rooms | Full support |
| **Crypto Snapshot Persistence** | Local crypto snapshot | Can seed from OpenClaw snapshot |
| **Session Scoping** | DM per-user/per-room, room, thread | Full support |
| **Policy & Gating** | DM/room policy, allowlists, mention gating, bot gating | Full support |
| **Context Visibility** | `all`, `allowlist`, `allowlist_quote` | Full support |
| **Poll Normalization** | Polls converted to plain text | Richer poll event model available |
| **Retry Logic** | `withMatrixRetry()` on send/edit/upload/stream | Covers delivery paths |
| **Rate-Limit Handling** | Honors `retry_after_ms` | On retryable delivery errors |

### Not Implemented (Platform Limitations)

| Feature | Why Not Implemented | Platform Constraint |
|---------|---------------------|---------------------|
| **Native Command Registration** | Matrix has no universal command UI | Commands parsed from text messages (`/command`). No client-side command list like Telegram's `setMyCommands()`. |
| **Inline Buttons** | Matrix uses reactions instead | Matrix spec has no inline button concept. Reactions are the closest equivalent. |
| **Webhook Mode** | Matrix transport is sync-based | Matrix uses client-server sync API, not HTTP webhooks. Long-polling/sync loop is the native model. |
| **HTML Parse Fallback** | Matrix accepts arbitrary HTML | Matrix clients render HTML directly. No parse-validation step like Telegram. Fallback unnecessary. |
| **Link Preview Toggle** | Not controllable at protocol level | Link previews are client-rendered. Server cannot disable them. |
| **Thread-Not-Found Fallback** | Threading works differently | Matrix threads are relation-based, not topic-based. No "missing thread" error. |
| **Native Forwarded Flag** | No native `forwarded` event field | Bridge/relay heuristics used instead. Matrix has no native forwarded concept. |
| **Voice-Specific Handling** | Treated as generic audio | Matrix audio events are uniform. No voice-specific message type. |
| **Typing Indicator** | Not yet implemented | Matrix supports typing indicators (`m.typing`), but adapter doesn't send them yet. |

---

## Cross-Platform Comparative Table

### Core Transport

| Feature | Telegram | Matrix | Why the Difference? |
|---------|----------|--------|---------------------|
| Polling | ✅ Yes (default) | ❌ No | Matrix uses sync loop, not polling |
| Webhook | ✅ Yes | ❌ No | Matrix is sync-based, not push-based |
| SDK Sync | ❌ No | ✅ Yes | Telegram has no sync protocol |
| Auto-Join | ❌ No | ✅ Yes | Telegram bots are invited, cannot auto-join |
| Command Registration | ✅ Native (`setMyCommands`) | ❌ Text-only | Matrix has no universal command UI API |

### Message Delivery

| Feature | Telegram | Matrix | Why the Difference? |
|---------|----------|--------|---------------------|
| Max Message Length | 4096 chars (hard API limit) | ~65KB (soft limit) | Telegram enforces server-side; Matrix is client-rendered |
| Chunk Mode | Length-based only (HTML-aware) | `length` or `newline` | Telegram's 4096 limit makes pure newline splitting unsafe |
| Configurable Chunk Limit | ❌ No (capped at 4096) | ✅ Yes | Telegram API rejects >4096; Matrix allows flexibility |
| HTML Parse Fallback | ✅ Yes | ❌ No (not needed) | Telegram validates HTML server-side; Matrix renders client-side |
| Link Preview Toggle | ✅ Yes | ❌ No | Telegram server controls previews; Matrix clients render independently |
| Notice/Quiet Mode | ❌ No | ✅ Yes (`m.notice`) | Telegram has no equivalent message type |
| Read Receipts | ❌ No | ✅ Yes | Telegram Bot API doesn't expose read receipts |

### Threading & Replies

| Feature | Telegram | Matrix | Why the Difference? |
|---------|----------|--------|---------------------|
| Thread Model | Forum topics (`message_thread_id`) | True thread relations (`m.thread`) | Different platform semantics |
| Thread Sessions | ✅ Yes | ✅ Yes | Both support |
| Reply Modes | `off`, `first`, `all` | `off`, `first`, `all`, `batched` | `"batched"` meaningless on Telegram (no batch send API) |
| Thread-Not-Found Fallback | ✅ Yes | ❌ No (not applicable) | Telegram topics can be deleted; Matrix threads are relation-based |

### Reliability & State

| Feature | Telegram | Matrix | Why the Difference? |
|---------|----------|--------|---------------------|
| Replay Safety | Offset watermark (`update_id`) | Persisted sync token + dedupe | Telegram is stateless (server forgets); Matrix has sync lifecycle |
| Clean-Shutdown Marker | ❌ No (not needed) | ✅ Yes | Telegram's offset is inherently crash-safe |
| Cold-Start Backlog Drop | ❌ No (not applicable) | ✅ Yes | Telegram returns only recent window; Matrix returns full room history |
| Persistent Dedupe | ❌ No (not needed) | ✅ Yes | Telegram watermark covers it; Matrix needs event-level dedupe |
| Cross-Process Protection | ❌ No (not needed) | ✅ Yes | Telegram processes one update at a time; Matrix has concurrent sync |
| E2EE | ❌ No (bots cannot use) | ✅ Yes | Telegram E2EE is client-only; Matrix supports bot E2EE via SDK |
| Encrypted Media | ❌ No | ✅ Yes | Same E2EE difference |

### Interactions

| Feature | Telegram | Matrix | Why the Difference? |
|---------|----------|--------|---------------------|
| Inline Buttons | ✅ Yes | ❌ No | Matrix has no inline button concept; reactions are alternative |
| Reaction Actions | ❌ No | ✅ Yes | Telegram has reactions but not as action triggers |
| Confirmation UI | Inline keyboard | Reactions or plain text | Matrix lacks native inline UI |
| Typing Indicator | ✅ Yes | ❌ No (not yet) | Matrix supports it but not wired in adapter |
| Native Forwarded Flag | ✅ Yes (`forward_origin`) | ❌ No (heuristics) | Matrix has no native forwarded event field |

### Media

| Feature | Telegram | Matrix | Why the Difference? |
|---------|----------|--------|---------------------|
| Media Group / Album | ✅ Yes (`sendMediaGroup`, max 10) | ❌ No (bursts only) | Matrix has no album API; can accumulate bursts |
| Caption on First Media | ✅ Yes (<=1024 chars) | ⚠️ Partial (reconstructed) | Telegram has native caption field; Matrix attaches text separately |
| Voice Handling | ✅ Yes (native) | ❌ No (generic audio) | Matrix has no voice-specific event type |
| Max Media Size Config | ❌ No | ✅ Yes (`mediaMaxMb`) | Matrix allows configuration |

### Polls

| Feature | Telegram | Matrix | Why the Difference? |
|---------|----------|--------|---------------------|
| Poll Normalization | ✅ Yes (text) | ✅ Yes (text) | Both normalize to text |
| Rich Poll Lifecycle | ❌ No (text only) | ✅ Yes (event model) | Matrix has richer poll events |

---

## Key Architectural Differences

### Telegram Model
- **Stateless**: Server forgets updates immediately after ack via `offset`
- **One-by-one**: Each message requires a separate API call
- **Server-validated**: HTML, length limits enforced by Telegram servers
- **Bot-centric**: API designed specifically for bot interactions

### Matrix Model
- **Stateful**: Sync token tracks client state; server remembers history
- **Flexible transport**: Sync loop allows batching and backfill
- **Client-rendered**: HTML/length validated by clients, not server
- **Protocol-generic**: Not bot-specific; supports full client features

---

## Why Certain Gaps Are Not Implementation Gaps

| Gap | Telegram | Matrix | Reason |
|-----|----------|--------|--------|
| `replyToMode: "batched"` | Not meaningful | Supported | Telegram has no batch send API for text |
| Clean-shutdown marker | Not needed | Implemented | Telegram's offset is already crash-safe |
| Cold-start backlog drop | Not applicable | Implemented | Telegram returns only recent window |
| `chunkMode: "newline"` | Unsafe | Supported | Telegram's 4096 limit makes it risky |
| E2EE | Not for bots | Implemented | Telegram E2EE is client-only |
| Inline buttons | Implemented | Not possible | Matrix has no inline button concept |
| Native commands | Implemented | Not possible | Matrix has no command registration API |
| Webhook mode | Implemented | Not possible | Matrix uses sync, not push |
| Auto-join | Not possible | Implemented | Telegram requires user invitation |

---

## Document History

- **Created**: Replaced `telegram-phase1.md` and `telegram-vs-matrix.md`
- **Rationale**: Consolidate platform features into a single reference with clear explanations of why features differ, eliminating the concept of "gaps" in favor of "platform-specific capabilities"
