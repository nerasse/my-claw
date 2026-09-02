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
├── sessions.ts         # Thread list/history/archive, keyed by owner
├── files.ts            # Per-thread uploads
├── devices.ts          # Device mint/list/revoke -- docs/web-pairing.md
├── pairing.ts          # Pairing sessions, codes, TTL -- docs/web-pairing.md
├── web.ts              # Static bundle serving (see "Serving the web client")
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
  `approval.response`). Off by default: approval-required tools are denied. This is the only
  surface that can answer a prompt, so with it off a blacklisted tool never runs.
- `owner` groups devices onto one conversation namespace. Omit it and the device stands
  alone under its own id. Changing it moves the device to another namespace: the threads and
  files of the previous owner stay where they are.
- The app connects to `ws://<host>:<port>/my-claw-app?device=<id>&token=<token>`.

## Serving the web client

The web client (react-native-web, same repo as the Android app) is served by **this adapter**,
from the same `Bun.serve` and the same port. Not by nginx, not by a second service.

The reason is not performance, it is coupling. The channel already serves `/media`, `/skills` and
`/health` off that server; a static bundle is one more route on a server that exists. Handing the
bundle to nginx instead would make the web client a deployment-specific feature: my-claw ships as
a tarball with an `install.sh` and does not require a reverse proxy today. `web.enabled: true` and
the client is reachable, over the VPN, with no proxy at all. Same origin comes for free, so no
CORS, no host to configure in the client, and the media URLs stay relative.

A third service was considered and rejected: it would need its own unit, its own update path and
its own port, to serve 3 MB of static files that must stay in step with a socket living in
another process.

### The bundle is private

The bundle is served only to a paired client, like everything else on this port. It carries no
secret, but an unauthenticated copy of the UI is a free map of the surface: every route, every
frame name, every dependency version, offered to whoever scans the host.

A browser cannot present the credential the way the app does. `?device=&token=` works for a URL
the client builds by hand; it does not work for the asset graph of an HTML page, for the service
worker, or for an `<img src>`. The browser credential is therefore a **cookie**, and the app keeps
its query parameters. One resolver, `authenticate(req)`, accepts either and returns a device or
null.

```
Set-Cookie: claw_session=<32 CSPRNG bytes, base64url>
            HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000 [; Secure if the request was TLS]
```

The cookie is an **opaque session id**, not the device token. The browser therefore never holds
the token at all: a script that finds an XSS cannot read `HttpOnly`, cannot exfiltrate a
credential, and the session dies the moment the device is revoked. This is strictly better than
the `localStorage` the first draft of the web spec assumed.

`Secure` is set only when the request arrived over TLS (`X-Forwarded-Proto`, or the scheme).
Hardcoding it would make the client unusable over plain HTTP on the VPN, where there is no proxy
to terminate anything.

### Deployment: private network, no SSO, but TLS anyway

The instance is reached over the tailnet and the LAN, never from the public internet, and no
identity provider sits in front. Pairing plus the device cookie is the whole authentication story.
That is a deliberate decision, recorded in `docs/web-pairing.md`.

It does **not** mean plain HTTP is enough. A browser gates a long list of APIs behind a *secure
context*, and `http://<host>:8080` is not one (only `localhost` is exempt):

| API | Used by | Without HTTPS |
| --- | --- | --- |
| `getUserMedia` / `MediaRecorder` | voice notes | dead, no fallback |
| Service Worker | PWA shell, install, push | dead |
| Push API + Notifications | run-finished notifications | dead |
| Geolocation | location sharing | dead |
| `navigator.clipboard` | copy buttons | degraded, falls back to `execCommand` |

**Decided: TLS is terminated by an external nginx on another VM.** my-claw keeps listening in
plain HTTP on `:8080`, and never learns about certificates. The Android app keeps hitting the port
directly over the LAN; browsers go through the proxy.

That choice moves four facts out of the process, and the code has to read them from headers
instead of from the socket. All four are only trusted when the request comes from a configured
proxy address (`web.trustedProxies`, a list of CIDRs, empty by default), otherwise a client on the
LAN forges them at will.

| Header | Read for | Broken if missing |
| --- | --- | --- |
| `X-Forwarded-Proto` | the `Secure` cookie attribute | the cookie ships without `Secure` |
| `X-Forwarded-Host` | the `Origin` check on upgrade | every browser socket is refused with 403 |
| `X-Forwarded-For` | client IP in logs and rate limits | every pairing attempt shares one bucket |
| `Upgrade` / `Connection` | the WebSocket handshake | no chat at all |

The `Origin` check compares against `X-Forwarded-Host` when the request is proxied, `Host`
otherwise. Comparing against a configured hostname would break the direct LAN and tailnet access
the app relies on.

Two nginx defaults will bite, and neither produces a useful error: `client_max_body_size` is 1 MB,
which rejects any real attachment (the channel sets no limit of its own), and `proxy_read_timeout`
is 60 s, which kills an idle chat socket.

Plain HTTP stays supported and is the right answer for a quick check from `localhost`. It is a
degraded mode, not the target, and the client hides what it cannot do rather than failing silently
on a mic button.

Two alternatives were considered and rejected for now: `web.tls` in the config with `Bun.serve`
terminating TLS itself (needs cert files and a restart on renewal), and Tailscale serve on the
host (this VM is reached through a subnet route, it is not on the tailnet directly).

Sessions live in `$MY_CLAW_DIR/web-sessions.json`, mode 0600, atomic writes: they must survive a
restart, unlike pairing tickets. Fields: id, deviceId, createdAt, lastSeenAt, userAgent. Sliding
expiry, 30 days. `myclaw device rm` drops every session of that device and closes its sockets.

**Cross-site WebSocket hijacking.** A WebSocket handshake ignores the same-origin policy, so a
cookie-authenticated socket is reachable from any page unless something says otherwise. Two
guards, both cheap: `SameSite=Strict` keeps the cookie off cross-site requests, and a cookie-
authenticated upgrade requires `Origin` to match the request's own `Host`, refusing anything else
with 403. Matching against `Host` rather than a configured hostname is what keeps the instance
reachable by tailnet name, LAN name and raw IP without a list to maintain. The app sends no
`Origin` and authenticates by query parameters, so it is unaffected.

### Routes

| Path | Auth | Behaviour |
| --- | --- | --- |
| `/media`, `/media/*`, `/skills`, `/health`, `/my-claw-app` | token or cookie | unchanged |
| `/pair`, `/pair/*` | none | the pairing shell, the only public surface |
| `/my-claw-app/pair` | none | pairing socket, `docs/web-pairing.md` |
| `/my-claw-app/session` | one-time grant | `POST`, exchanges a grant for the cookie |
| `/my-claw-app/ticket` | token of the device itself | `POST`, a claim code for `myclaw device add` |
| `/assets/*` | cookie | bundle file, `Cache-Control: private, max-age=31536000, immutable` |
| anything else | cookie | the file if it exists, otherwise `index.html`, `Cache-Control: private, no-cache` |

Without a valid cookie, a navigation request is redirected to `/pair?next=<path>` and anything
else gets a bare 401. No 404 versus 403 distinction on bundle paths: an unauthenticated client
learns nothing about what is installed.

`next` is what makes a deep link usable from a browser that is not paired yet: the client routes
on `/t/<threadId>`, so a link to a conversation has to survive the pairing it triggers instead of
dumping the new browser on the root. It carries a path of ours or nothing, validated on the way
out (`pairRedirect`) and again in the page before it is used, because a redirect target is
exactly the sort of parameter that turns into an open redirect.

The API routes are matched **before** the static fallback, so a bundle can never shadow one. The
resolved path is checked to be inside the bundle directory: a `..` in a URL is a 404, never a read
of `~/.my-claw/config.json`.

`index.html` must never be cached: it is the only file whose name is stable, so a cached copy pins
the client to a dead asset graph and no update ever lands. `private` on every static response, or
a shared cache somewhere serves the UI to the next person through it.

Other headers: `Content-Security-Policy: default-src 'self'; connect-src 'self' ws: wss:; img-src
'self' data: blob:; media-src 'self' blob:`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, `X-Frame-Options: DENY`.

### The pairing shell

Gating the bundle creates a bootstrap problem: the pairing screen cannot live inside the thing it
unlocks. So it does not. `/pair` serves a self-contained page shipped **with the server**
(`src/channels/my-claw-app/pair-page.ts`, inline HTML, CSS and vanilla JS, no framework, no
bundle, a few KB).

It does exactly three things: open `/my-claw-app/pair`, render the QR and the code the server
sends back, and on `pair.granted` POST the grant to `/my-claw-app/session` before redirecting to
`/`. It reads no session, lists no thread, names no model. What an attacker gets from it is the
knowledge that a my-claw instance is here, which the TLS certificate already told them.

Its script and its style are inline, which the shared `default-src 'self'` policy refuses, so the
page carries a per-response nonce and a CSP of its own (`script-src 'nonce-...'`). `unsafe-inline`
would have allowed any injected script too, which is the opposite of the point.

The QR is drawn server-side and arrives in a second `pair.challenge` frame, so the code is on
screen immediately rather than after the encoder. It encodes the claim URL, never the credential:
a photograph of the screen is worth nothing without a paired device to approve it. Encoding it in
the page would mean shipping an encoder into the one file that has to stay small and
dependency-free.

A browser that hits `/pair` while already holding a valid cookie is redirected to `/`. The shell
is versioned with the server, not with the bundle, so a bundle rollback never leaves the door
without a handle.

### Installing the bundle

The app and the server release independently, so the server pulls the artifact rather than
embedding it:

```
myclaw web install <version> [--from <url|path>]
myclaw web ls
myclaw web use <version>
myclaw web rm <version>
```

`install` downloads `dist-web.tar.gz` from the my-claw-app release (or takes a local path with
`--from`), prints its sha256, extracts into a staging directory and only then renames it to
`$MY_CLAW_DIR/web/<version>/`: a half-extracted tree is never reachable, because the serving path
only ever sees the finished one. `current` is a symlink, so switching versions and rolling back
are the same operation. Files are read per request: a new bundle is live without a restart.

