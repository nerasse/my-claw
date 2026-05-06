# Matrix

## Status

Implemented in `src/channels/matrix.ts` and wired in `src/index.ts`.

## Behavior

- inbound DM and room messages
- Matrix poll events normalized to text for triggers and history
- outbound text, replies, thread replies, attachments
- Markdown to Matrix HTML
- read receipts and typing
- reactions for status and `/model` selection
- streaming previews via `m.replace`
- encrypted media download when Matrix crypto is available

## Policy

- DM policy: `open | allowlist | disabled`
- group policy: `open | allowlist | disabled`
- room config via `groups[roomId]` or `groups["*"]`
- visible mentions only; hidden metadata-only mentions do not trigger
- configured bot senders only via `botUserIds`
- `allowBots`: `false | true | "mentions"`

## Context

- reply context: sender + quoted text
- thread root context
- pending-only recent room context via `historyLimit`
- `contextVisibility`: `all | allowlist | allowlist_quote`
- `allowlist_quote` keeps explicit reply quotes even when sender-based filtering blocks thread/history context

## Delivery

- `replyToMode`: `off | first | all | batched`
- text chunking via `textChunkLimit` and `chunkMode: length | newline`
- stream fallback redacts the draft before normal final send when needed

## Key Files

- `src/channels/matrix.ts`
- `src/channels/matrix-format.ts`
- `src/channels/matrix-stream.ts`
- `src/channels/matrix-history.ts`
- `src/channels/matrix-text.ts`
- `src/channels/matrix-session-handlers.ts`

## Validation

- `./node_modules/.bin/tsc --noEmit`
- `npm test`
