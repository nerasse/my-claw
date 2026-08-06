# my-claw-app Channel

## Overview

Inbound-only WSS channel for the my-claw client apps. A device initiates a WebSocket
connection to a `Bun.serve` server inside the my-claw process (the VPS can never contact
the device). The Android app is the first client; a browser client is expected to speak the
same protocol, which is why the channel is named after the app and not after a form factor.

A **device** is one paired client (a phone, a browser). An **owner** is whose conversations
it opens: devices sharing an owner share the thread list, the uploaded files and the live
replies, so a phone and a browser are two windows onto the same chat. `owner` defaults to
the device id, which keeps an unconfigured device on its own. `userId` and `chatId` are the
owner, never the device id.

## File Structure

```
src/channels/my-claw-app/
├── adapter.ts          # WSS server, device auth, media serving, frame handling
├── stream.ts           # Token streaming (chat.stream.* frames)
└── types.ts            # Wire protocol types
```

## Configuration

```json
{
  "channels": {
    "my-claw-app": {
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
          "enabled": true,
          "owner": "neras"
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
- `owner` groups devices onto one conversation namespace. Omit it and the device stands
  alone under its own id. Changing it moves the device to another namespace: the threads and
  files of the previous owner stay where they are.
- The app connects to `ws://<host>:<port>/my-claw-app?device=<id>&token=<token>`.

## Wire Protocol

JSON frames, both directions. A frame that does not parse as JSON is treated as a
plain-text `chat.send` (the M1 console sends raw text).

### Conversations (threads)

Each owner can hold several independent conversations. Every chat frame carries a
`threadId` (safe charset `[A-Za-z0-9._-]`, max 64 chars). A `chat.send` without
`threadId` lands in the default thread. Sessions resolve to
`my-claw-app/thread/<owner>/<threadId>` (per-thread sessions, like Telegram forum
threads), so each conversation has its own context and runs in parallel.

Outgoing frames (replies, stream deltas, tool cards, approval requests) go to every
connected device of the owner. Sockets are resolved per frame, so a window that connects
mid-answer still receives the rest of the stream. An approval is asked on all of them and
the first answer wins.

### Device -> Server

```json
{ "type": "chat.send", "id": "uuid", "text": "...", "threadId": "projet", "ts": "iso", "attachments": [{ "id": "uuid", "type": "image|file" }, { "id": "uuid", "type": "audio", "audioAsVoice": true, "durationMs": 4200 }] }
{ "type": "session.list" }
{ "type": "commands.list" }
{ "type": "files.list", "threadId": "projet" }
{ "type": "files.delete", "threadId": "projet", "id": "uuid" }
{ "type": "session.history", "threadId": "projet", "limit": 50 }
{ "type": "session.archive", "threadId": "projet" }
{ "type": "session.delete", "threadId": "projet" }
{ "type": "session.rename", "threadId": "projet", "title": "Infra maison" }
{ "type": "approval.response", "id": "uuid", "accepted": true }
{ "type": "device.capabilities", "accessibility": true }
{ "type": "voice.mode.get" }
{ "type": "voice.mode.set", "mode": "cloud|local|auto" }
{ "type": "ping" }
```

- `session.archive` archives the thread's history (sessions-archive) and starts a
  fresh empty conversation on the same threadId.
- `session.delete` hard-deletes the session file and every archive snapshot.
- `files.list` / `files.delete` manage the conversation's attachments.
- `session.rename` names a conversation and answers with the resulting `session.list.result`.
  A blank title hands it back to the automatic one, which is the opening words of the first
  turn -- a summary of how a thread started rather than of what it became. The name is stored
  on the session and survives an archive, since the owner named the thread and not the turns
  inside it. Renaming a thread that was never opened is refused rather than creating one.

### Server -> Device