Two things that shape the download, both learned the hard way on the first real install:

- **The release repository is private**, and a private asset answers an anonymous GET with `404`,
  not `401`. `FORGEJO_TOKEN` from `~/.my-claw/.env` is sent as an `Authorization: token` header,
  and only ever to the host in `FORGEJO_URL`: a `--from` pointing anywhere else is a plain
  download, because a credential handed to whatever host was typed on the command line is how a
  mirror ends up holding the keys to the repository.
- **The staging directory lives in `$MY_CLAW_DIR/web/`**, not in `/tmp`. A rename cannot cross a
  filesystem and `/tmp` is a tmpfs, so staging there failed with `EXDEV` after the download and
  the extraction had both succeeded. The name starts with a dot, so a leftover from a crash is
  never listed as a version.

A real directory at `current` is refused rather than replaced. It is somebody's hand-installed
bundle, and deleting files nobody asked to lose is not an upgrade.

Same CLI dispatch as `myclaw device`, same forwarding in `scripts/myclaw.sh`.

### Configuration

```json
{
  "channels": {
    "my-claw-app": {
      "web": {
        "enabled": false,
        "dir": "$MY_CLAW_DIR/web/current"
      }
    }
  }
}
```

Hot-reloads. Disabled, the static routes do not exist and the port behaves exactly as it does
today. Enabled with a missing directory: the channel logs a `warn` at boot and keeps serving the
API, it does not refuse to start over a missing UI.

### What nginx still does

TLS, the public hostname, and SSO if the owner wants it in front. It proxies everything to `:8080`
as one block, including the `Upgrade` headers and a read timeout above the socket idle time (the
default 60 s kills an idle chat socket). It does not serve a single file.

One consequence to accept: while my-claw restarts, a **cold** page load fails. A warm one does not,
the service worker serves the shell and the client shows its reconnecting state. Buying protection
for the cold case means duplicating the bundle into nginx, and that is not worth a second source of
truth for the few seconds of an auto-update.

## Wire Protocol

JSON frames, both directions. A frame that does not parse as JSON is treated as a
plain-text `chat.send` (the M1 console sends raw text).

### Conversations (threads)

Each owner can hold several independent conversations. Every chat frame carries a
`threadId` (safe charset `[A-Za-z0-9._-]`, max 64 chars). A `chat.send` without
`threadId` lands in the default thread. Sessions resolve to
`my-claw-app/thread/<owner>/<threadId>` (per-thread sessions, like forum
threads), so each conversation has its own context and runs in parallel.

Two thread ids do not name a conversation but a session of another kind, and are recognised
before that rule: a cron run (`cron-<jobId>-<runTs>`) and a sub-agent (`sub-<16 hex>`, a digest
because a sub-agent's name is model-written and may hold characters the charset forbids). One that
resolves to nothing falls through to a conversation id and reads as an empty session, so a stale
handle can never land on somebody else's thread. See `docs/subagent-navigation.md`.

Outgoing frames (replies, stream deltas, tool cards, approval requests) go to every
connected device of the owner. Sockets are resolved per frame, so a window that connects
mid-answer still receives the rest of the stream. An approval is asked on all of them and
the first answer wins.

### Device -> Server

```json
{ "type": "chat.send", "id": "uuid", "text": "...", "threadId": "projet", "ts": "iso", "attachments": [{ "id": "uuid", "type": "image|file" }, { "id": "uuid", "type": "audio", "audioAsVoice": true, "durationMs": 4200 }] }
{ "type": "chat.send", "id": "uuid", "text": "...", "threadId": "projet", "location": { "latitude": 48.8566, "longitude": 2.3522, "accuracyMeters": 24, "capturedAt": "iso" } }
{ "type": "chat.stop", "threadId": "projet" }
{ "type": "session.list" }
{ "type": "commands.list" }
{ "type": "files.list", "threadId": "projet" }
{ "type": "files.delete", "threadId": "projet", "id": "uuid" }
{ "type": "session.history", "threadId": "projet", "limit": 50, "before": 50 }
{ "type": "session.archive", "threadId": "projet" }
{ "type": "session.unarchive", "threadId": "projet" }
{ "type": "session.delete", "threadId": "projet" }
{ "type": "session.pin", "threadId": "projet", "pinned": true }
{ "type": "session.pin.order", "threadIds": ["projet", "courses"] }
{ "type": "draft.set", "threadId": "projet", "text": "ce qui est tape et pas envoye" }
{ "type": "session.rename", "threadId": "projet", "title": "Infra maison" }
{ "type": "session.workspace.set", "threadId": "projet", "workspace": "default|sofa" }
{ "type": "approval.response", "id": "uuid", "decision": "allow-once|allow-session|deny" }
{ "type": "approval.history", "threadId": "projet", "limit": 50, "before": "iso" }
{ "type": "device.capabilities", "accessibility": true }
{ "type": "voice.mode.get" }
{ "type": "voice.mode.set", "mode": "cloud|local|auto" }
{ "type": "update.run" }
{ "type": "model.list" }
{ "type": "model.refresh" }
{ "type": "model.endpoints", "model": "openrouter/openai/gpt-5.1" }
{ "type": "model.get", "threadId": "projet" }
{ "type": "model.set", "threadId": "projet", "model": "gpt-5.1" }
{ "type": "model.effort.set", "threadId": "projet", "level": "medium" }
{ "type": "model.context.set", "threadId": "projet", "choice": 128000 }
{ "type": "skills.list" }
{ "type": "skills.copy", "source": "built-in|custom|workspace", "name": "forgejo", "workspace": "sofa", "target": { "source": "custom|workspace", "workspace": "lab" }, "overwrite": true }
{ "type": "skills.move", "source": "custom|workspace", "name": "forgejo", "workspace": "sofa", "target": { "source": "custom|workspace", "workspace": "lab" }, "overwrite": true }
{ "type": "tools.list" }
{ "type": "workspaces.list" }
{ "type": "mcp.list" }
{ "type": "instructions.list" }
{ "type": "instructions.get", "workspace": "default|sofa", "file": "AGENTS.md", "nested": "svc/AGENTS.md", "threadId": "t9" }
{ "type": "instructions.set", "workspace": "sofa", "file": "AGENTS.md", "content": "...", "sha": "9f2b1c4d5e6a", "nested": "/home/me/dev/repo/AGENTS.md", "threadId": "t9" }
{ "type": "session.instructions.get", "threadId": "t9" }
{ "type": "instructions.layer.set", "workspace": "sofa", "file": "SOUL.md", "inherit": "lab|default|builtin|none", "off": true }
{ "type": "agents.config.get" }
 { "type": "agents.model.set", "agent": "global|orchestrator|general|research|cron", "model": "gpt-5.1", "effort": "medium" }
 { "type": "agents.model.clear", "agent": "orchestrator|general|research|cron" }
 { "type": "agents.fallback.set", "model": "gpt-5.1|claude-sonnet-5" }
 { "type": "agents.scope.set", "agent": "cron", "field": "skills|mcp", "mode": "inherit|all|list", "names": ["code-review"] }
{ "type": "agents.workspace.set", "agent": "cron", "workspace": "sofa" }
{ "type": "agents.iterations.set", "agent": "cron", "value": 12 }
{ "type": "agents.contextcap.set", "agent": "cron", "value": 200000 }
{ "type": "agents.file.get", "agent": "reviewer" }
{ "type": "agents.file.set", "agent": "reviewer", "sha": "9f2b1c4d5e6a", "description": "...", "base": "general|research", "tools": ["read"], "skillsMode": "absent|all|list", "skills": [...], "mcpMode": "absent|all|list", "mcp": [...], "model": "opus", "workspace": "sofa", "maxIterations": 10, "contextCap": 0, "instructions": ["CORE"], "prompt": "..." }
{ "type": "agents.file.create", "name": "reviewer", "description": "Reviews a diff" }
{ "type": "agents.file.delete", "agent": "reviewer" }
{ "type": "tools.toggle", "name": "cron", "disabled": true }
{ "type": "mcp.add", "name": "gitlab", "transport": "stdio|sse|http", "command": "mcp-gitlab", "args": ["--token-file", "/run/secrets/t"] }
{ "type": "mcp.remove", "name": "gitlab" }
{ "type": "mcp.enable", "name": "gitlab", "enabled": false }
{ "type": "config.get" }
{ "type": "config.set", "sha": "9f2b1c4d5e6a", "content": "{ ... }" }
{ "type": "workspaces.add", "key": "sofa", "path": "/srv/sofa" }
{ "type": "workspaces.remove", "key": "sofa" }
{ "type": "workspaces.rename", "from": "sofa", "to": "couch" }
{ "type": "workspaces.path.set", "key": "sofa", "path": "/srv/newsofa" }
{ "type": "tags.list" }
{ "type": "tags.upsert", "name": "opus", "model": "claude-opus-4-8", "effort": "xhigh", "contextCap": 50000 }
{ "type": "tags.delete", "name": "opus" }
{"type": "question.reply", "id": "que_...", "answers": [["fr"], ["1", "2"]] }
{ "type": "ping" }
```

On every WebSocket connection the server sends the capability gate before other optional greetings:

```json
{ "type": "location.capabilities", "enabled": true, "address": true, "provider": "geoapify" }
```

The client hides the location action until this frame says `enabled: true`. A `chat.send.location`
value contains only device facts. The server ignores any client-supplied address, reverse geocodes
with its server-only `GEOAPIFY_API_KEY`, and broadcasts the enriched user value as:

```json
{ "type": "chat.location", "threadId": "projet", "replyToId": "uuid", "location": { "latitude": 48.8566, "longitude": 2.3522, "accuracyMeters": 24, "capturedAt": "iso", "address": { "formatted": "...", "level": "street", "provider": "geoapify" } } }
```

The composer previews the address without sending anything: `location.preview` asks the server to
geocode a staged fix (nothing is persisted, the same resolver and cache as chat.send serve it) and
`location.preview.result` answers with the enriched value. The owner may edit the display address:
`chat.send.location.addressOverride.formatted` carries the decision — an empty string sends
coordinates only, other text is shown as-is and flagged `edited: true` in the address. The override
is display text only; coordinates and accuracy stay exactly as captured.

Location data is persisted with the user turn and replayed in `chat.history`; it is not a media file.
Provider failure never prevents raw coordinates from being delivered. Do not log coordinates or
provider request URLs.

- `session.archive` / `session.unarchive` move a conversation between the drawer and the
  archived list by setting or clearing `archivedAt` on the session. Nothing is moved,
  snapshotted or deleted: messages, uploads, name and model override all stay put, and
  unarchiving hands the conversation back exactly as it was. Both answer with the refreshed
  `session.list.result`. Archiving a thread that was never opened is refused rather than
  creating one.
- `session.pin` pins a conversation at the **end** of the owner's pinned list, or unpins it;
  `session.pin.order` rewrites that list in the order the owner dragged it to. The rank lives on
  the session as `pinRank` (dense, from 0) and is reported as `pinRank` on every summary, so one
  field carries both facts: pinned, and where. Both answer with `session.list.result`, and that
  listing is **broadcast to every socket of the owner**, not just to the device that asked: a pin
  is about finding a conversation again, and the owner reaches the same conversations from the
  phone and from the browser. Pins used to be a per-device preference, which meant each client
  had its own private idea of what was pinned and in what order.
  A reorder only moves the ids it names: a conversation pinned from another device while the
  list was on screen keeps its pin and lands after the dragged ones. An archived conversation
  keeps its rank, so unarchiving brings it back where it was. Pinning a thread that was never
  opened is refused rather than creating one.
- `session.delete` hard-deletes the session file and every archive snapshot. There is no way
  to merely empty a conversation: archiving files it away reversibly and deleting destroys it,
  which leaves nothing for a third verb to do.
- `chat.stop` stops the run of the thread, whatever backend drives it (the wire version of
  `/stop`). Answered with a `chat.command.result`.
- `files.list` / `files.delete` manage the conversation's attachments.
- `session.rename` names a conversation and answers with the resulting `session.list.result`.
  A blank title hands it back to the automatic one, which is the opening words of the first
  turn -- a summary of how a thread started rather than of what it became. The name is stored
  on the session and survives an archive, since the owner named the thread and not the turns
  inside it. Renaming a thread that was never opened is refused rather than creating one.
- `session.workspace.set` sets the conversation's workspace (`default` or a `config.workspaces`
  key). Unlike rename, the session is created on the spot if it does not exist yet: the app's
  new-conversation picker chooses a workspace before the first message exists. On an existing
  conversation the switch applies from the next run onward. Answers with
  `session.workspace.set.result`, and the workspace key also rides on every entry of
  `session.list.result`.
