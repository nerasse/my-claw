# Telegram vs Matrix

## Scope

This document compares the current implementation in `my-claw`.
It describes what is really implemented and wired today, not an ideal target state.

Main sources:

- `src/channels/telegram.ts`
- `src/channels/matrix.ts`
- `src/channels/matrix-client.ts`
- `src/channels/telegram-session-handlers.ts`
- `src/channels/matrix-session-handlers.ts`
- `src/config.ts`
- `docs/telegram-phase1.md`
- `docs/matrix.md`

## Legend

| Value | Meaning |
|---|---|
| Yes | Implemented and wired in the current flow |
| Partial | Implemented with important limits, or only available in channel-specific code |
| No | Not implemented in the current flow |

## Gap Analysis

### Telegram > Matrix

| Gap | Telegram | Matrix | Why it matters |
|---|---|---|---|
| Native webhook mode | Yes | No | Telegram can run in polling or webhook mode. Matrix currently runs via Matrix SDK sync only. |
| Native platform command registration | Yes | No | Telegram publishes commands via `setMyCommands()`. Matrix only parses `/...` messages locally. |
| Inline keyboard callbacks | Yes | No | Telegram has true inline buttons with callback queries. Matrix uses reaction-driven actions instead. |
| Accept / Deny confirmation UI | Partial | Partial | Telegram adapter has generic `confirm()` with inline buttons and timeout. Matrix now has generic adapter-level confirm prompts via reactions or plain-text reply, but still lacks Telegram-style native inline UI. |
| Long text batching across multiple inbound messages | Yes | Partial | Telegram can merge rapid consecutive long messages from the same user into one logical input. Matrix now coalesces some rapid fragmented bursts when reply/thread context matches. |
| Media group / album buffering | Yes | Partial | Telegram can merge grouped media into one normalized message. Matrix can accumulate compatible attachment bursts, but still lacks a broad album-normalization layer. |
| Explicit retry and rate-limit backoff | Yes | Partial | Telegram has exponential retry, rate-limit wait, and pre-connect retry handling. Matrix now retries send/edit/upload/stream paths with backoff, but transport coverage is still narrower. |
| HTML parse fallback to plain text | Yes | No | Telegram retries plain text when Telegram HTML parsing fails. Matrix has no comparable HTML-parse fallback path. |
| First-media caption pipeline | Yes | Partial | Telegram can attach short text as caption on the first media item. Matrix can now reconstruct some short trailing text followups as captions on buffered media bursts, but still lacks full grouped-media semantics. |
| Link preview disable toggle | Yes | No | Telegram supports `linkPreview: false`. Matrix has no equivalent adapter-level toggle. |
| Thread-not-found send fallback | Yes | No | Telegram can retry without `message_thread_id` when a topic is missing. Matrix has no equivalent because threading works differently. |
| Forwarded flag normalization | Yes | Partial | Telegram sets `isForwarded` from `forward_origin`. Matrix now sets `isForwarded` with bridge/relay heuristics rather than a native forwarded flag. |

### Matrix > Telegram

