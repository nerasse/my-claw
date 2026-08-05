# Mobile Channel

## Overview

Inbound-only WSS channel for the companion Android app (`my-claw-app`). The device
initiates a WebSocket connection to a `Bun.serve` server inside the my-claw process
(the VPS can never contact the phone). Each paired device gets its own session;
the device id doubles as `userId` and `chatId`.

## File Structure

```
src/channels/mobile/
├── adapter.ts          # WSS server, device auth, media serving, frame handling
├── stream.ts           # Token streaming (chat.stream.* frames)
└── types.ts            # Wire protocol types
```

## Configuration

```json
{
  "channels": {
    "mobile": {
      "enabled": true,
      "port": 8080,
      "approvals": false,
      "streaming": {
        "enabled": true,
        "minChars": 30
      },
      "devices": {
        "<deviceId>": {
          "token": "<device secret>",
          "name": "Pixel 8",
          "enabled": true
        }
      }
    }
  }
}
```

- `port` is reboot-only (the socket binds at start). Devices, tokens, streaming and
  approvals hot-reload in place.
- Pairing is manual for now: the app generates a `deviceId` + `token` (token held in
  the Android Keystore), and the owner copies them into `devices`. A QR/token flow
  is planned with the chat UI.
- `approvals: true` turns on tool-approval round trips (`approval.request` /
  `approval.response`). Off by default: approval-required tools are denied.
- The app connects to `ws://<host>:<port>/mobile?device=<id>&token=<token>`.

## Wire Protocol

JSON frames, both directions. A frame that does not parse as JSON is treated as a
plain-text `chat.send` (the M1 console sends raw text).

### Conversations (threads)

Each device can hold several independent conversations. Every chat frame carries a
`threadId` (safe charset `[A-Za-z0-9._-]`, max 64 chars). A `chat.send` without
`threadId` lands in the default thread. Sessions resolve to
`mobile/thread/<deviceId>/<threadId>` (per-thread sessions, like Telegram forum
threads), so each conversation has its own context and runs in parallel.

### Device -> Server

```json
{ "type": "chat.send", "id": "uuid", "text": "...", "threadId": "projet", "ts": "iso" }
{ "type": "session.list" }
{ "type": "session.history", "threadId": "projet", "limit": 50 }
{ "type": "session.archive", "threadId": "projet" }
{ "type": "session.delete", "threadId": "projet" }
{ "type": "approval.response", "id": "uuid", "accepted": true }
{ "type": "device.capabilities", "accessibility": true }
{ "type": "ping" }
```

- `session.archive` archives the thread's history (sessions-archive) and starts a
  fresh empty conversation on the same threadId.
- `session.delete` hard-deletes the session file and every archive snapshot.

### Server -> Device

```json
{ "type": "chat.message", "id": "uuid", "text": "...", "threadId": "projet", "attachments": [...], "replyToId": "uuid" }
{ "type": "chat.stream.start", "id": "uuid", "threadId": "projet", "replyToId": "uuid" }
{ "type": "chat.stream.delta", "id": "uuid", "threadId": "projet", "text": "..." }
{ "type": "chat.stream.done", "id": "uuid", "threadId": "projet" }
{ "type": "chat.stream.abort", "id": "uuid", "threadId": "projet", "error": "..." }
{ "type": "chat.tool", "id": "uuid:tool:1", "threadId": "projet", "turnId": "uuid", "name": "bash", "args": {...}, "durationMs": 4, "ok": true, "output": "...", "truncated": false, "ts": "iso" }
{ "type": "chat.history", "threadId": "projet", "messages": [{ "id": "h-...", "role": "user|assistant", "text": "...", "ts": "iso" }] }
{ "type": "session.list.result", "sessions": [{ "threadId": "...", "title": "...", "messageCount": 4, "createdAt": "...", "lastActiveAt": "..." }] }
{ "type": "approval.request", "id": "uuid", "threadId": "projet", "toolName": "bash", "args": {...}, "expiresAt": 123 }
{ "type": "error", "message": "..." }
```

`chat.history` is also the ack for `session.archive`/`session.delete` (empty
messages list). `session.list.result` only lists active (non-archived) threads,
most recently active first, capped at 50.

### Tool calls

Unlike the text channels, which glue a formatted note inside the reply, the mobile
channel emits one `chat.tool` frame per executed tool so the client can render a
collapsed card and expand it on tap. `turnId` is the stream id the run started
with, which groups the cards of a turn.

A tool card seals the text bubble it interrupts: the streamer sends
`chat.stream.done` for the current id, then the cards, then a fresh
`chat.stream.start` with id `<turnId>#<n>` for the text that follows. Bubbles
therefore stay in chronological order without the client reordering anything.

`output` is the result handed to the model, capped at 4000 characters
(`truncated: true` past that). Nested `AGENTS.md` injections are excluded.
`/verbose off` suppresses the frames entirely.

History replays the same cards from the session file: entries with
`role: "tool"` carry `name`, `args`, `durationMs`, `ok`, `output`, `truncated`.
`durationMs` is absent for turns recorded before timings were persisted.

### Attachments

`chat.message` carries attachment metadata only:

```json
{ "id": "media-id", "type": "image", "mimeType": "image/png", "filename": "a.png", "sizeBytes": 42 }
```

The file is fetched over HTTP (same auth query params as the WS handshake):

```
GET /media/<id>?device=<deviceId>&token=<token>
```

The app builds the URL from its own credentials; the media registry is capped at
1000 entries and dropped on adapter stop.

## Security

- No public exposure: the WSS/HTTP server is only reachable where the phone can
  reach the VPS (private network); the VPS never dials out to the device.
- Every connection and every media fetch is authenticated by device id + token.
- Tokens are per-device and revocable (remove the entry from `devices`, or set
  `enabled: false`).
- Approved tools are `allow-session`; unanswered requests time out to `deny`
  (2 minutes).
- Stale sockets (no inbound frame for 90s) are closed by a sweep every 30s.

## Limitations / Roadmap

- M1: text chat + streaming + pairing; no commands yet, no attachments upload
  from the device.
- M3: device tools (accessibility snapshot, notifications, media capture) gated by
  `device.capabilities` and per-action approval in the app.