- `model.list` answers with the model catalog and the configured default. Each model carries
  its provider key, so the app groups the catalog the same way the server counts it.
  `model.get` / `model.set` / `model.effort.set` answer with `model.result` carrying the state
  the server actually stored (setting the default model id clears the override). `model.set`
  refuses a model the server does not know.
- `model.refresh` re-runs provider discovery on the spot instead of waiting for the six-hour
  cycle, and answers **two** frames: the fresh `model.list.result` first, then
  `model.refresh.result` (`models`, `failed`, `enabled`). The listing leads so the screen is
  already showing the new catalogue when the outcome appears under it. Concurrent passes coalesce
  in the catalogue, so the button cannot stack discoveries on top of the boot one. `failed` names
  the providers that opt into discovery and did not answer in full: their previous models are
  still listed (a provider that cannot be reached is not evidence that its models are gone), so
  saying which ones is the only way the owner can tell "nothing new" from "nobody answered".
  `enabled: false` means no provider opts into discovery at all, which makes a refresh a no-op.
  Refused when the build has no catalogue to refresh, rather than answered with a silent success.
- `model.endpoints` answers with the routes of one model, cheapest first, and with an empty list
  for a model that has a single route. Only the models marked `routes: true` in the catalogue are
  worth asking about, and the app asks when the routing step opens rather than up front: the
  server calls OpenRouter to answer (docs/model-identity.md). A route is selected by sending its
  `id` through `model.set`, pin included: the pin is part of the reference, not a field of its
  own.
- `instructions.list` / `instructions.get` / `instructions.set` drive the instructions page: the
  four files `buildSystemPrompt` reads (`CORE.md`, `SOUL.md`, `AGENTS.md`, `USER.md`), per
  workspace. `instructions.get` takes either a `file` or a `nested` path from the last list.
  `instructions.set` carries the `sha` the editor loaded, and an absent `sha` means "create this
  override" -- the server refuses a stale sha and an already existing file alike, because
  `AGENTS.md` is a file the agent writes too. A nested `AGENTS.md` is editable through the same
  two frames, with `nested` instead of `file`: relative to a workspace root as the scan lists it,
  or absolute when it comes from `session.instructions.result`, and then only with the `threadId`
  of the conversation that read it (see docs/session-instructions.md). Creation is refused for a
  nested file: which directories carry instructions is not a decision an editor screen presents. `nestedTruncated` names the workspaces whose nested
  scan hit the per-workspace cap, so the page says the list is incomplete rather than implying the
  directory holds nothing more; it is omitted when none were cut. See `docs/instructions-page.md`.
- `session.instructions.get` answers `session.instructions.result`: what one conversation is
  actually loaded with, layer by layer, plus the nested `AGENTS.md` its runs injected. The layers
  come from `composeSystemPrompt`, the same function the run joins into its system prompt, so the
  page cannot drift from what the model receives. Each layer carries its text, its size, where it
  was resolved from and, for the four prompt files, the `edit` target that opens the editor on it.
  See docs/session-instructions.md.
- `agents.config.get` answers with the whole agent-defaults snapshot: the global default
  model and effort, the configured providers (never a secret, only whether the env key is
  set) and one entry per agent with the model that actually runs for it (own pin or
  inherited) and its raw `skills`/`mcp`/`workspace`/`context.cap`/`maxIterations` config.
  `agents.model.set` with `agent: "global"` writes `llm.defaultModel`, with an agent key it
  writes `agents.<key>.llm`; the effort rides in the same frame — a level, or `""` to remove
  the pin — and writes `llm.effort` for the global target, `agents.<key>.llm.effort` for an
  agent. `agents.model.clear` removes an agent's model pin *and* its effort, so an unpinned
  agent never keeps the effort of a model it no longer runs. Every
  mutation answers with a fresh `agents.config.result`, never an optimistic echo, and a
  mutation that fails is refused with scope `agents`. Each agent row carries its own
  `effort` (absent when the agent pins none).
  The `agents` array is the two reserved roles followed by every file-defined agent
  (docs/file-agents.md), so a file dropped in `agents/` appears with no app release. A
  file-defined entry additionally carries `source`, `path`, `base` and, for a workspace tier,
  `layer`; a reserved role carries none of the four because it exists without a file. `skills`,
  `mcp`, `workspace`, `contextCap` and `maxIterations` show the effective value, config entry over
  file. Writes are refused for a name that is neither a role nor an existing agent, so the app
  cannot create an `agents.<typo>` section nothing reads.
  Each agent row additionally carries `unknownSkills` / `unknownMcp` (scope entries, from the
  config entry or the agent file, that match no installed skill and no declared MCP server) and
  `unknownWorkspace` (a workspace key absent from `config.workspaces`). The app renders them
  in red: an entry that exists in config but not in any live catalog is dead weight, and hiding
  it would make it unremovable.