| Gap | Telegram | Matrix | Why it matters |
|---|---|---|---|
| DM policy config | No | Yes | Matrix supports `open | allowlist | disabled` for DMs. |
| Group policy config | No | Yes | Matrix supports `open | allowlist | disabled` for groups/rooms. |
| Room-specific config and wildcard room config | No | Yes | Matrix supports `groups[roomId]` and `groups["*"]`. |
| Auto-join invited rooms | No | Yes | Matrix can auto-join according to config and allowlist. |
| Bot sender policy | No | Yes | Matrix can allow or deny configured bot users with `botUserIds` and `allowBots`. |
| Visible-mention filtering | No | Yes | Matrix only triggers on visible mentions, not metadata-only mentions. |
| Poll normalization | No | Yes | Matrix poll events are turned into text for routing and room history. |
| Reply context | No | Yes | Matrix resolves reply sender and quoted text into the normalized message. |
| Thread root context | No | Yes | Matrix resolves thread root text and sender. |
| Recent room context | No | Yes | Matrix can inject pending-only room history via `historyLimit`. |
| Context visibility policy | No | Yes | Matrix supports `all | allowlist | allowlist_quote` for supplemental context. |
| True thread support | Partial | Yes | Telegram routes to forum topics, but Matrix has real thread relations on inbound and outbound messages. |
| Thread-scoped sessions | No | Yes | Matrix can store one session per thread. |
| DM session scope per user or per room | No | Yes | Matrix supports `per-user` and `per-room` DM session scope. |
| Read receipts | No | Yes | Matrix sends read receipts for processed events. |
| Quiet / notice mode | No | Yes | Matrix can send `m.notice` and has `quiet` streaming mode. |
| Reply behavior tuning | No | Yes | Matrix supports `replyToMode: off | first | all | batched`. |
| Chunking policy tuning | No | Yes | Matrix supports `textChunkLimit` and `chunkMode`. |
| Persisted sync store | No | Yes | Matrix persists sync state to local storage. |
| Clean-shutdown replay trust | No | Yes | Matrix only trusts persisted replay after clean shutdown. |
| Cold-start backlog drop | No | Yes | Matrix drops pre-startup backlog when replay state is not trusted. |
| Persistent inbound dedupe | No | Yes | Matrix persists committed inbound events across restarts. |
| Cross-process live claim protection | No | Yes | Matrix uses live claim files and a lock to protect against overlapping processes. |
| E2EE message handling | No | Yes | Matrix supports encrypted event handling after SDK decryption. |
| Encrypted media download | No | Yes | Matrix can decrypt encrypted media attachments. |
| Encrypted media upload | No | Yes | Matrix can encrypt uploads for encrypted rooms. |
| Crypto snapshot persistence | No | Yes | Matrix persists its own crypto snapshot locally. |
| OpenClaw crypto snapshot seeding | No | Yes | Matrix can seed its first local crypto snapshot from the matching OpenClaw snapshot. |

## Complete Detailed Comparison

### Transport and startup

| Feature | Telegram | Matrix | Notes |
|---|---|---|---|
| Channel enable toggle | Yes | Yes | `channels.telegram.enabled` and `channels.matrix.enabled` |
| Startup adapter wiring | Yes | Yes | Both are wired in `src/index.ts` |
| Polling mode | Yes | No | Telegram default |
| Webhook mode | Yes | No | Telegram via `Bun.serve()` |
| Immediate ACK webhook processing | Yes | No | Telegram returns 200 before async processing |
| Secret validation on inbound webhook | Yes | No | Telegram checks `x-telegram-bot-api-secret-token` |
| SDK sync loop | No | Yes | Matrix uses `startClient()` and sync events |
| Initial sync limit config | No | Yes | Matrix supports `initialSyncLimit` |
| Auto-join on invite | No | Yes | Matrix only |

### Auth and routing policy

| Feature | Telegram | Matrix | Notes |
|---|---|---|---|
| Global whitelist | Yes | Yes | Both filter unauthorized users early |
| Router-level auth guard | Yes | Yes | Defense in depth |
| DM policy config | No | Yes | Matrix: `open | allowlist | disabled` |
| Group policy config | No | Yes | Matrix: `open | allowlist | disabled` |
| Per-room allowlist config | No | Yes | Matrix room config |
| Wildcard room config | No | Yes | Matrix `groups["*"]` |
| Require mention in group by config | No | Yes | Matrix room-level behavior |
| Allow configured bot senders | No | Yes | Matrix `botUserIds` + `allowBots` |
| Visible mention detection | No | Yes | Matrix ignores hidden metadata mentions |

### Commands and session controls

| Feature | Telegram | Matrix | Notes |
|---|---|---|---|
| `/new` | Yes | Yes | Resets session and auto-archives previous session |
| `/clear` | Yes | Yes | Clears message history only |
| `/model` | Yes | Yes | Text command on both |
| `/status` | Yes | Yes | Text status on both |
| `/help` | Yes | Yes | Static help text on both |
| `/archive` delete archives | Yes | Yes | Deletes archives created by `/new`; does not create archives |
| Native command registration on platform | Yes | No | Telegram sets commands in the Bot API |
| Model change by text argument | Yes | Yes | Telegram by name/id, Matrix by name/number |
| Interactive model selection | Yes | Yes | Telegram buttons vs Matrix reactions |

### Session model

| Feature | Telegram | Matrix | Notes |
|---|---|---|---|
| DM session per user | Yes | Yes | Both support this |
| DM session per room | No | Yes | Matrix `sessionScope: per-room` |
| Group/room session | Yes | Yes | Telegram group session, Matrix room session |
| Thread session | No | Yes | Matrix supports session per thread |
| Topic-aware reply routing | Partial | Yes | Telegram stores `message_id -> message_thread_id`; Matrix has real thread relations |

