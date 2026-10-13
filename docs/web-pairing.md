# Device pairing

## Why this exists

A device is a paired client (a phone, a browser) holding `deviceId` + `token`, the pair it
presents on `/my-claw-app`. Today those two values are written into `config.json` by hand. That
is acceptable for one phone whose token lives in the Android Keystore. It is not acceptable for
browsers: a browser is created and destroyed often, it cannot be trusted with a long secret typed
by hand, and it must be revocable in one action.

Two ways to pair, one primitive underneath.

| Method | Who authorises | Use case |
| --- | --- | --- |
| A. CLI | the owner, on the server, with shell access | first browser, headless, recovery when no phone is at hand |
| B. QR / code | an already paired device, over its authenticated socket | every day, no shell |

Both end in the same place: an entry in `channels.my-claw-app.devices`, written through the same
module. Devices hot-reload, so a mint is live without a restart.

## The primitive

`src/channels/my-claw-app/devices.ts` owns the whole lifecycle and is the only writer.

```
mintDevice({ name, owner, kind })   -> { deviceId, token }
listDevices()                       -> DeviceRecord[]   (id, name, owner, kind, enabled, createdAt, lastSeenAt)
revokeDevice(deviceId)              -> boolean
setDeviceEnabled(deviceId, enabled) -> boolean
```

- `deviceId` is `<kind>-<8 hex>` (`web-a3f19c22`, `app-...`). Readable in a log, not guessable
  enough to matter, and the prefix tells the owner what a line in the config is.
- `token` is 32 CSPRNG bytes, base64url. Stored in cleartext in `config.json` because the server
  compares it constant-time on connect (`deviceFor`, adapter.ts). Hashing it there would be an
  improvement, and a separate one: it changes the existing Android device too.
- The write goes through the `config-edit.ts` path: re-read the file from disk, targeted patch,
  snapshot, atomic write. Never serialise the live config object, it holds discovered models and
  injected secrets. Consequence, free: a mint shows up in `/config diff` and is undoable with
  `/config rollback`.
- The mint is **also applied to the live config object** the adapter holds. The file watcher is
  not a way to observe your own write: the event can be collapsed into the debounce of an earlier
  one. Measured, not theorised: a browser paired successfully, and its very next request was
  refused because the adapter's snapshot did not hold the device yet. The watcher's later reload
  re-applies the same values and is a no-op, so the in-memory update removes a window without
  creating a second source of truth.
- `lastSeenAt` is not written on every frame. The adapter updates it in memory and flushes at
  most once a minute, otherwise a chatty client rewrites `config.json` continuously.

## Method A: `myclaw device`

`index.ts` already dispatches `codex | claude | config` to a CLI runner before booting the
daemon. `device` joins that list with `runDeviceCli`, and `scripts/myclaw.sh` forwards it the way
it forwards `codex`.

```
myclaw device add --name "Firefox laptop" [--owner neras] [--kind web]
myclaw device ls
myclaw device rm <deviceId>
myclaw device disable <deviceId>
myclaw device enable <deviceId>
```

A ticket lives in the daemon's memory and the CLI is another process, so `add` writes the device
itself and then asks the running daemon for a claim code over `POST /my-claw-app/ticket`,
authenticated with the credential it has just minted. A caller can therefore only ever ticket the
device it just created, and a stolen token buys nothing it did not already have.

`add` mints the device and opens a **pre-approved pairing ticket** for it, then prints:

```
Device  web-a3f19c22  "Firefox laptop"  owner=neras
Claim   https://claw.kssimi.fr/#pair=K7QW-3M2P      (valid 10 min, single use)
Token   9pQ...   (shown once; the claim link is the normal path)
<QR of the claim URL, if qrencode is on PATH>
```

The claim link exists so nobody retypes a 43 character token. The token is still printed, because
a CLI that hides the secret it just created is a CLI that fails at 2am when the claim flow is
broken.

`add` refuses when the daemon is not running only for the ticket part: the device entry is written
to `config.json` either way, and the command says so. The ticket lives in the daemon's memory, not
on disk (see below).

## Method B: QR from the app