- `agents.scope.set` writes the `agents.<key>.skills|mcp` override in the resolver's own
  vocabulary: `"inherit"` removes the key (the orchestrator's list applies, or everything),
  `"all"` is the `["*"]` wildcard, `"list"` the names picked (`[]` means "nothing", kept as a
  decision). Names are never validated against the live catalogs: the config is the truth, and
  a stale name is flagged red, not refused. `agents.workspace.set` pins or removes (null)
  `agents.<key>.workspace` and refuses a key that is not in `config.workspaces`. `agents.iterations.set`
  writes `maxIterations` (positive integer, null removes it); `agents.contextcap.set` writes
  `context.cap` (0 lifts the ceiling, null falls back on the global cap). Every mutation answers
  with a fresh `agents.config.result`.
- `agents.file.get` opens a file-defined agent as structured fields (`agents.file.result`):
  the frontmatter the loader reads (`description`, `base`, `tools`, `skills`, `mcp`, `model`,
  `workspace`, `maxIterations`, `contextCap`, `instructions`) plus the prompt body, the file's
  sha and `toolOptions` — the tool names of the agent's baseline, what the `tools:` picker may
  offer. `tools:` entries outside the baseline are reported in `unknownTools`: they are dropped
  at run time, so they are flagged instead of being silently saved into a set that never applies.
  `editable` is false for the built-in tier (repo-synced at boot); the app offers a fork, which
  is an `agents.file.create` with the same name in the custom tier. `agents.file.set` sends
  structured fields back; the server serializes the flat frontmatter itself (so a client can
  never produce a file the loader would reject), validates through the same `parseAgentFile` as
  the loader, and refuses a stale sha as a conflict. `agents.file.create` takes a name (the
  loader's own name rules) and the mandatory description; `agents.file.delete` removes a
  custom/workspace tier file and refuses the built-in tier. Writes land through the same atomic
  write + snapshot path as the other config edits, and the agent watcher reloads the registry,
  so the new agent or the edited scope applies on the next run with no restart.
- `tools.toggle` adds or removes a name in the global `tools.disabled` denylist and answers
  with the fresh `tools.list.result`. The listing carries `missing`, the denylist entries no
  tool carries anymore: the page shows them red so they can be cleaned, the same way a stale
  agent scope entry is.
- `mcp.add` declares a server under `mcp.<name>` (`stdio` needs a `command`, `sse`/`http` a
  `url`); `mcp.remove` deletes it; `mcp.enable` toggles `enabled` (absent is enabled). All
  three answer with the fresh `mcp.list.result`. The listing shows the declared wiring minus
  the secrets: `command`, `args` and `url` are shown, `env` and `headers` never leave the
  server. The config watcher's mcp applier opens/closes the connections, so the toggle applies
  live.
- `config.get` / `config.set` are the one surface without a structured editor: the raw
  config.json text with a sha round-trip. `config.set` runs the content through the same
  parser as boot before writing, so a structurally broken file never reaches disk; the watcher
  hot-reloads what survives, and the `config.saved` answer reports which sections changed and
  which ones need a reboot (channel tokens, the bind port, the workspace path).
- `workspaces.add` / `workspaces.remove` / `workspaces.rename` / `workspaces.path.set` are the
  full CRUD of `config.workspaces`. Keys follow the boot validator (no "default", no "/",
  absolute paths); `add` and `path.set` create the directory so the skills and agent tiers can
  open under it. `rename` moves the key and rewrites every `agents.<key>.workspace` pin that
  referenced the old name in the same write; a pin left pointing at a removed workspace is
  exactly what the red `unknownWorkspace` flag surfaces, and resolution now falls back to the
  default workspace instead of throwing, so a removed workspace never takes the runs that
  referenced it down. All four answer with the fresh `workspaces.list.result`, and since
  `workspaces` is hot-reloaded with the skills/agent watchers re-targeting their tiers, the
  new directory's layers follow live.
- `providers.upsert` / `providers.remove` / `providers.rename` are the CRUD of
  `config.llm.providers`, and `providers.env.set` / `providers.env.rename` /
  `providers.env.remove` / `providers.env.list` manage the `~/.my-claw/.env` side of the same
  entries -- the full surface of docs/providers-admin.md. Provider mutations answer with the
  fresh `agents.config.result`, env mutations with `providers.env.result` (names only, never
  values). `env.set` is the one frame that carries a secret value; it is never logged or
  echoed, and every provider write reloads the config and refreshes the model catalog so a new
  key discovers its models immediately.
- `jobs.list` / `jobs.save` / `jobs.delete` are the CRUD of the scheduled tasks
  (`~/.my-claw/cron/jobs.json`, the same store the `cron` tool edits). `jobs.list` answers
  with the fresh `jobs.list.result`; every mutation answers with the same fresh listing, never
  an optimistic echo, and a mutation that fails is refused with scope `jobs`. `jobs.save`
  without an `id` creates a job, with one it updates it; the `schedule` string is parsed
  server-side with the same rules as the `cron` tool (a cron expression, "every Xm/h/d", an
  ISO timestamp), and a schedule that does not parse is refused — the scheduler could not run
  it. `jobs.delete` removes a job and refuses an unknown `id`. A job made from the app always
  delivers `local` (its output is saved under `~/.my-claw/cron/output/<id>/`, nothing is sent):
  a phone has no chat of origin, so no other target is honest; the listing's `deliver` shows
  what existing jobs carry anyway.
  Each entry carries the job's editable fields (`name`, `prompt`, `schedule`, `enabled`,
  `model`, `effort`, `workspace`), its run bookkeeping (`state`, `repeat`, `completedRuns`,
  `nextRunAt`, `lastRunAt`, `lastStatus`, `lastError`, `createdAt`, `pausedReason`) and the
  per-job scope overrides in the app's editing vocabulary: `skillsMode`/`mcpMode`/`toolsMode`
  is `"inherit" | "all" | "list"` with the `skills`/`mcp`/`tools` names when a list applies.
  The overrides are slotted above `agents.cron` at run time exactly like the job's `model`
  and `effort` pins (the scheduler hands them to the session; `resolveAgent` applies them
  first), so a
  job with no scope field inherits the cron agent as before. Like the agent rows, each job
  carries `unknownModel`, `unknownWorkspace` and `unknownSkills`/`unknownMcp`/`unknownTools`
  computed against the live catalogs; the app paints them red but never refuses the save — the
  job is the truth. An unknown `workspace` is the one case with teeth: it pauses the job at its
  next run, so the page calls it out.
- A `chat.send` whose text is a known slash command (the catalog) is executed server-side
  like on the other channels and answered with `chat.command.result`; it never reaches the
  agent. Commands outside the catalog still route as normal messages. A command that has not
  answered within 400 ms first gets a `chat.command.pending` frame: `/compact` on a full
  session runs for minutes, and the chat showed nothing at all for that whole time. The
  placeholder is only ever sent when the wait is real, so a fast command never flickers one.
- A command and the bubble it produced are journaled on the conversation (`session.commands`),
  because a command never reaches the router and so leaves no trace in `messages`. Without the
  journal, `/compact`, `/stop` and their answers vanished from the thread at the first history
  reload: those bubbles only ever existed in the device's memory, and `seedHistory` replaces the
  screen with what the server has. See "The command journal" below.
- `notifications.register` hands the device's UnifiedPush subscription (`endpoint`, plus
  `pubKey`/`auth`) to the push store; an empty `endpoint` unregisters the device.
  `notifications.state` reports the device's foreground state (`foreground`, optional
  `threadId` of the active thread) so the server can skip run-completion notifications for the
  thread that is already on screen. Full design: `docs/notifications.md`.
- `jobs.runs { jobId }` lists the run sessions of one job, newest first, as
  `jobs.runs.result { jobId, runs: [{ threadId, runAt, messageCount, title }] }`. Every run
  leaves a real session on disk (the scheduler keeps them, capped at 25 per job), so each
  `threadId` (`cron-<jobId>-<runTs>`, the slash-less form of the session id `cron/<jobId>/<runTs>`)
  is openable like any conversation: `session.history` reads it, `chat.send` routes to it and
  the stream answers on it. `chat.stop`, rename and delete work the same way. An unknown
  `jobId` is refused on the jobs scope.
- `subagents.list { threadId }` lists the sub-agents reachable from that conversation, as
  `subagents.list.result { threadId, agents: [...] }`. `threadId` is the parent conversation;
  the answer is scoped by the runner, so a `private` sub-agent belonging to another conversation
  is absent rather than hidden. One-shot agents (`subagent/run-<uuid>`) are kept after their run
  and listed the same way, for their parent conversation only. Each entry carries its own
  `threadId` (`sub-<16 hex>`, a digest of the session id) which is what the app opens; `id` is the
  real session id and is what the roster shows, because `displayName` is picked by the model and is
  not unique. Refused on the `subagents` scope when the threadId is invalid or the runner is not
  wired. Deleting a conversation removes its private sub-agents with it; shared ones survive and
  stay listed everywhere.