### Inbound message handling

| Feature | Telegram | Matrix | Notes |
|---|---|---|---|
| DM inbound messages | Yes | Yes | Both |
| Group/room inbound messages | Yes | Yes | Both |
| Ignore self messages | Partial | Yes | Telegram ignores bot messages; Matrix ignores own sender id |
| Forwarded flag normalization | Yes | Partial | Matrix sets `isForwarded` via bridge/relay heuristics, not a native Matrix forwarded flag |
| Reply id normalization | No | Yes | Matrix fills `replyToId` |
| Reply text normalization | No | Yes | Matrix fetches and summarizes reply context |
| Reply sender normalization | No | Yes | Matrix fills `replyToSender` |
| Thread id normalization | Partial | Yes | Telegram mostly uses topic routing, Matrix exposes thread id directly |
| Thread root text normalization | No | Yes | Matrix fills `threadRootText` |
| Recent room context normalization | No | Yes | Matrix fills `roomContext` |
| Mentioned-bot signal | No | Yes | Matrix fills `mentionsBot` |
| Poll normalization | No | Yes | Matrix converts poll events to text |
| Long text inbound batching | Yes | Partial | Matrix coalesces some rapid fragmented bursts, but not full general turn batching |
| Media group inbound buffering | Yes | Partial | Matrix can merge compatible attachment bursts, but not full album semantics |
| Per-room serialized ingress | No | Yes | Matrix protects room history ordering |

### Attachments and media

| Feature | Telegram | Matrix | Notes |
|---|---|---|---|
| Inbound attachments | Yes | Yes | Both download to local temp files |
| Outbound attachments | Yes | Yes | Both |
| `MEDIA:/path` outbound refs | Yes | Yes | Both |
| Image/audio/video/file support | Yes | Yes | Both cover the shared attachment types |
| Voice-specific handling | Yes | Partial | Telegram has native voice handling; Matrix treats audio generically |
| Album/media-group merge | Yes | No | Telegram only |
| First-item caption logic | Yes | Partial | Matrix can reconstruct some coalesced media-followup captions, but not full Telegram media-group caption semantics |
| Attachment summary text when content is unavailable | Partial | Yes | Matrix keeps `summaryText`; Telegram generally drops failed downloads |
| Configurable max media size | No | Yes | Matrix `mediaMaxMb` |
| Encrypted media download | No | Yes | Matrix only |
| Encrypted media upload | No | Yes | Matrix only |

### Formatting and outbound delivery

| Feature | Telegram | Matrix | Notes |
|---|---|---|---|
| Outbound text | Yes | Yes | Both |
| Markdown to native rich text | Yes | Yes | Telegram HTML vs Matrix HTML |
| Format-aware splitting | Yes | Partial | Telegram is HTML-aware; Matrix chunks text with simpler logic |
| Configurable text chunk limit | No | Yes | Matrix only |
| Configurable chunking mode | No | Yes | Matrix `length | newline` |
| Reply send support | Yes | Yes | Both |
| Thread reply send support | Partial | Yes | Telegram via topic id, Matrix via thread relation |
| Reply mode tuning | No | Yes | Matrix `replyToMode` |
| Link preview disable | Yes | No | Telegram only |
| Notice / quiet send type | No | Yes | Matrix can emit `m.notice` |
| HTML parse fallback to plain text | Yes | No | Telegram only |
| Thread-not-found fallback | Yes | No | Telegram only |

### Streaming

| Feature | Telegram | Matrix | Notes |
|---|---|---|---|
| Streaming enable toggle | Yes | Yes | Both |
| Token-by-token preview | Yes | Yes | Both |
| Edit throttle config | Yes | Yes | Both |
| Minimum chars before preview | Yes | Yes | Both |
| Tool-use split lane | Yes | Yes | Both |
| Abort cleanup | Yes | Yes | Both |
| Multi-message preview lanes | Yes | Partial | Telegram can keep multiple preview messages; Matrix falls back sooner |
| Quiet streaming mode | No | Yes | Matrix `streaming.mode = quiet` |
| Preview fallback by delete/redeliver | Partial | Yes | Matrix redacts preview before normal final send when needed |

### Interactive UI and actions