```json
{ "type": "chat.message", "id": "uuid", "text": "...", "threadId": "projet", "attachments": [...], "replyToId": "uuid" }
{ "type": "chat.stream.start", "id": "uuid", "threadId": "projet", "replyToId": "uuid" }
{ "type": "chat.stream.delta", "id": "uuid", "threadId": "projet", "text": "..." }
{ "type": "chat.stream.done", "id": "uuid", "threadId": "projet" }
{ "type": "chat.stream.abort", "id": "uuid", "threadId": "projet", "error": "..." }
{ "type": "chat.tool", "id": "uuid:tool:1", "threadId": "projet", "turnId": "uuid", "name": "bash", "args": {...}, "durationMs": 4, "ok": true, "output": "...", "truncated": false, "ts": "iso" }
{ "type": "chat.history", "threadId": "projet", "messages": [{ "id": "h-...", "role": "user|assistant", "text": "...", "ts": "iso", "transcript": "...", "attachments": [{ "id": "uuid", "type": "image", "filename": "photo.png", "mimeType": "image/png", "sizeBytes": 5120, "durationMs": 3100, "deleted": false }] }] }
{ "type": "session.list.result", "sessions": [{ "threadId": "...", "title": "...", "messageCount": 4, "createdAt": "...", "lastActiveAt": "..." }] }
{ "type": "commands.list.result", "commands": [{ "name": "status", "description": "..." }] }
{ "type": "files.list.result", "threadId": "projet", "files": [{ "id": "uuid", "filename": "note.pdf", "type": "file", "mimeType": "application/pdf", "sizeBytes": 5120, "ts": "iso" }], "totalBytes": 5120 }
{ "type": "approval.request", "id": "uuid", "threadId": "projet", "toolName": "bash", "args": {...}, "expiresAt": 123 }
{ "type": "chat.transcript", "threadId": "projet", "replyToId": "uuid", "items": [{ "id": "uuid", "text": "ce que le serveur a entendu" }] }
{ "type": "voice.mode.result", "mode": "auto", "resolved": "cloud", "cloudAvailable": true }
{ "type": "error", "message": "...", "scope": "chat|files|session|diag|logs|voice" }
```

`commands.list.result` carries the shared command catalog (same source as the
telegram bot menu), so the app's slash-menu can never drift from the server:
the device asks for it again whenever the menu opens.


Every refusal goes through one exit that logs it and tags it with the screen that asked
(`scope`), so the app shows it where the user is looking rather than in an unrelated
conversation -- and so a server-side bug can never present itself as a dead button.

### Voice notes

A recording held on the mic button is uploaded like any other attachment, then referenced
in `chat.send` with `audioAsVoice: true` and the duration measured while recording. Both are
honoured only when the stored file really is audio, so a client cannot steer the transcription
policy by mislabelling a photo.

The flag is not decoration: it selects the language policy of the existing STT pipeline
(`src/voice/stt.ts`). Dictation gets `voice.stt.language`; an audio file the owner merely picked
gets auto-detection, because forcing a language on unknown speech makes Whisper invent plausible
words instead of failing. Nothing else in the pipeline is channel-specific -- the transcript, the
echo, and the `[Audio]: "..."` rewrite are the same code that serves Telegram and Matrix.

The transcript comes back as `chat.transcript`, addressed to the `chat.send` id the device
generated, with one entry per recording keyed by attachment id, so each note renders its own
words. A message can carry several: the mic stays available while there is no text, and the
`[Audio 1]`, `[Audio 2]` labels in the stored turn keep them apart in the prompt too. Telegram and Matrix get the
same text as an echo message (`voice.stt.echoFormat`); here that echo is dropped, because a
standalone turn quoting the bubble above it says the same thing twice and pushes the conversation
apart. A take that failed has no transcript, so its warning still arrives as a message.

`voice.mode.get` / `voice.mode.set` expose the engine choice: `cloud` (Groq whisper-large-v3),
`local` (faster-whisper, nothing leaves the machine), or `auto`. A set is persisted to
`config.json` rather than applied in memory only, because a switch flipped in the app means "from
now on" and must survive a restart; `voice` is hot-reloaded, so the next recording uses it.
`cloudAvailable` is false when no `GROQ_API_KEY` is set, so the app can say why cloud is not an
option instead of offering a choice that fails.

### Attachments

The device uploads files over HTTP first, then references them in `chat.send`:

```
POST /media?device=<id>&token=<token>
  headers: x-filename, x-type (image|audio|video|file), x-thread-id
  body: raw bytes
-> { "id": "uuid", "type": "image", "filename": "...", "mimeType": "...", "sizeBytes": 123 }
```

Files are stored per conversation as `<id>__<filename>` under
`$MY_CLAW_DIR/files/my-claw-app/<owner>/<threadId>/`, and removed with the session
(archive/delete). The uploader's name is part of the entry so a listing stays a single
readdir with nothing to keep in sync; entries written before that convention
(`<id>.<ext>`) still list, under their id as name. `GET /media/<id>` serves them back
for display/download. Uploads are capped (`channels["my-claw-app"].files.maxSizeBytes`,
default 10 MB, plus a global `maxTotalBytes` of 2 GB). The agent receives the
attachment as a path it can read with its tools, and images are routed to a
vision-capable model when the active model cannot take them. The files outlive
the run that used them: they are only removed by `files.delete` or with the
session, and later turns re-read them to keep an image in the conversation.


#### Attachments in a replayed conversation

A stored turn keeps the LLM-facing rendering of its attachments, an `[Attachments]`
block of server paths appended to the user text. `session.history` strips that block
and returns the attachments as structured metadata instead, resolved against the
thread's own file listing, so a reopened conversation shows the same bubbles as the
live one: a thumbnail or a named chip that opens the viewer, never a path. An
attachment deleted since carries `deleted: true` -- it is still named, but there is
nothing left to open.

A replayed voice note is rebuilt to match the live bubble rather than the storage format. The
turn is stored as `[Audio]: "..."` because that is what the model must read; history hands the
words back as `transcript` and the duration back on the attachment, so the reopened thread shows
the same player and the same sentence under it instead of printing the marker as body text.

Audio is listed in that block, but with only its path and duration. Its words are already in the
text above, so mime, size and file name are three facts the model will not use and pays for on
every replay of the conversation -- about 14 tokens per recording per turn. Duration stays,
because it is the one thing that cannot be recovered without decoding the file. It was excluded once, on the grounds that
its words were already in the text: the cost was that a replayed voice note came back as bare
text with no bubble to play, and the agent never saw the file it had just been read from -- so
"keep that recording" had no path to work with.

### Diagnostics

```
-> { "type": "diag.snapshot", "threadId": "..." }
<- { "type": "diag.snapshot.result", "text": "..." }

-> { "type": "logs.tail", "scope": "my-claw-app", "level": "warn", "run": "a1b2c3d4",
     "contains": "upload", "limit": 200 }
<- { "type": "logs.tail.result", "text": "...", "lines": 42, "query": { ... } }
```

Both are read-only and redacted server-side (config secrets by value, plus the usual key
shapes). `limit` is clamped to 1000 lines. `run` is the correlation id stamped on every log
line of a single inbound message; it is echoed on `chat.message` and `chat.stream.start` so a
reply can be traced back to its run. Verbosity is `logging.level` in config (hot-reloaded), or
`MY_CLAW_LOG_LEVEL` which overrides it.

`chat.history` is also the ack for `session.archive`/`session.delete` (empty
messages list). `session.list.result` only lists active (non-archived) threads,
most recently active first, capped at 50.

### Tool calls

Unlike the text channels, which glue a formatted note inside the reply, this
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

- No public exposure: the WSS/HTTP server is only reachable where the device can
  reach the VPS (private network); the VPS never dials out to the device.
- Every connection and every media fetch is authenticated by device id + token.
- Tokens are per-device and revocable (remove the entry from `devices`, or set
  `enabled: false`), so one window can be cut off without touching the others.
- Approved tools are `allow-session`; unanswered requests time out to `deny`
  (2 minutes).
- Stale sockets (no inbound frame for 90s) are closed by a sweep every 30s.

## Limitations / Roadmap

- Auth is a static per-device token passed as a query parameter, with no expiry. It is
  adequate for a phone on a private network holding the token in the Android Keystore; it is
  the first thing to harden before a browser client, where the URL is far more exposed.
- M3: device tools (accessibility snapshot, notifications, media capture) gated by
  `device.capabilities` and per-action approval in the app.
