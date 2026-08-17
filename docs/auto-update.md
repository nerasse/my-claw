# Auto-update

my-claw can keep itself current: a systemd timer asks the Forgejo registry every 15 minutes and,
when a newer release exists, runs the same swap `sudo myclaw update` would. The same tick then
brings the web client bundle to the latest app release.

Two artifacts, one timer, one credential: the `FORGEJO_TOKEN` in `/etc/my-claw/.env` reads both
the generic package registry (the server) and the private release assets of `claw/my-claw-app`
(the bundle).

## Pieces

- `packaging/auto-update.sh` — the decision script, installed as `/usr/local/bin/my-claw-auto-update`.
  It compares the installed version (`/opt/my-claw/package.json`) against the latest `my-claw`
  generic package version, then delegates to `my-claw-update`. It never installs anything itself:
  the updater owns the lock, the staging, the atomic swap, the rollback and the post-start health
  check.
- `templates/my-claw-auto-update.timer` — `OnBootSec=3min`, `OnUnitActiveSec=15min`,
  `Persistent=true`. Enabled by the installer/updater; disable with
  `sudo systemctl disable --now my-claw-auto-update.timer`.
- `templates/my-claw-auto-update.service` — a root `oneshot` running the script; output lands in
  journald only.
- `templates/` and `/usr/local/bin` copies are re-installed on every update, so the mechanism
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
`sudo myclaw update` today — the race is inherent to any updater and the updater's rollback
covers the result.

## The web client bundle

The bundle is released from the app repository and served off `~/.my-claw/web/current`. The
server resolves that directory *per request*, so installing a new one is a download and a
symlink flip: no service is stopped, no run is interrupted, and there is nothing for the health
gate to protect. `myclaw web use <version>` is the rollback, and it is instant for the same
reason.

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