| Feature | Telegram | Matrix | Notes |
|---|---|---|---|
| Status reactions | Yes | Yes | Both show received/thinking/tool_use/done/error |
| Interactive model menu | Yes | Yes | Both |
| Native inline buttons | Yes | No | Telegram only |
| Reaction-driven action menu | No | Yes | Matrix uses reactions on a sent message |
| Generic callback/action handler | Yes | Yes | Telegram callback queries, Matrix reactions |
| Accept/Deny confirmation prompt | Partial | No | Telegram adapter-only capability |

### Reliability and recovery

| Feature | Telegram | Matrix | Notes |
|---|---|---|---|
| Retry wrapper for sends | Yes | Yes | Telegram explicit `withRetry()`; Matrix now wraps send/edit/upload/stream delivery paths with `withMatrixRetry()` |
| Explicit rate-limit wait | Yes | Partial | Telegram handles 429 + `retry_after`; Matrix honors `retry_after_ms` when surfaced on retryable delivery errors |
| Pre-connect network retry | Yes | Partial | Telegram retries DNS/socket pre-connect failures. Matrix retries many transient connect/reset/closed delivery errors, but not every transport surface |
| Persisted transport state | No | Yes | Matrix sync store |
| Clean shutdown marker | No | Yes | Matrix only |
| Trusted replay after clean shutdown | No | Yes | Matrix only |
| Cold-start backlog filtering | No | Yes | Matrix only |
| Persistent inbound dedupe | No | Yes | Matrix only |
| Cross-process overlap protection | No | Yes | Matrix lock + live claims |

### Encryption and local state

| Feature | Telegram | Matrix | Notes |
|---|---|---|---|
| Channel-level encryption support | No | Yes | Matrix only |
| Encrypted event handling | No | Yes | Matrix decrypt bridge |
| Late decrypt retry | No | Yes | Matrix retries decryption when crypto becomes ready |
| Local crypto snapshot | No | Yes | Matrix only |
| Local sync cache | No | Yes | Matrix only |
| Seed from OpenClaw crypto snapshot | No | Yes | Matrix only |

## Practical Summary

| If you need... | Better today |
|---|---|
| Simple bot transport, webhook support, and true inline buttons | Telegram |
| Rich room policy, real threads, contextual message reconstruction, replay safety, and E2EE | Matrix |

The biggest Telegram-side gaps in Matrix are UI and transport ergonomics.
The biggest Matrix-side gaps in Telegram are stateful room semantics, replay safety, and encryption.

## Parity Priorities

### Priority list: Telegram -> Matrix

These are the highest-value Telegram capabilities that Matrix still lacks if the goal is better cross-channel parity.

| Priority | Feature to port toward Matrix parity | Current gap | User impact | Implementation cost | Why this priority |
|---|---|---|---|---|---|
| P1 | Better interactive actions than reaction-only menus | Telegram has true inline buttons and callback flows. Matrix uses reactions as a workaround. | High | High | This is the most visible UX asymmetry today. |
| P2 | Confirmation flow equivalent to Telegram Accept/Deny | Partially closed. Matrix now has a general-purpose adapter-wide confirm primitive plus tool approval prompts, but still lacks Telegram-style native inline UI. | High | Medium | Important for sensitive-action approval UX; the remaining gap is mainly Matrix interaction ergonomics. |
| P3 | Stronger send retry and transient network recovery | Mostly closed. Matrix now retries send/edit/upload paths, but still has less mature transport ergonomics than Telegram overall. | High | Low | The biggest reliability gap was the missing retry layer; remaining differences are polish. |
| P4 | Album / grouped media ingestion semantics | Telegram merges media groups into one logical message. Matrix currently handles events individually. | Medium | Medium | Matters for multimodal user input quality. |
| P5 | Long multi-message batching | Telegram can merge consecutive long messages into one prompt input. Matrix now coalesces some rapid fragmented group and top-level thread bursts, but not general turn reconstruction. | Medium | Medium | Improves UX for users who paste in chunks. |
| P6 | Better command ergonomics / discoverability | Telegram publishes commands in the platform UI. Matrix does not. | Medium | Low | Lower engineering cost, but less critical than actions and reliability. |
| P7 | Link-preview style delivery controls | Telegram exposes a preview toggle. Matrix does not. | Low | Low | Useful but not a top product gap. |
| P8 | Forwarded-message normalization parity | Telegram exposes forwarded state. Matrix does not. | Low | Medium | Helpful context, but lower impact than action UI or retries. |

### Priority list: Matrix -> Telegram

These are the highest-value Matrix capabilities that Telegram still lacks if the goal is better cross-channel parity.

