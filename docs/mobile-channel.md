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

### Device -> Server

```json
{ "type": "chat.send", "id": "uuid", "text": "...", "ts": "iso" }
{ "type": "approval.response", "id": "uuid", "accepted": true }
{ "type": "device.capabilities", "accessibility": true }
{ "type": "ping" }
```

### Server -> Device

```json
{ "type": "chat.message", "id": "uuid", "text": "...", "attachments": [...], "replyToId": "uuid" }
{ "type": "chat.stream.start", "id": "uuid", "replyToId": "uuid" }
{ "type": "chat.stream.delta", "id": "uuid", "text": "..." }
{ "type": "chat.stream.done", "id": "uuid" }
{ "type": "chat.stream.abort", "id": "uuid", "error": "..." }
{ "type": "approval.request", "id": "uuid", "toolName": "bash", "args": {...}, "expiresAt": 123 }
{ "type": "error", "message": "..." }
```

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