**The web displays, the phone approves.** The browser holds nothing; the phone already holds a
credential and an authenticated socket. The reverse direction (phone displays, browser scans)
requires a webcam on a desktop and is worse in every way.

```
browser                          server                           paired phone
   │                                │                                  │
   │ connect /my-claw-app/pair      │                                  │
   ├───────────────────────────────►│  create session                  │
   │ ◄──── pair.challenge ──────────┤  { code, verification, ttl }     │
   │ shows QR + K7QW-3M2P + "418"   │                                  │
   │                                │ ◄──── device.pair.lookup {code} ─┤ scan or type
   │                                ├────── device.pair.info ─────────►│ origin, ip, UA, "418"
   │ ◄──── pair.pending ────────────┤                                  │ owner compares 418
   │                                │ ◄──── device.pair.approve ───────┤
   │ ◄──── pair.granted ────────────┤  mintDevice(), session destroyed │
   │       { deviceId, token }      ├────── device.pair.result ───────►│
   │ store, close, reconnect        │                                  │
   └───────────────────────────────►│ /my-claw-app + device headers    │
```

The three digits are not decoration. Without them the live attack is reversed phishing: an
attacker shows you *their* QR, you scan it with your phone, and their browser is paired to your
owner with full access to your threads. Comparing a number the server generated and sent to both
ends independently closes it. The app screen shows origin, IP and user agent next to the digits,
and both buttons are equal in weight (no default-approve).

### Pairing socket, `/my-claw-app/pair`

The only unauthenticated surface of the channel. It speaks a tiny protocol of its own and can
never be upgraded into a chat socket.

| Direction | Frame | Payload |
| --- | --- | --- |
| client -> | `pair.hello` | `{ kind: "web" \| "native", label?, userAgent?, resume? }`, optional, first frame |
| client -> | `pair.claim` | `{ code }`, the CLI ticket path and the manual-entry path |
| -> client | `pair.challenge` | `{ code, verification, qrSvg, expiresAt, resumeToken }` |
| -> client | `pair.pending` | `{ approver }`, an approver has looked the code up |
| -> client | `pair.granted` | `{ deviceId, owner, name }` plus `grant` (web) or `token` (native) |
| -> client | `pair.denied` | `{ reason: "denied" \| "expired" \| "attempts" \| "disabled" }` |

A credential is never deliverable twice, and never to a connection that cannot prove it raised
the challenge. That proof is the `resumeToken`: 32 CSPRNG bytes handed out with the challenge,
never displayed, never in the QR, and never sent to the approving device.

### Surviving the page

Pairing a phone browser from that same phone means the page is in the background for the entire
exchange: the owner leaves it to approve in the app, and the system freezes the tab and closes
the socket underneath. Binding the session to the socket made that flow impossible. The page came
back to "disconnected, reload to try again", a reload drew a new code, and the code the owner had
just typed in the app was already dead.

So the challenge outlives its socket, up to its own TTL, and the credential does not.

```
socket closes    -> detachSession: callbacks dropped, challenge kept
approval lands   -> parked on the session, nothing minted yet
page comes back  -> pair.hello { resume: { code, token } }
                 -> the parked approval is delivered, grant minted on the way out
```

- The grant is minted when the frame is sent, never when the approval lands: it lives 30 seconds,
  and the page it belongs to may still be in the background.
- The token lives in `sessionStorage`, so it dies with the tab and no second tab can read it.
- A refused resume is not an error: the socket falls back to a fresh challenge on the spot.
- The page reconnects on its own (backoff to 15 s, immediate on `visibilitychange`, `online` and
  `pageshow`). A socket that survived a freeze on paper can be dead on the wire, so the resume
  doubles as a probe: no frame back within four seconds and the connection is replaced.
- A challenge nobody is attached to is the first thing dropped when `maxSessions` is reached,
  which is what keeps abandoned tabs from holding the door shut for the rest of their TTL.

**A browser never receives the token.** `kind: "web"` gets a `grant`, 32 CSPRNG bytes valid 30
seconds and single use, which it exchanges over HTTP:

```
POST /my-claw-app/session   { "grant": "..." }
-> 204, Set-Cookie: claw_session=...  (HttpOnly, SameSite=Strict, Secure when TLS)
```

The detour through HTTP exists because a WebSocket frame cannot set a cookie, and the cookie is
what the browser needs: the static bundle, the assets and the service worker are all fetched by
the browser itself, which will not append a query token to any of them. Session storage, cookie
attributes and the CSWSH guards are specified in `docs/my-claw-app-channel.md`.

A `grant` that expires unused leaves a device entry behind with no session attached. That is
visible in `myclaw device ls` (a device with no `lastSeenAt`) and revocable like any other.

The Devices screen in the app is the other half: it lists the paired devices with their last-seen
time, revokes one behind a confirmation, and refuses to revoke the credential it is talking on.
A code reaches it either from the QR scanner or typed by hand, is looked up first, and the three
digits are shown next to the origin, the IP and the user agent before anything is approved. What
the scanner reads is validated as a pairing code and dropped otherwise: the approval path is the
one place where a wrong value costs an account.

### Authenticated frames (any paired device)

| Direction | Frame | Payload |
| --- | --- | --- |
| client -> | `device.pair.lookup` | `{ code }` |
| -> client | `device.pair.info` | `{ code, verification, origin, ip, userAgent, expiresAt, kind }` |
| client -> | `device.pair.approve` | `{ code, name }` |
| client -> | `device.pair.deny` | `{ code }` |
| -> client | `device.pair.result` | `{ ok, deviceId? , error? }` |
| client -> | `device.list` | `{}` |
| -> client | `device.list.result` | `{ devices: DeviceRecord[] }` (no tokens, ever) |
| client -> | `device.revoke` | `{ deviceId }` |
| -> client | `device.revoke.result` | `{ ok, error? }` |
| client -> | `device.invite` | `{ name?, origin }` |
| -> client | `device.invite.result` | `{ ok, code?, expiresAt?, url?, qrSvg?, error? }` |

The new device inherits the **approver's owner**. A browser paired from your phone lands on your
threads, which is the whole point of the shared `owner` namespace. Method A takes `--owner`,
defaulting to the single existing owner and refusing to guess when there are several.

`device.list` and `device.revoke` are what make the two mint paths safe. Two ways to create and
zero to destroy is a debt that comes due the day a laptop is lost. Revoking a device closes its
live sockets immediately and drops its browser sessions, it does not wait for the next connect.

### Method C: an invitation from a paired device

`myclaw device add` was the only way to make a code a new phone could claim, and it needs a shell.
A relative with an old install, no first-run screen and nothing to scan was stuck: Connect only
ever answered `unauthorized`. Any paired device, the web included, can now invite one
(Devices, "Add a device"): `device.invite` opens a session that is approved by being made, like a
CLI ticket, and the first client to claim the code joins the inviter's owner.

- Nothing is minted until the claim, because only then is it known whether a phone (`app-…`,
  token) or a browser (`web-…`, grant) joins. An invitation nobody uses leaves the config alone.
- The claim URL is built from the `origin` the client sends, not from the socket's host: the new
  device may reach the server at another address (a browser behind a sign-in proxy invites a phone
  on the LAN), so the inviting screen lets the owner change it. Only http(s) origins without
  credentials are accepted.
- An invitation or a CLI ticket cannot be looked up or approved from another device: it is
  approved already, and a second approval would mint a device nobody asked for.
- A code taken by a claim is gone before the mint is awaited: two clients racing on one code
  cannot both get a device.

The other direction also serves phones now: the app's Join screen can ask for access
(`pair.hello { kind: "native" }` and no claim), shows the code and the three digits, and an
approved request mints an `app-…` device (it used to be minted `web-…` whatever asked).

### Codes

- `code`: 40 CSPRNG bits, Crockford base32, displayed `XXXX-XXXX`. Crockford because the owner
  reads it off a screen and types it on a phone: no I/L/O/U, case insensitive, 0/O and 1/I folded.
- `verification`: 3 digits, independent random, server-held, sent to both ends.
- QR payload: the claim URL (`https://<host>/#pair=<code>`), nothing else. A QR that carried the
  token would put the credential on anyone's camera roll.