| Priority | Feature to port toward Telegram parity | Current gap | User impact | Implementation cost | Why this priority |
|---|---|---|---|---|---|
| P1 | Reply/thread/history context reconstruction | Matrix fills reply, thread, and room context. Telegram does not. | High | Medium | This is the largest intelligence/context quality gap. |
| P2 | Session scoping beyond simple DM/group | Matrix supports per-room DM sessions and thread sessions. Telegram does not. | High | Medium | Important for forum/topic workflows and clean context isolation. |
| P3 | Fine-grained policy model | Matrix has DM policy, group policy, room config, bot policy, mention policy. Telegram has only whitelist-level gating. | High | Medium | Important if Telegram usage expands beyond simple trusted chats. |
| P4 | Persistent replay safety / dedupe semantics | Matrix persists sync state, trusted replay, and inbound dedupe. Telegram does not have an equivalent transport-state layer. | Medium | High | Less visible day one, but very important for robustness and restart correctness. |
| P5 | Mention-aware routing and bot gating | Matrix can tell whether the bot was visibly mentioned and can gate bot senders. Telegram lacks equivalent nuance. | Medium | Medium | Improves group behavior and reduces false triggers. |
| P6 | Poll normalization | Matrix turns polls into text triggers/history. Telegram does not currently normalize polls into the same path. | Medium | Medium | Useful for parity in collaborative group workflows. |
| P7 | Reply behavior tuning | Matrix supports `replyToMode` and thread reply behavior. Telegram is much more fixed. | Medium | Low | Good parity feature with moderate value. |
| P8 | Configurable contextual visibility rules | Matrix supports `contextVisibility`. Telegram has no equivalent context filtering because it lacks the context feature itself. | Low | Medium | Useful once Telegram gets richer context first. |

## Top 5 Product / UX Gaps

These are the biggest cross-channel differences from a user-facing product perspective.

| Rank | Gap | Stronger channel today | Why it matters |
|---|---|---|---|
| 1 | Rich context reconstruction for replies, threads, and recent room history | Matrix | Gives the model much better conversational context and continuity. |
| 2 | Real interactive UI for actions and confirmations | Telegram | Inline buttons are much clearer than reaction-based action menus. |
| 3 | Robust restart/replay correctness | Matrix | Prevents duplicate processing and bad backlog replay after restart. |
| 4 | Transport resilience on send failures and rate limits | Slight Telegram edge | Matrix now has explicit retry/backoff on send/edit/upload, but Telegram still has a more mature overall delivery surface. |
| 5 | Session granularity for threaded conversations | Matrix | Thread-scoped sessions avoid context pollution in multi-topic chats. |

### Short product take

- Telegram currently feels stronger as a classic bot UI surface.
- Matrix currently feels stronger as a stateful, context-rich, robust conversation substrate.
- If the goal is channel parity for end users, the two biggest directions are:
  - bring Matrix closer to Telegram on interaction UX and send resilience
  - bring Telegram closer to Matrix on context richness and session semantics

## Matrix-First Prioritized Backlog

Matrix is the main channel. This section reframes the gap list into a Matrix-first roadmap.
The goal is not blind parity with Telegram. The goal is a strong, coherent Matrix experience.

### P0 - Protect current Matrix strengths

These are already implemented and should be treated as non-regression requirements.

| Priority | Area | Current state | Why it must stay green |
|---|---|---|---|
| P0 | E2EE message flow | Implemented | Core main-channel requirement |
| P0 | Encrypted media download/upload | Implemented | Important for real Matrix usage |
| P0 | Persisted sync state | Implemented | Needed for correct restart behavior |
| P0 | Clean-shutdown replay trust | Implemented | Prevents bad replay semantics |
| P0 | Cold-start backlog drop | Implemented | Prevents stale backlog processing |
| P0 | Persistent inbound dedupe | Implemented | Prevents duplicate processing across restarts |
| P0 | Cross-process overlap protection | Implemented | Important with `bun --watch` overlap risk |
| P0 | Reply/thread/history context | Implemented | Major quality advantage of Matrix today |
| P0 | Thread-scoped sessions | Implemented | Important for multi-topic room use |
| P0 | Policy model and room config | Implemented | Important safety/control layer |

### P1 - Must-have next improvements for Matrix