- `chat.send` with a sub-agent handle as its `threadId` drives that sub-agent: history, streaming,
  tool cards and reasoning behave as in any conversation, and `chat.stop` reaches it. Such a send
  carries `parentThreadId`, the conversation the roster was read from, which is matched against the
  sub-agent's recorded parent to apply the visibility rule; absent, only a `global` sub-agent
  answers. A message sent while the sub-agent is already running is injected into that run at the
  next iteration boundary rather than queued; its answer streams back on the same thread, with the
  usual turn switch, unless the running turn was started by its parent (parent-driven runs are
  non-streaming, so the answer then lands in the sub-agent's history).
- `subagents.callers { threadId, parentThreadId }` lists the conversations that have driven this
  sub-agent, newest first, so the owner can hand one of its answers back to a caller. Answered to
  the asking socket alone (`subagents.callers.result`): a menu opening is not a state change. The
  visibility rule is applied to `parentThreadId` exactly as for kill and reset, and an unreachable
  sub-agent answers like a missing one.
- `subagents.handoff { threadId, parentThreadId, targets, messageId?, note?, mode }` hands one of
  the sub-agent's answers back. Broadcast, since it writes into other conversations. `targets` are
  session ids taken from `subagents.callers.result` and re-checked against it server-side; `mode`
  is `ask` (a real turn in the target, so the orchestrator acts on it) or `note` (filed in the
  target's command journal, never prompted). `subagents.handoff.result` reports a per-target
  outcome, since one target being gone must not hide the ones that landed -- docs/subagent-navigation.md.
- `subagents.kill { threadId, parentThreadId }` deletes a sub-agent, transcript included;
  `subagents.reset { threadId, parentThreadId }` archives its transcript and starts it over with its
  identity and workspace kept. `parentThreadId` is the caller the visibility rule is applied to, as
  for a sub-agent `chat.send`. Both answer with `subagents.list.result` for the parent thread; a
  refusal is an `error` on the `subagents` scope and sends no roster.

Handing a sub-agent's answer back to its parent needs no frame of its own: it is a `chat.send` on
the parent thread whose text quotes the sub-agent, which the router injects into a running parent or
runs fresh like any other message.

### Server -> Device

```json
{ "type": "chat.message", "id": "uuid", "text": "...", "threadId": "projet", "attachments": [...], "replyToId": "uuid" }
{ "type": "chat.run.start", "threadId": "projet", "run": "a1b2c3d4" }
{ "type": "chat.run.end", "threadId": "projet", "reason": "done|aborted|error", "run": "a1b2c3d4" }
{ "type": "chat.stream.start", "id": "uuid", "threadId": "projet", "replyToId": "uuid" }
{ "type": "chat.stream.delta", "id": "uuid", "threadId": "projet", "text": "..." }
{ "type": "chat.reasoning.delta", "id": "uuid", "threadId": "projet", "text": "..." }
{ "type": "chat.reasoning.tokens", "id": "uuid", "threadId": "projet", "tokens": 1240 }
{ "type": "chat.stream.done", "id": "uuid", "threadId": "projet" }
{ "type": "chat.stream.abort", "id": "uuid", "threadId": "projet", "error": "..." }
{ "type": "chat.tool", "id": "uuid:tool:1", "threadId": "projet", "turnId": "uuid", "name": "bash", "args": {...}, "durationMs": 4, "ok": true, "output": "...", "truncated": false, "ts": "iso" }
{ "type": "chat.history", "threadId": "projet", "before": 50, "hasMore": true, "nextBefore": 100, "messages": [{ "id": "h-...", "role": "user|assistant", "text": "...", "ts": "iso", "transcript": "...", "run": { "id": "r-...", "status": "running|done|aborted|error", "startTs": "iso", "endTs": "iso" }, "attachments": [{ "id": "uuid", "type": "image", "filename": "photo.png", "mimeType": "image/png", "sizeBytes": 5120, "durationMs": 3100, "deleted": false }] }] }
{ "type": "session.list.result", "sessions": [{ "threadId": "...", "title": "...", "messageCount": 4, "createdAt": "...", "lastActiveAt": "...", "archived": true, "pinRank": 0, "activeRun": true, "workspace": "default", "hasDraft": true }] }
{ "type": "draft.changed", "threadId": "projet", "text": "ce qui est tape ailleurs", "ts": 1755690000000 }
{ "type": "session.workspace.set.result", "threadId": "projet", "workspace": "sofa" }
{ "type": "commands.list.result", "commands": [{ "name": "status", "description": "..." }] }
{ "type": "files.list.result", "threadId": "projet", "files": [{ "id": "uuid", "filename": "note.pdf", "type": "file", "mimeType": "application/pdf", "sizeBytes": 5120, "ts": "iso" }], "totalBytes": 5120 }
{ "type": "approval.request", "id": "uuid", "threadId": "projet", "toolName": "bash", "args": {...}, "expiresAt": 123, "allowSessionOffered": false }
{ "type": "approval.resolved", "id": "uuid", "threadId": "projet", "reason": "expired|cancelled|answered-elsewhere" }
{ "type": "approval.history.result", "threadId": "projet", "entries": [{ "id": "uuid", "toolName": "write", "args": "{...}", "outcome": "allow-session", "requestedAt": "iso", "decidedAt": "iso", "durationMs": 1200, "auto": false }], "stats": { "total": 1, "allowed": 1, "denied": 0, "expired": 0 } }
{ "type": "question.ask", "id": "que_...", "threadId": "projet", "replyToId": "tc-...", "questions": [{ "header": "Langue", "question": "FR ou EN ?", "options": [{ "label": "fr" }, { "label": "en" }], "multiple": false, "custom": true }], "ts": "iso" }
{ "type": "question.resolved", "id": "que_...", "threadId": "projet", "reason": "answered|canceled" }
{ "type": "chat.transcript", "threadId": "projet", "replyToId": "uuid", "items": [{ "id": "uuid", "text": "ce que le serveur a entendu" }] }
{ "type": "chat.command.pending", "threadId": "projet", "replyToId": "uuid", "text": "Running /compact..." }
{ "type": "chat.command.result", "threadId": "projet", "replyToId": "uuid", "text": "output of a command the server executed", "details": "long aside, folded in the bubble" }
{ "type": "chat.send.queued", "threadId": "projet", "replyToId": "uuid", "reason": "compaction" }
{ "type": "chat.cleared", "threadId": "projet" }
{ "type": "voice.mode.result", "mode": "auto", "resolved": "cloud", "cloudAvailable": true }
{ "type": "update.result", "started": true, "version": "0.4.2", "reason": "busy|denied|failed", "detail": "sudo: a password is required" }
{ "type": "model.list.result", "models": [{ "id": "gpt-5.1", "label": "GPT-5.1", "group": "OpenAI/Pro", "provider": "openai", "effortLevels": ["low", "medium", "high"], "context": 400000 }, { "id": "tag:opus", "label": "opus", "group": "Tags", "effort": "xhigh" }], "defaultModel": "gpt-5.1" }
{ "type": "model.refresh.result", "models": 412, "failed": ["groq"], "enabled": true }
{ "type": "model.endpoints.result", "model": "openrouter/openai/gpt-5.1", "endpoints": [{ "id": "openrouter/openai/gpt-5.1@azure/eu", "label": "Azure (azure/eu)", "promptUsd": 0.22, "completionUsd": 0.88, "context": 400000, "uptime30m": 99.9 }] }
{ "type": "model.result", "threadId": "projet", "model": "gpt-5.1", "defaultModel": "gpt-5.1", "effort": { "level": "medium", "levels": ["low", "medium", "high"], "supported": true }, "context": { "raw": 400000, "effective": 256000, "cap": 256000, "choice": 256000, "used": 94000 } }
{ "type": "skills.list.result", "skills": [{ "name": "voice", "description": "Voice mode plumbing", "version": "1.0.0", "source": "built-in|custom|workspace", "path": "/home/neras/.my-claw/skills/.builtin/voice/SKILL.md", "workspace": "sofa" }] }
{ "type": "tools.list.result", "tools": [{ "name": "bash", "description": "Run a command in the workspace", "source": "built-in", "disabled": false }, { "name": "my_weather", "description": "Forecast for a city", "source": "plugin", "disabled": false }, { "name": "mcp__mailcow__get_status", "description": "Mail server status", "source": "mcp", "server": "mailcow", "disabled": false }], "missing": ["cron"] }
{ "type": "workspaces.list.result", "workspaces": [{ "key": "default", "path": "/home/neras/.my-claw/workspace", "default": true }, { "key": "sofa", "path": "/home/neras/dev/SOFA", "default": false }] }
{ "type": "mcp.list.result", "servers": [{ "name": "mailcow", "transport": "stdio|sse|http", "state": "connected|disabled|failed", "toolCount": 2, "lastError": "spawn ENOENT", "lastAttemptAt": "iso", "enabled": false, "command": "mcp-mail", "args": ["--port", "2525"], "url": "http://mcp.local" }] }
{ "type": "instructions.list.result", "entries": [{ "workspace": "sofa", "file": "AGENTS.md", "origin": "own|inherited|fallback|off", "from": "default", "bytes": 1240, "sha": "9f2b1c4d5e6a", "inherit": "default|lab|builtin|none", "off": false }], "nested": [{ "workspace": "default", "path": "svc/AGENTS.md", "bytes": 400 }], "nestedTruncated": ["dev"], "files": ["CORE.md", "SOUL.md", "AGENTS.md", "USER.md"], "maxBytes": 262144, "agentLayers": [{ "agent": "reviewer", "layers": ["CORE", "USER"] }] }
{ "type": "instructions.file", "workspace": "sofa", "file": "AGENTS.md", "content": "...", "origin": "own|inherited|fallback|off|nested", "from": "default", "sha": "9f2b1c4d5e6a", "editable": true }
{ "type": "instructions.saved", "workspace": "sofa", "file": "AGENTS.md", "ok": false, "sha": "", "conflict": true, "error": "changed on the server since it was opened" }
{ "type": "agents.config.result", "defaultModel": "gpt-5.1", "defaultProvider": "openai", "defaultEffort": "high", "effortLevels": ["low", "medium", "high", "xhigh", "max", "ultra"], "providers": [{ "key": "anthropic", "type": "claude-sdk", "group": "Claude", "discover": true, "models": 14, "keyEnv": "ANTHROPIC_API_KEY", "keyPresent": true }], "agents": [{ "key": "orchestrator", "label": "Orchestrator", "description": "The agent you talk to", "model": "gpt-5.1", "provider": "openai", "pinned": false, "inheritsFrom": "global" }, { "key": "cron", "label": "Scheduled tasks", "description": "Jobs on a schedule", "model": "gpt-5.1", "pinned": false, "inheritsFrom": "orchestrator" }] }
{ "type": "agents.file.result", "name": "reviewer", "source": "custom", "path": "/home/neras/.my-claw/agents/reviewer.md", "editable": true, "sha": "9f2b1c4d5e6a", "description": "Reviews a diff", "base": "research", "tools": ["read", "search"], "skillsMode": "list", "skills": ["code-review"], "mcpMode": "absent", "prompt": "You review code.", "toolOptions": ["read", "search", "ls"], "unknownTools": [] }
{ "type": "agents.file.saved", "name": "reviewer", "ok": true, "sha": "9f2b1c4d5e6a", "conflict": false }
{ "type": "config.result", "content": "{ ... }", "sha": "9f2b1c4d5e6a", "maxBytes": 524288 }
{ "type": "config.saved", "ok": true, "sha": "9f2b1c4d5e6a", "conflict": false, "changed": ["llm"], "rebootRequired": [] }
{ "type": "notifications.info", "vapidPublicKey": "..." }
{ "type": "hello", "version": "0.1.204" }
{ "type": "tags.result", "tags": [{ "name": "Default", "model": "gpt-5.1" }, { "name": "opus", "model": "claude-opus-4-8", "effort": "xhigh", "contextCap": 50000 }] }
{ "type": "jobs.runs.result", "jobId": "abc123def456", "runs": [{ "threadId": "cron-abc123def456-1723200000000", "runAt": 1723200000000, "messageCount": 4, "title": "Morning report · 08/08 19:30" }] }
{ "type": "error", "message": "...", "scope": "chat|files|session|diag|logs|voice|model|skills|agents|mcp|tools|instructions|config|workspaces|jobs|notifications" }
```

- `skills.list.result` feeds the app's skills page. `path` is display-only (where to edit the
  file on the server); reading goes through `GET /skills?device&token&source&name`, which
  serves the raw `SKILL.md` (`text/markdown`) with the same device auth as `/media`.
  `workspace` is present only on skills of a named workspace. The catalog is the *unresolved*
  one (every tier, every workspace), so each entry says which copy wins: `overriddenIn` lists
  the workspaces masking a global entry, `overrides` names the global tier a workspace skill
  masks. See docs/skills.md.
- `skills.copy` / `skills.move` transfer one skill **directory** (SKILL.md plus its references
  and scripts) between tiers, and are answered with a fresh `skills.list.result`. Rules, all
  enforced server-side:
  - `target.source` is never `built-in`, and `built-in` cannot be a *move* source: that tier is
    resynced from the release by hash at every boot, so a write there is undone and a delete
    comes back.
  - a name already taken in the target tier is refused unless `overwrite` is set, so a replace
    is always something the owner asked for twice.
  - names and workspace keys are held to `[A-Za-z0-9._-]+` on the wire, then re-resolved against
    the tier root before anything touches the filesystem (same two fences as `GET /skills`).
  - a move is a copy followed by the source delete, in that order: an interrupted transfer
    leaves a visible duplicate rather than nothing.
- `tools.list.result` feeds the app's tools page: the whole catalog as the orchestrator sees
  it (per-agent narrowing is a run-time concern, not a reading surface). `source` tells where
  each tool comes from -- built into the server, an owner-authored `tools.d/` plugin, or an
  external MCP server; MCP tools carry their `server` name so the page can group them, and
  the MCP *settings* stay on the `mcp.list` page. `disabled` mirrors the global
  `tools.disabled` denylist, read live so a hot-reloaded edit shows up on the next visit.
  Parameters are deliberately absent: the wire carries a catalog to read, not schemas to edit.
- `workspaces.list.result` feeds the settings page: the default workspace plus every named
  entry of `config.workspaces`.
- `mcp.list.result` is the wire version of `/mcp`: every server declared under `config.mcp`,
  with the state the manager holds for it. A server that failed to connect is listed with
  `state: "failed"` and its `lastError`, since dropping it would hide exactly the entry worth
  reporting, and a disabled one is listed with no `lastAttemptAt` because it was never tried.
  The declared wiring is shown minus the secrets: `command`, `args` and `url` reach the device
  so the page can display what a server is and offer add/remove/enable, while `env` and
  `headers` never leave the server. The frame exists so the app can name the servers an agent's
  `mcp` scope refers to instead of asking the owner to type names it cannot check.
- `instructions.list.result` never reports a file as missing: a workspace that does not carry
  one reads the configured source's copy, and that is what the agent reads, so the entry
  carries `origin` and `from` instead of a hole. `inherit` and `off` are the workspace's
  effective per-file policy, always normalised; their *absence* is how the app detects a server
  that predates the layer controls, and hides them instead of showing a dead button.
  `agentLayers` carries the file-defined agents and the layers each declares, so the layer
  screen can say which agents already cut a layer in their own file. `files` and `maxBytes`
  come from the server so the app never hardcodes limits the server enforces.
- `instructions.layer.set` sets the per-file policy of one workspace: each absent field keeps
  the current one, `"default"` and `false` are the no-op resets, and it answers with a fresh
  `instructions.list.result` rather than an echo. The server drops fields that say nothing, so
  a policy that is back to the default disappears from `config.workspacePrompts` entirely.
- `instructions.saved` answers every `instructions.set`, refusals included. A refusal does not
  go through the error scope because the editor must tell a conflict (`conflict: true`, meaning
  reload before saving again) apart from a plain failure. The previous content is snapshotted
  before every write, so `/config rollback` can undo an edit made from the app.

- `chat.command.result` is the output of a slash command executed by the server. The app
  renders it as a distinct bubble so a command result never masquerades as an agent answer.
- `details` on a command result is an aside too long to state inline: today, the summary a
  `/compact` produced. The app folds it under the outcome line, in the same collapsed block it
  uses for a model's reasoning, so the thread keeps one short bubble either way.
- A replayed command answer carries `command: true` on its history entry, and its aside in
  `details`: the same two fields the live frames set, so a reopened thread draws the same bubble.
- `chat.command.pending` announces a command still running past 400 ms, keyed on the same
  `replyToId` as its result. The app draws it as a placeholder bubble that the result replaces
  in place, so the wait and the answer are one bubble, never two. A placeholder is also dropped
  when a stream starts on the thread: the agent answered, so no result is coming.
- `chat.send.queued` says a send is parked: a compaction holds the session, so the router waits
  for it before opening the run (`docs/compaction.md`). The app marks that bubble with a running
  counter instead of leaving it silent for the length of the compaction, which read as a dropped
  message. It is lifted by `chat.stream.start`, by a `chat.message`, or by `chat.run.end`, so a
  single lost frame cannot strand the mark.
- `chat.cleared` says the server dropped the thread's history (a conversation deleted from
  another window); the app drops its copy on this frame rather than guessing from an empty history.
