# Auto-update

my-claw can keep itself current: a systemd timer asks the Forgejo registry every 15 minutes and,
when a newer release exists, runs the same swap `sudo myclaw update` would.

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
