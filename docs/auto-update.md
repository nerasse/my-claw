# Auto-update

my-claw can keep itself current: a systemd timer asks the Forgejo registry every 15 minutes and,
when a newer release exists, runs the same swap `myclaw update` would. The same tick then
brings the web client bundle to the latest app release.

Two artifacts, one timer, one credential: the `FORGEJO_TOKEN` in `~/.my-claw/.env` reads both
the generic package registry (the server) and the private release assets of `claw/my-claw-app`
(the bundle).

## Pieces

- `packaging/auto-update.sh` — the decision script, run out of the tree (`/opt/my-claw/current/packaging/`).
  It compares the installed version (`/opt/my-claw/current/package.json`) against the latest `my-claw`
  generic package version, then delegates to `my-claw-update`. It never installs anything itself:
  the updater owns the lock, the staging, the atomic swap, the rollback and the post-start health
  check.
- `units/my-claw-auto-update.timer` — `OnBootSec=3min`, `OnUnitActiveSec=15min`,
  `Persistent=true`. Enabled by the installer/updater; disable with
  `systemctl --user disable --now my-claw-auto-update.timer` (as the service user).
- `units/my-claw-auto-update.service` — a `oneshot` of the service user's manager running the script; output lands in
  journald only.
- `units/` are re-rendered on every update, so the mechanism
  keeps shipping itself.

## The health gate

The swap window stops the services, so an update must never interrupt a live agent run. The gate:

1. If the registry check finds nothing new, stop.
2. If `my-claw.service` is down, proceed: an update can only help (it restarts the service).
3. Otherwise ask the running server over its app channel HTTP endpoint `GET /health`
   (device-authenticated, same credentials the phone uses): `{"activeRun": bool}`. The server
   answers from the run registry — the source of truth for in-flight runs.
   - `activeRun: true` → skip, retry in 15 minutes.
   - Endpoint unreachable (channel disabled, no paired device) → skip and retry: never interrupt
     a run the gate cannot see.

A run starting between the check and the swap stays interruptible, exactly like a manual
`myclaw update` today — the race is inherent to any updater and the updater's rollback
covers the result.

## An update already under way

Before anything else the timer asks the updater's lock (`/opt/my-claw/.update.lock`, or
`/var/lock/my-claw-update.lock` on the legacy root layout) with `flock -n`. Held: the tick says
"an update is already running" and exits 0. Without it, an update in progress has stopped the
server, the health gate reads a stopped server as a free pass, and the tick started a second
update that died on the lock and left the unit failed (2026-09-22). `tests/packaging/auto-update.test.ts`
runs the script as shipped against a throwaway install.

## The web client bundle

The bundle is released from the app repository and served off `~/.my-claw/web/current`. The
server resolves that directory *per request*, so installing a new one is a download and a
symlink flip: no service is stopped, no run is interrupted, and there is nothing for the health
gate to protect. `myclaw web use <version>` is the rollback, and it is instant for the same
reason.

The steps live in `packaging/web-bundle.sh`, sourced by both updaters rather than written twice:
the timer runs it once the server is already current, and `myclaw update` runs it after a
successful server update. Two copies of this logic is how the timer and the manual command end
up with two ideas of what "up to date" means.

1. Only when the server is already up to date. The two artifacts version independently and
   nothing checks that a given pair speaks the same protocol, so the rule is that **the bundle
   never gets ahead of the server**: a bundle sending frames the deployed server does not know
   yields buttons that die in silence, while a bundle one release behind merely lacks a feature.
   A skipped server update therefore skips the bundle too, and both land on the next tick.
2. Only when `channels["my-claw-app"].web.enabled` is true. Downloading a bundle nothing serves
   is noise.
3. The target is the highest non-draft, non-prerelease tag of `claw/my-claw-app` that actually
   carries a `dist-web.tar.gz`: an app-only release (an APK rebuild) is not a bundle release.
4. The install runs through `myclaw web install`, which drops to the service user by itself and
   reads the token from that user's own `.env`. Nothing is written as root, and no credential
   ever appears on a command line.
5. Retention is 3 versions. `myclaw web rm` does the pruning, so the bundle behind `current` can
   never be deleted.

An open tab keeps running the JavaScript it loaded until it is reloaded; nothing pushes a new
bundle into a live page. The service worker is network-first on the shell and `index.js` is
served `no-cache`, so a reload is enough and no cache has to be cleared.

### `myclaw update` moves it too

A human running the updater by hand wants the same machine the timer would produce, so the
bundle is part of that command as well. Three rules make it safe:

1. **Only for `latest`.** `myclaw update 0.4.1` pins a version, which is a downgrade or a
   repair, and pulling the newest bundle behind it would put the bundle in front of the server.
   A pinned run says so and leaves the bundle alone.
2. **After the swap and after the health check.** A server that failed to come up is rolled back,
   and a bundle installed before that would be left talking to an older server.
3. **It can never fail the update.** Past the swap point any non-zero exit rolls the server back,
   so the bundle step runs in a subshell with `set -e` off and returns 0 whatever happens. A
   registry that could not be reached is a warning, not a reason to undo a good server update.

Running it on a machine that is already current is the useful case, and it is covered: the
"nothing to install" path checks the bundle before it exits.

## On demand, from the app

Settings > General > maintenance has an "Update server" action. It does not implement anything:
it sends `update.run`, and the server asks systemd to run the same unit the timer runs.

```
app  ──update.run──►  server  ──systemctl --user start --no-block my-claw-auto-update.service
                        │
                        └──update.result──►  app        (sent first, on purpose)
                                             socket dies when the swap window stops the service
                                             app reconnects, hello carries the new version
```

Four decisions worth stating:

- **The run registry is the gate on this side.** `requestSelfUpdate()` refuses with `busy` when
  `runRegistry.hasAny()` is true. The timer asks the server over `GET /health` for the same
  answer; a request that originates *in* the server reads the registry directly. So the owner
  cannot press a button that yanks a live conversation out from under the agent, and the refusal
  is decided server side, never by the button.
- **`--no-block`, or the answer never leaves.** The unit is a oneshot whose swap window stops
  `my-claw.service`, which is the process holding the socket. A blocking `systemctl start` would
  wait for a job whose first act is to kill the caller. With `--no-block`, systemd enqueues and
  returns in milliseconds, early enough to report a refusal honestly.
- **The result frame is a decision, not an outcome.** It says whether the unit was started, plus
  the version currently running. What was actually installed is the version of the `hello` after
  reconnecting: identical version means the registry had nothing new, which the screen says
  instead of inventing progress. The unit's output goes to the journal of the user manager, not
  to the app, so there is no output to stream and none is faked.
- **No privilege.** The unit belongs to the service user's own manager (`install-layout.md`), so
  the server starts it with `systemctl --user` and nothing else. An install that has not moved to
  user units yet still has it as a root unit; there the server falls back to the one `sudo -n`
  command the legacy installer documented, and without that drop-in the frame comes back
  `reason: "denied"` with sudo's message in `detail`. Once the install has moved, sudo is never
  spawned.