| Priority | Feature | Current gap | Why it matters | Notes |
|---|---|---|---|---|
| P1 | First-class confirmation / approval flow | Mostly closed. Matrix now has a native approval flow for tool execution prompts and a generic adapter-level confirm primitive. | Required if Matrix is the main channel for sensitive-action approval UX | Remaining gap is mainly Matrix interaction ergonomics, not missing capability |
| P1 | Better interactive action UX | Partially closed. Matrix menus now work by reaction and by plain-text reply to the menu message, and menu prompts seed numbered reactions automatically, but still lack Telegram-grade inline UI. | Biggest user-facing UX weakness vs Telegram | This is now better than reaction-only, but still not true inline interaction |
| P1 | Outbound retry/backoff and rate-limit handling | Mostly closed. Matrix send/edit/upload paths now go through an explicit retry layer. | Important reliability gap for a main channel | Remaining differences are transport polish, not the core retry gap |
| P1 | Consecutive-message coalescing | Partially closed. Matrix now coalesces some long fragmented group-message bursts and top-level thread split turns, but not general multimessage turns. | Users often send thought fragments in several quick messages | Current behavior is intentionally narrow to avoid regressions |
| P1 | Multi-event media set aggregation | Partially closed. Buffered long-message bursts can accumulate attachments, trailing short text can now reconstruct as a media caption, and caption-vs-filename media text normalization is cleaner now, but Matrix still lacks a broad grouped-media normalization layer. | Users may send several media events as one intent | The main parity gap remains open |

### P2 - Strong follow-up improvements for Matrix

| Priority | Feature | Current gap | Why it matters | Notes |
|---|---|---|---|---|
| P2 | Better command discoverability | Partially closed. Matrix help and menu copy can guide users better, but Matrix still cannot expose native platform command registration. | Main-channel usability issue for `/help`, `/model`, `/archive` | Still mostly a help/menu UX problem |
| P2 | Better model-selection UX | Partially closed. Model selection now works via reaction or plain-text reply, but still lacks Telegram-style inline clarity. | Matrix is the main channel, so model-switch UX matters more | Functional, but still less obvious than Telegram |
| P2 | Forwarded / relayed message normalization if detectable | Matrix does not currently expose forwarded-state semantics in normalized messages | Useful context for agent behavior | Depends on what can be detected reliably in Matrix events |
| P2 | Better multimessage user-intent reconstruction | Partially closed. Matrix now extends compatible buffered text/media bursts and reconstructs some short trailing media captions, but still avoids broad turn reconstruction. | Improves quality in busy room usage | Separate from strict dedupe/replay behavior |
| P2 | Delivery-control polish where feasible | Matrix lacks some ergonomic delivery knobs compared to Telegram | Lower impact than reliability and interaction UX | Only worth doing if client behavior is predictable |

### P3 - Nice-to-have / low-value parity work

| Priority | Feature | Current gap | Why it is lower priority |
|---|---|---|---|
| P3 | Forwarded-state parity with Telegram | Matrix has no simple `isForwarded` equivalent today | Useful, but not central to Matrix quality |
| P3 | Additional message-surface polish knobs | Telegram has more send-surface convenience behavior | Nice polish, but not blocking for a strong Matrix channel |
| P3 | More discoverability sugar around commands | Still open, though basic help/menu copy is better than before | Should not delay higher-priority work |

### Not a primary Matrix goal

These differences exist, but should not drive the Matrix roadmap because they are too Telegram-specific or not meaningful in Matrix terms.

| Item | Why it should not be a primary Matrix roadmap goal |
|---|---|
| Telegram webhook mode parity | Matrix has a different transport model; webhook parity is not the right abstraction |
| Native Bot API command registration parity | Matrix clients do not offer an equivalent universal command-registration surface |
| Telegram thread-not-found fallback parity | Telegram-specific failure mode |
| Telegram first-media caption behavior parity | Matrix message/media semantics are different; this is not a core Matrix deficiency |

### Recommended execution order if Matrix is the main channel

| Order | Focus |
|---|---|
| 1 | Keep current Matrix robustness guarantees green: E2EE, replay, dedupe, sync lifecycle |
| 2 | Continue evolving Matrix approvals from tool-specific flow toward a broader native action/confirm UX |
| 3 | Keep improving Matrix action UX beyond reactions and simple text replies |
| 4 | Keep current retry/backoff coverage green and polish remaining delivery ergonomics |
| 5 | Expand consecutive-message coalescing beyond the current narrow long-burst path |
| 6 | Add broader multi-event media aggregation |
| 7 | Improve command and model-selection discoverability further |
| 8 | Add lower-value normalization and polish features |