- `model.list.result` / `model.result` feed the app's model picker and the per-thread
  indicator. `effort.level` is `""` when the model discards effort. `context.used` is how full
  the window is (docs/context-window.md): the chat header shows it as a percentage. The app asks
  for it when it opens a thread and again when a run ends, and the server pushes the same frame
  unasked on every `session:context:measured`, so the share follows a run instead of reporting
  where the run started. One push per turn, tool calls or not, at the earliest moment the engine
  knows the count: for the SDK that is `message_start`, before a token of the answer. A compaction,
  and the SDK's own mid-run boundary push it as well, since each moves the figure with no
  turn behind it. A push is a `model.result` like any other, matched only by `threadId`: there is no
  correlation id, and the app applies it through the path it already had.
- `model.set`, `model.effort.set` and `model.context.set` answer **every device of the owner**, not
  only the one that asked: the pick belongs to the thread, so a browser left open on the same
  conversation would otherwise keep naming the previous model until it reloaded. `model.get` stays a
  private answer, since it changes nothing.
- `commands.list.result` carries the shared command catalog (same source as the
  single source of truth), so the app's slash-menu can never drift from the server:
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
echo, and the `[Audio]: "..."` rewrite are shared channel-agnostic code.

The transcript comes back as `chat.transcript`, addressed to the `chat.send` id the device
generated, with one entry per recording keyed by attachment id, so each note renders its own
words. A message can carry several: the mic stays available while there is no text, and the
`[Audio 1]`, `[Audio 2]` labels in the stored turn keep them apart in the prompt too. Other channels would get the
same text as an echo message (`voice.stt.echoFormat`); here that echo is dropped, because a
standalone turn quoting the bubble above it says the same thing twice and pushes the conversation
apart. A take that failed has no transcript, so its warning still arrives as a message.

`voice.mode.get` / `voice.mode.set` expose the engine choice: `cloud` (Groq whisper-large-v3),
`local` (faster-whisper, nothing leaves the machine), or `auto`. A set is persisted to
`config.json` rather than applied in memory only, because a switch flipped in the app means "from
now on" and must survive a restart; `voice` is hot-reloaded, so the next recording uses it.
`cloudAvailable` is false when no `GROQ_API_KEY` is set, so the app can say why cloud is not an
option instead of offering a choice that fails.

`update.run` runs the maintenance gate now instead of at the next 15-minute tick; the mechanism,
the privilege it needs and the reason the answer arrives before the socket dies are in
`docs/auto-update.md`.

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
for display/download, and `GET /media/<id>?thumb=1` serves a generated video preview
frame (one JPEG per video, extracted with ffmpeg on first request and cached under
`$MY_CLAW_DIR/files/my-claw-app/.thumbs/`; non-video media answers 404). The channel
keeps no size cap: uploads stream straight to disk, and attachments the agent sends
(`MEDIA:` refs and programmatic attachments) are copied into the same store, so they
count toward the conversation's file size, are served like uploads, and die with the
session. Attachments past
`channels["my-claw-app"].files.warnSizeBytes` (default 50 MB) are logged with a
warning and stored anyway. The agent receives the
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

`chat.history` is also the ack for `session.delete` (empty messages list).

History is paged backwards. `session.history` takes `before`, a count of messages back
from the newest one, or `beforeId`, the id of the client's oldest held item; absent or `0` is
the newest page, which the app uses to replace the thread. The reply carries `hasMore` and
`nextBefore`, and the app sends the oldest held item's id back as `beforeId` to walk further
(`before` and `beforeId` are both sent; the server answers the id where supported). The id
cursor stays exact when the session grows between two loads and when the app unloads its
oldest items past its in-memory cap; the count cursor drifts in both cases. It comes from the
server because the app cannot derive it -- one stored message can become two bubbles (an
assistant turn plus its tool card) and a `role:"tool"` message becomes none of its own, so
the entry count says nothing about how far back the app now is. A cursor past the start of
the session is an empty page with `hasMore: false`, not an error. A server that answers
neither field is one that predates this, and the app simply never asks for an older page.

A thread is opened and resumed with `session.sync`, and its answer carries the paging cursor
with the window that replaces the client's thread: a fresh window (no `since`, or a reset)
includes `hasMore` and `nextBefore`, so the reader at the top knows there is older work and
where to ask -- the delta answer never does, it leaves the cursor the client already holds
standing. Without those fields on the fresh window (0.4.82 and older), the app's `hasMore`
stayed false and lazy loading never fired.

A page is a count of messages but a conversation is read in turns, so the slice is grown
backwards to the user message that opened the turn it starts in. One agentic turn is easily
fifty tool results: cut at the count, the newest page began inside the work and left the
question that caused it on the page above, which reads as a lost message rather than as
pagination. The walk back is capped at one extra page, so a turn longer than that still starts
mid-flight instead of dragging the whole session into one reply. Pages stay disjoint: the next
cursor is the grown start, so the page above ends exactly where this one begins.
`session.list.result` carries both halves in one round-trip: archived threads are
flagged `archived: true` rather than left out, so the app can fill its two lists and
show the archived count without asking twice. Most recently active first, capped at 50.

App conversations are never swept: `pruneOldSessions` drops stale sessions on the chat
platforms only. A thread the owner can see listed, named and archived must still be there
after a quiet month.

### Tool calls

Unlike the text channels, which glue a formatted note inside the reply, this
channel emits one `chat.tool` frame per executed tool so the client can render a
collapsed card and expand it on tap. `turnId` is the stream id the run started
with, which groups the cards of a turn.

A tool card seals the text bubble it interrupts: the streamer sends
`chat.stream.done` for the current id, then the cards, then a fresh
`chat.stream.start` with id `<turnId>#<n>` for the text that follows. Bubbles
therefore stay in chronological order without the client reordering anything.