### Session store

Module-level, in memory, never on disk. A pairing ticket that survives a restart is a credential
lying in a file for no reason, and the flow is 2 minutes long. `myclaw device add` on a stopped
daemon prints the token and says the claim link needs the service up.

Being module-level state, it is reset in `tests/setup-globals.ts`, not per test file.

## Limits and refusals

| Guard | Value |
| --- | --- |
| challenge TTL | 600 s (`pairing.ttlSeconds`) |
| CLI ticket TTL | 600 s |
| claim attempts per socket | 5, then the socket is closed |
| `/pair` connections per IP | token bucket, 10 per minute |
| concurrent pairing sessions | 20, new ones refused above that |
| pairing disabled | `pairing.enabled: false` by default, the route 404s |

Every mint, denial and revocation is logged at `info` with origin, IP and user agent. A pairing
attempt against a disabled route is logged at `warn`: on a public host, that is someone probing.

## Config

```json
{
  "channels": {
    "my-claw-app": {
      "pairing": {
        "enabled": false,
        "ttlSeconds": 600,
        "claimTtlSeconds": 600,
        "maxSessions": 20
      },
      "devices": {
        "web-a3f19c22": {
          "token": "...",
          "name": "Firefox laptop",
          "kind": "web",
          "enabled": true,
          "owner": "neras",
          "createdAt": "2026-08-15T20:00:00.000Z",
          "lastSeenAt": "2026-08-15T20:41:00.000Z"
        }
      }
    }
  }
}
```

`pairing` hot-reloads like the rest of the block. Turning it off does not disconnect paired
devices, it only closes the door.

## Files

```
src/channels/my-claw-app/
├── devices.ts     # mint / list / revoke / enable, the only writer of `devices`
├── pairing.ts     # pairing sessions, codes, TTL, rate limits, frame handlers
├── web-session.ts # browser sessions: cookie mint, lookup, revoke, persistence
├── pair-page.ts   # the public pairing shell served at /pair
├── adapter.ts     # routes /my-claw-app/pair and /my-claw-app/session, wires device.* frames
└── types.ts       # the frames above
src/index.ts       # runDeviceCli, added to the CLI dispatch
scripts/myclaw.sh  # forwards `device`
```

## Tests

- `devices.test.ts`: mint writes through the snapshot path, ids and tokens are unique, revoke is
  idempotent, an unparsable `config.json` refuses the write instead of overwriting it.
- `pairing.test.ts`: expiry, single use, attempt cap, approval carries the approver's owner, deny
  is terminal, a web client receives a grant and never a token. Resume: a challenge outlives its
  socket and the approval waits for the page, the code alone resumes nothing, the cap drops the
  oldest detached challenge first.
- `web-session.test.ts`: a grant is single use and expires in 30 s, the cookie carries no token,
  `Secure` follows the scheme, revoking a device invalidates its sessions, an unknown or expired
  cookie authenticates nothing.
- No fixed sleeps: expiry is driven by an injected clock, delivery is awaited on the frame.
- `MY_CLAW_DIR` stays the throwaway temp dir, as everywhere else.

## Open decisions

1. ~~Camera library in the app~~ **Decided: `expo-camera`.** Expo was already a dependency, the
   barcode scanner comes with it, and the alternative (`react-native-vision-camera`) is heavier
   for a feature used once per browser. It costs 8 MB of APK and one permission asked when the
   scanner opens, never at boot. A `.web.tsx` twin of the scanner keeps the camera out of the
   browser bundle entirely, and the code stays typable everywhere as the fallback.
2. ~~SSO in front of `/pair`~~ **Decided: no SSO.** The instance lives on the tailnet and the LAN,
   never on the public internet, and pairing plus the device cookie is the whole authentication
   story. Every guard in this document therefore carries its full weight: they are not backed by
   a proxy that would catch what they miss. The decision is revisited the day the host gets a
   public record, not before.
3. **Token hashing at rest**: out of scope for this document, it touches the existing Android
   device. Worth its own change.
