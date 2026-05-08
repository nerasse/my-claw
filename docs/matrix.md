# Matrix

## Status

Implemented as a split adapter:

- `src/channels/matrix.ts`: public Matrix adapter facade
- `src/channels/matrix-client.ts`: Matrix SDK runtime and storage wiring
- `src/channels/matrix/`: shared Matrix adapter/runtime modules
- wired in `src/index.ts`

## Toggle

- `channels.matrix.enabled: false` disables Matrix startup

## Behavior

- inbound DM and room messages
- Matrix poll events normalized to text for triggers and history
- reaction and plain-text reply actions for menus and approvals
- generic confirm prompts via reactions or plain-text reply
- `/commands` and `/models` discoverability commands
- outbound text, replies, thread replies, attachments
- Markdown to Matrix HTML
- read receipts and typing
- reactions for status and `/model` selection
- streaming previews via `m.replace`
- retry/backoff for send, edit, upload, stream preview/final, and redact paths
- coalescing for quick fragmented group text bursts, top-level thread split turns, and compatible attachment bursts with short trailing captions reconstructed ahead of media markers
- media text normalization strips filename-only bodies and keeps real captions with typed markers
- encrypted media download when Matrix crypto is available
- rust-crypto startup when `channels.matrix.encryption` is enabled
- decrypted `m.room.encrypted` handling after Matrix SDK decryption completes
- live encrypted events are skipped with a warning when crypto is unavailable
- repeated decrypt failures now log room-scoped escalation and same-user hints
- encrypted media upload in encrypted rooms
- local Matrix sync cache and crypto snapshot persisted under `~/.my-claw/matrix/accounts/...`

## Encryption

- enable with `channels.matrix.encryption: true`
- requires the real Matrix `userId` and `deviceId` that match the access token
- on first encrypted startup, `my-claw` will seed its own crypto snapshot from the matching OpenClaw snapshot when available, then continue with its own local store
- `my-claw` keeps its own crypto DB prefix and snapshot file; it does not share a live IndexedDB store with OpenClaw

## Policy

- DM policy: `open | allowlist | disabled`
- group policy: `open | allowlist | disabled`
- room config via `groups[roomId]` or `groups["*"]`
- visible mentions only; hidden metadata-only mentions do not trigger
- configured bot senders only via `botUserIds`
- `allowBots`: `false | true | "mentions"`

## Context

- reply context: sender + quoted text
- Matrix reply fallback quotes are stripped from normalized reply text
- thread root context
- pending-only recent room context via `historyLimit`
- `contextVisibility`: `all | allowlist | allowlist_quote`
- `allowlist_quote` keeps explicit reply quotes even when sender-based filtering blocks thread/history context

## Delivery

- `replyToMode`: `off | first | all | batched`
- text chunking via `textChunkLimit` and `chunkMode: length | newline`
- plain media HTTP fetches use a timeout guard
- stream fallback redacts the draft before normal final send when needed
- pending action menus persist across restart
- generic confirm prompts restore after restart as expired prompts
- pending tool approvals persist across restart and restore as expired prompts
- cold start drops pre-startup backlog unless a clean shutdown persisted sync state
- inbound dedupe persists committed events and live claims under the Matrix account storage root

## Key Files

- `src/channels/matrix.ts`
- `src/channels/matrix-client.ts`
- `src/channels/matrix/file-sync-store.ts`
- `src/channels/matrix/sync-lifecycle.ts`
- `src/channels/matrix/decrypt-bridge.ts`
- `src/channels/matrix/inbound-dedupe.ts`
- `src/channels/matrix/adapter-ingress.ts`
- `src/channels/matrix/adapter-policy.ts`
- `src/channels/matrix/adapter-actions.ts`
- `src/channels/matrix-format.ts`
- `src/channels/matrix-stream.ts`
- `src/channels/matrix-history.ts`
- `src/channels/matrix-text.ts`
- `src/channels/matrix-session-handlers.ts`

## Validation

- `bun run check`
- `bun run check:test`
- `node --experimental-transform-types --test tests/*.test.ts`

## Logs

- app: `~/.my-claw/logs/matrix-YYYY-MM-DD(.N).log`
- sdk: `~/.my-claw/logs/matrix-sdk-YYYY-MM-DD(.N).log`