A card is keyed on the id the model gave the call, `t-<call id>`, and both the live stream and
the history builder mint it through the same helper (`toolCardId`). They used to mint their own
-- `<turnId>:tool:<n>` live, `h-<timestamp>-<n>` in history -- which was invisible until a page
reloaded mid-call: the two cards for one call had different ids, so the `chat.tool` that closed
the call could not find the card history had drawn and appended a second one below it. A
provider that sends no call id still falls back to the turn counter.

A call with no result yet is reported as `running: true`. The assistant turn is written to the
session before its tools run, so a reload during a long call finds a `toolCalls` entry with no
matching `role:"tool"` message. History used to read the missing result as an empty one and
rebuild the card as finished, successful and empty: the spinner never came back and the run
looked done while it was still going -- the sub-agent panel, which asks for status
(`subagents.list`) instead of replaying frames, kept saying `running` and contradicted it. The
distinction is a `has` rather than a `?? ""`, and the flag is only ever set by the history path;
live cards get their spinner from `chat.tool.start` as before.

A card carries its output clipped to `TOOL_OUTPUT_LIMIT` (4000 chars), with `truncated: true`
when anything was cut. Lifting the limit was the obvious fix and the wrong one: every reconnect
replays a whole page of history, so the bytes of every tool that ever ran would be paid for by
every device, every time, for the sake of the few outputs a reader actually opens. `truncated` is
therefore a "there is more, ask for it" rather than a dead end: `chat.tool.full` names a card by
id and `chat.tool.full.result` answers with the output whole, read straight from the session.
`found: false` is a card whose call the session no longer holds (a compaction dropped the turn),
and the app then keeps the clipped text it already has rather than blanking the block.

`chat.spawn.start` annotates a spawn card with its sub-agent identity, and `chat.spawn.end` settles
it live. The assistant tool call also persists the spawn lifecycle state (`running`, `complete`,
`error` or `aborted`) with its timestamps and result metadata. A reload during the narrow window
between the lifecycle end and the outer `chat.tool` result therefore replays a settled card instead
of resurrecting an empty spinner. Lifecycle writes are serialized per session, so a later turn
cannot overtake the terminal snapshot on disk. Older sessions without this metadata still fall
back to `subagents.list`, in one place: `reconcileSpawnRoster` resolves the card's name against the
roster when it arrives and writes the recovered state into the map every reader shares.
`spawnLiveOf` is a pure projection of what the card already carries -- it used to re-derive the same
match from the roster it happened to hold, which was a second copy of one rule and a second place
for it to drift. The fallback applies only to a card whose own call has not returned, and it never
invents a successful terminal state for an idle legacy card: a session sub-agent is reusable, so an
idle roster entry identifies neither that this call is the running one nor how it ended.

`send` runs the same lifecycle as `spawn`, and the `action` field (`spawn` or `send`) is the only
difference on the wire. It used to run none of it: the tool carried no call id, emitted no
lifecycle event and got no streamer, so driving an existing sub-agent painted a plain tool card
with no status, no link to the child thread and nothing replayed after a reload, while the very
same sub-agent shown by `spawn` had all of it. The events are emitted only when the tool call id
is present, which is exactly the model-driven path: a human typing in the sub-agent's own thread
has that thread as its UI and no parent card to annotate. A send from a conversation other than
the spawner also reports its terminal state to the caller, since the card being watched belongs to
whoever sent the message, not to whoever created the agent.

### Several surfaces per device

A device may hold **as many sockets as it opens**, and every broadcast reaches all of them
(`SocketRegistry`). It used to be one socket per device id, with a new one closing the old on
`1000 "replaced"`, which was wrong for the web: a browser's device id comes from its session
cookie, so it belongs to the profile and not to the tab. Two tabs of one profile were therefore one
device fighting itself, each open evicting the other, each close scheduling a one second retry, and
a successful open resetting the backoff so the war never decayed. Measured on 2026-08-20: eleven
connect/disconnect cycles in eleven seconds on a single device id.

The two operations that address a device rather than an owner, `device.revoke` and disabling a
device in the config, close **every** socket of it: leaving one tab connected would defeat their
purpose. The client has its own half of the fix, a connection that dies within five seconds counts
as a failed attempt so the backoff keeps growing whatever the close code says.

### Drafts

`draft.set` carries what the owner has typed and not sent; the server stores it per conversation and
mirrors it to their **other** windows as `draft.changed`, never back to the sender. It is debounced
device-side and deduped server-side, so typing costs a handful of frames and a reconnect costs none.
The newest page of `chat.history` carries the draft of the thread it replays, and `session.list`
reports `hasDraft` so the drawer can mark a conversation without shipping every draft in the
listing. A `draft.changed` is applied only into a composer that is empty or unfocused. Full rules,
lifecycle and caps: docs/draft-sync.md.

### Tool approvals

A blacklisted tool is not run until the owner says so, and this channel is the only place that
can answer. With `approvals: false` (the default) the prompt is never shown and the call is
denied outright, so the setting is what decides between "asks" and "never runs".

The response carries the **grant**, not a boolean. `accepted: true` used to be read as
`allow-session`, so approving a single call silently whitelisted the tool for the rest of the
conversation; the device now names one of `allow-once`, `allow-session` or `deny`. Anything else
on the wire, including an older client's `accepted`, is treated as a deny: a tool must never run
because a frame was unreadable.

`allowSessionOffered` says whether the session grant is on offer at all. It is false for the
per-invocation tools (`bash`, `memory`), where every call is a distinct decision, and the server
downgrades a session grant to `allow-once` for them even if a device asks for one.

A prompt that is answered, times out, or is cut short by a shutdown emits `approval.resolved` to
every window of the owner, so a sheet is never left asking about a call that is already decided.

Every outcome is written to `approvals.db` (`src/approvals/store.ts`), including the ones nobody
saw: a call covered by an earlier `allow-session` runs with nothing on screen and is journalled
with `auto: true`. `expired` and `cancelled` are kept apart from `deny` on purpose -- neither is
a decision the owner made, and reading them as a refusal would blame him for a machine event.
`approval.history` reads it back, scoped to the asking device's owner and capped at 200 rows.

### Ask questions (`question` tool)

The `question` tool ([src/tools/question.ts](../tools/question.ts) on the server) asks the owner
and blocks the run until answered. It is main-only: sub-agents and cron never get it (registry
exclusions), so a question is always a conversation between the orchestrator and its owner. There
is no timeout: a question the owner has not answered is a run waiting on a person, and the run
stays current until he answers, stops, or types.

```
{ "type": "question.ask", "id": "que_...", "threadId": "projet", "replyToId": "t-call_1", "questions": [...] }
{ "type": "question.pending", "entries": [ { "id": "que_...", "threadId": "projet", ... } ] }
{ "type": "question.reply", "id": "que_...", "answers": [["fr"], ["1", "2"]] }
{ "type": "question.resolved", "id": "que_...", "threadId": "projet", "reason": "answered|canceled" }
```

- **The form is drawn in the conversation, not over it.** `replyToId` is the *card* id
  (`toolCardId(callId)`, i.e. `t-<callId>`, never the model's raw call id): the app draws the
  questions inside the running `question` tool card, which is exactly where the run stopped. A
  question is a reason to go and read something -- the thread above, a file, another conversation
  -- so it must not be a modal. The app keeps the answers in a store, not in the card, because the
  list unmounts rows that scroll off.
- **`question.pending` is sent to every socket at connect**, and is authoritative: the client
  replaces its whole pending set with it. Nothing pushed while a socket was down is replayed, so
  this is what an app that was killed, asleep or offline is told; and the empty list is just as
  meaningful, it is what clears a card kept from a server that died holding a question.
- The ask is broadcast to every window of the owner (and replayed to a window that reconnects via
  the live-turn journal, like approvals), and a push notification is raised for devices that are
  not already foreground on the thread -- with the device's own alias in the tray.
- `question.reply` answers every question at once (one array of selected labels per question, in
  order); the first answer wins, the other windows drop their card via `question.resolved`. A
  question left blank is sent as an empty array: unanswered is an answer, and blocking the batch
  on it is how an owner gets stuck.
- **Stop cancels the question, not the run.** A `chat.stop` while a question is pending resolves
  it as `canceled`, the tool reports "User canceled the questions", and the run carries on with
  whatever it has. A second Stop (no question pending) is the usual stop.
- **Typing cancels the question too.** A `chat.send` (a plain message, not a slash command)
  while a question is pending resolves it as `canceled`, then routes the message normally: it
  reaches the run's mailbox and is injected as the next user turn. The owner's words are the
  steering; the question card is dropped everywhere.
- The settle writes one tool entry like any other: the same card then renders what was asked and
  what was picked (or the cancel), so reopening the thread reads as the exchange it was. No second
  card, and no state to reconcile.

### Reasoning

`chat.reasoning.delta` carries what the model thought, for the bubble named by
`id`; `chat.reasoning.tokens` carries a running estimate instead, for engines
that redact the text (the Claude Code bridge). Either one **opens the bubble on
its own**, before any answer text, because the thinking phase is the silence the
owner is waiting through. Reasoning belongs to the segment it arrived in, so a
tool card resets it just as it resets the text.

This is the only channel that receives them: no other surface provides a
reasoning sink to the run. Full rules, per-engine capability and the reason the
reasoning is never replayed to a model: `docs/reasoning-visibility.md`.

### Run lifecycle

One inbound message is one run, bracketed by `chat.run.start` and
`chat.run.end` regardless of how many tools or model turns it takes: the
client pins its Stop affordance to these frames, not to the stream bubbles,
so it survives tool calls and only disappears when the run does. `reason`
distinguishes a finished run from one stopped by the user (`aborted`) or one
that failed (`error`). `activeRun` on `session.list.result` carries the same
state to a device that connects or reconnects mid-run.

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

The app builds the URL from its own credentials; the media registry is a small
look-aside cache over the session store and dropped on adapter stop.

## The command journal

A slash command is answered by the server and never routed, so nothing about it lands in
`session.messages`. Its three bubbles (the command, the optional `Running /...` placeholder, the
answer) lived only in the device's memory, and the first `chat.history` wiped them: `seedHistory`
replaces the screen with the server's version by design, so an old build can never leave a stale
bubble behind. Observed effect: a `/compact` or a `/stop` disappeared from the thread minutes
after it ran.

The record is `session.commands`, an array of `{ input, output, timestamp, details? }` stored
inside the session file:

- **Beside the messages, not among them.** On the home loop `messages` *is* the prompt, so a
  `/status` table stored there would be fed back to the model and then summarized by the next
  compaction. The journal is read by `history()` only.
- **Deleted with the conversation, by construction.** It is a field of the session, so `remove`,
  takes it along. There is no side file to orphan.
- **Uncapped.** A conversation keeps everything it was told, and the owner asked for the caps to
  go: the file is rewritten in full on every turn, so a long journal costs disk and nothing else.
- **Masked.** `input` goes through `redactCommandArgs`, so `/claude set-token` is journaled as
  `set-token [redacted]`.

Two cases are left out on purpose: a
`/status` answered with a structured payload (the app draws a page rather than a bubble, so
replaying one would show something that never existed on screen), and a command on a thread with
no session yet (there is no history to attach it to). Failures are journaled: the owner saw that
bubble too.

`history()` merges the journal into the page it belongs to, by timestamp. Entries are flushed as
the messages are walked, so a command sits where it was typed rather than in a block at one end.
A page is bounded below by its first message and above by the first message of the page after it,
which is what keeps a command out of two pages at once; the newest page has no upper bound, so a
command typed after the last message (the usual case) still shows up.

The two ends of the history are deliberately open:

- **The first page has no lower bound.** A local compaction rewrites `session.messages` down to a
  head, a summary and a tail, so the journal outlives the messages it was interleaved with. Bounded
  by the oldest surviving message, everything typed before it became unreachable while still
  sitting in the file.
- **No per-page cap.** A journal entry belongs to exactly one page, so a page that replayed only
  the last twenty put the rest out of reach for good.

## The failure journal

Same problem one layer up: a run that dies says so on `chat.stream.abort`, a stream frame and
nothing else. The next `chat.history` replaced the screen with the server's version, where the
failure had never existed, so the thread reopened on a question with nothing under it. Measured on
`API Error: 529 Overloaded`, which the CLI only surfaces after minutes of its own retries, and on
that run the question itself was gone too (see "A failed run keeps the question" in
`docs/claude-sdk-backend.md`).

The record is `session.failures`, an array of `{ error, timestamp }`, written by
`recordFailure(owner, threadId, error)` from the same catch that ends the run and with the same
text the live bubble showed (`briefError`, 200 chars). Stored capped at `FAILURE_TEXT_LIMIT` (500).

- **Its own journal, not an assistant message.** On the home loop `session.messages` *is* the
  prompt: a stored "run failed: API Error 529" would come back as something the agent had said.
  Display-only, read by `history()` and never by a model.
- **Replayed as the bubble it was.** A `role: "assistant"` entry with empty `text` and an `error`,
  which is exactly the shape `abortStream` builds live, so the reopened thread renders identically.
- **Merged by timestamp, on one timeline with the commands**, under the question it never answered.
- **Aborts are not journaled.** A `/stop` is the owner's own doing, and the mirror keeps whatever
  the run produced before it, so there is a real answer under the question already.
- Deleted with the conversation, like the command journal: it is a field of the session.

## A prompt is mirrored to the owner's other windows

Everything the server produces already goes to every socket of the owner: the stream, the tool
cards, the reasoning, command answers, approvals, the model state. The prompt did not, because the
device that typed it draws that bubble itself the moment it hits send.

So a second window saw the answer and not the question. `startStream` anchors its bubble on the
turn named by `replyToId`; with no such turn it drew the answer at the end of the thread under
nothing, until a reload from disk (where the question always was) put it back in place.

`chat.user` closes it:

```json
{ "type": "chat.user", "threadId": "projet", "id": "<the sender's bubble id>", "text": "...", "attachments": [], "location": {} }
```

Three things make it cheap:

- **It carries the sender's own id**, the `chat.send` id, which is the same identity `sourceId`
  replays under. A history page merged over it later recognises the turn instead of duplicating it.
- **It is not sent back to the sender.** That window owns the bubble already, and a frame whose
  only job is to be ignored is not worth the wire. The app still drops an echo whose id it holds,
  because a reconnect can leave two sockets of one window in the list for a moment.
- **It is emitted before the run starts**, and before a command runs, so the answer that quotes it
  always lands second. Attachments travel as stored metadata, never as a local `uri`: the other
  window has no copy of the file and fetches it over the media route, exactly as a replay does.

What it does not cover: a window that connects **during** an answer still misses what already
streamed. That is the page merge below, not this frame.

### The frame has to be on the app's whitelist to exist at all

`parseServerFrame` is a whitelist (`FRAME_TYPES` in the app's `core/protocol.ts`) and it answers
`null` for anything else. `chat.user` shipped without being added to it, so every client, phone and
browser alike, threw the mirrored prompt away: the server was measurably right and nothing arrived.
Every adapter test passed (the frame does leave the socket), and so did every app test, because they
hand `routeFrame` a typed object and never cross the parser.

The guard is now an invariant test rather than a habit: the app's `protocol.test.ts` reads the
`case` labels out of `frameRouter.ts` and asserts each one gets through `parseServerFrame`. A new
server frame is therefore only ever half-shipped until the app knows the name.

## A mutation is a fact about the owner, a read is a fact about the asker

One rule decides who a frame goes to:

- **A committed change to shared state goes to every window of the owner.** The listing after a
  rename, an archive or a delete; the explorer after a file is deleted; a tag, a provider, an env
  name, an agent default, a scope, a workspace, a tool toggle, an MCP server, a skill transfer, a
  scheduled job, a prompt-layer policy, the voice engine, the model catalogue after a discovery, the
  conversation's model, effort, context and workspace. None of these is a fact about the phone that
  typed it, and a second window left on the same screen was reading a state nobody chose anymore.
- **An answer to a read goes to the asker.** `session.list`, `chat.history`, `files.list`, the
  catalogues, `/status`, `diag.snapshot`, `logs.tail`, `voice.mode.get`, the transcript. Mirroring a
  read is pure noise: nothing changed.

Two deliberate exceptions, both because the answer carries per-request bookkeeping rather than
state: `config.saved`, `instructions.saved` and `agents.file.result` stay with the sender. They hold
the new `sha` and the conflict verdict of *that* write, and handing them to a window with an open
editor would mark its unsaved draft as stored and give it a sha that defeats the very check meant to
protect it. What is shared there is the roster, so `agents.*` file writes mirror
`agents.config.result` on top of the private ack.

The device roster is rebuilt per socket instead of mirrored, because `self` is a statement about the
socket it goes to: a revoke or a pairing rebuilds the list for each of the owner's other windows.

Nothing is replayed to a window that was offline. That is deliberate (a per-device queue would be a
mailbox with an eviction policy to argue about), and the app closes the gap from its side: on
`connected` it refetches the conversation on screen, not only the catalogs (`core/resume.ts`).

## A page is merged, not substituted

`history()` reads the **live** session (`sessionManager.read` returns the cached object a run is
mutating, not the file), so the newest page already carries the run in flight: its question, its
finished bubbles, its tool cards. The app used to refuse that page while a run was active, on the
assumption that the page lagged behind the frames. Effect measured: a device that reloaded mid-run
had only the frames broadcast since it connected, so it showed an answer streaming under **no
question**, and the question appeared minutes later when the run ended and a page was finally
accepted. Switching device mid-run showed the same thing.

`seedHistory` now takes the page and keeps only what the page cannot know: the bubble still being
written, a send held behind a compaction (`chat.send.queued` flags it), and a send delivered less
than 30 s ago whose turn is not pushed yet. Cards, command answers, notices and errors are
page-owned outright.

That merge needs the two sides to agree on identity, which is what these carry:

- **The mirrored user turn keeps the `chat.send` id as its entry id** — that is the bubble id on
  the device. `history()` replays the turn under it, so the question of the run in flight is
  recognised instead of duplicated. The legacy `sourceId` field is consumed during import; it is
  not a second identity on `UserEntry`.
- **`sourceId` stays on the command journal entry** — a command produces two bubbles: the input
  replays under the send id, the answer under `cmd-<send id>`, which is the id the app gives that
  bubble live (placeholder included, so a `/compact` that was placeheld is the same bubble before
  and after).
- **Every human-driven persisted user turn carries its own id, not just the opening one.** Two
  paths used to break the chain and produced the same visible bug, a question shown twice for up to
  30 s: a steered turn (`injectUserTurn`) was pushed without the `chat.send` id, and `runner.send`
  substituted an id of its own making. Both deduped correctly *inside* the session -- the bridge
  matches the pre-push on that id -- while being invisible to the page, which is the only reader
  that matters here. A human send now gets its own id back; a model-driven send keeps a generated
  id on purpose, since its bubble lives in the parent thread and two sends in one parent turn would
  otherwise share a single id and collapse into one turn. The reuse is refused outright if the
  session already carries that id, so no caller can rewrite an older turn by repeating an id.
- **The failure rollback stops at the last steered turn.** A run that throws trims what it appended
  (`messageCountBeforeLoop`), and that mark used to be set before the loop and after a compaction
  but never after an injection. A run failing after absorbing a steering message therefore answered
  with an error *and* erased the message, which read as the send having never happened.
- **The 30 s window** is what keeps a bubble the server will never mirror (a `/status`, drawn as a
  page and journalled as nothing; a message that never left) from sitting at the end of the thread
  for good. Both sides of the subtraction are the device's own clock, so there is no skew to reason
  about.

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
