# Install layout: who owns what, and why nothing runs as root

An installed my-claw belongs to its service user, from the tree to the systemd units. Root
appears once, at install, to hand things over. This page says what the layout is, what it buys,
and how an older install gets there by itself.

## The layout

```
/opt/my-claw/                       owner: the service user
├── current -> releases/0.6.0       the live tree; every unit points through this link
├── prev    -> releases/0.5.11      the rollback, kept until the next successful update
├── releases/
│   ├── 0.6.0/                      src/ node_modules/ packaging/ units/ scripts/ ...
│   └── 0.5.11/
├── .install-meta                   USER= HOME= APP_DIR=
└── .update.lock

~/.my-claw/.env                     secrets, 600, read by the server itself (loadEnv)
~/.my-claw/config.json              configuration
~/.config/systemd/user/my-claw*.service|timer    rendered from <tree>/units/ at every update
/var/log/my-claw/                   unit stdout/stderr, owned by the service user
/usr/local/bin/myclaw               root-owned stub, installed once, forwards to the tree
```

Services run under the service user's own systemd manager (`systemctl --user`), started at boot
by `loginctl enable-linger <user>`. This is the same shape as rootless podman or syncthing.

## Why

**A release can only ever change what runs as the service user.** The updater runs as that
user, writes the units into that user's `~/.config/systemd/user/`, and reloads that user's
manager. A bad release, or a compromised release pipeline, reaches the service user and nothing
else, on every machine that installs it. Before this, the updater ran as root and installed unit
files out of the tarball into `/etc/systemd/system`: whoever could publish a release could run
anything as root on every install.

**Everything the release needs is in the release.** Units live in `units/` and are rendered at
each update like the rest of the tree. Adding a service, changing a flag, changing `OOMPolicy`:
none of it needs a human or a privilege. Nine unit changes shipped in the four months before this
layout; under a root-owned `/etc/systemd/system` each of them would have needed either root in
the update path or a manual step on every machine.

**No sudo anywhere.** Not in the updater, not in `myclaw`, not in the app's "Update server"
button (the server starts the gate unit with `systemctl --user`). The one root-owned file is the
`/usr/local/bin/myclaw` stub, which drops to the tree's owner before running anything, so
`sudo myclaw update` keeps working out of habit and root never executes a user-owned file.

**Renaming inside `/opt` needs root**, which is why the container has to belong to the user and
the swap happens inside it. Flipping `current` is one `rename(2)` of a symlink: there is no moment
where `/opt/my-claw/current` is missing, which the old `mv /opt/my-claw /opt/my-claw.prev` could
not claim.

## What did not change

The failure-safety model of the updater is the one it always had, minus root: download, extract,
verify and stage the full new tree while services run; then stop, flip, render units, start,
health gate (three consecutive `is-active` samples); any failure past the flip flips back, re-renders
the previous release's units and restarts. The lock, the refusal to update while an agent run is
in flight (the timer asks `GET /health`), the web bundle that never gets ahead of the server, the
version pin that never moves the bundle: all as before, documented in `auto-update.md`.

## Secrets

The server has always loaded `~/.my-claw/.env` itself (`loadEnv`) and hot-reloaded it; the app's
env editor writes there. The `EnvironmentFile=/etc/my-claw/.env` on the old system unit was a
second, root-owned copy that systemd injected before the server started. A user manager can only
read a user-owned file, so the unit has no `EnvironmentFile=` anymore and `~/.my-claw/.env` is the
one place.

This is not a loss of protection. The agent's shell runs as the service user, the same uid as the
server, and could already read `/proc/<server pid>/environ`. The root-only file kept the keys from
`ls`, not from the process next door. Separating those two would take a second uid for the tool
shell, which is a different piece of work.

## Migration of an existing install

An install that predates this layout (root-owned `/opt/my-claw`, system units, `/etc/my-claw`)
moves by itself, once, with no step for its owner:

1. Its root updater installs the first release that ships `units/`, the old way. That release still
   carries `templates/` (the system units, unchanged) precisely so that the old updater accepts it
   and runs it.
2. The legacy system timer's next tick runs the new `auto-update.sh` as root. It passes the same
   health gate as an update (no agent run in flight), then hands to `update.sh`, whose
   `migrate_legacy_install` does, in order: preflight (`enable-linger`, wait for the user's bus,
   install `dbus-user-session` if the image lacks it, resolve runtimes); stop and disable the system
   units; move the tree to `releases/<version>` with `current` pointing at it; `chown` to the user;
   append the keys of `/etc/my-claw/.env` the user's file lacks to `~/.my-claw/.env` (a key present
   in both keeps the user's value, the app edits that file) and move `/etc/my-claw` to
   `/etc/my-claw.migrated`; remove the system unit files; install the stub; then, as the user,
   `update.sh --activate`: render, enable, start, health gate.
3. On success the old `/usr/local/bin/my-claw-update` and `my-claw-auto-update` go, and so does the
   legacy `/opt/my-claw.prev`, which could never be activated again.

If activation fails, the migration puts everything back: system units re-rendered from
`templates/`, tree `chown`ed to root, `/etc/my-claw` restored, services started on the same
release, and `/etc/my-claw/.migration-failed` written with the version. The machine is exactly
where it was. The stamp parks the migration until a newer release is installed, which the
legacy root path in `update.sh` (`install_legacy_root`) still does: an install whose migration
failed keeps receiving releases, including the one that fixes the migration.

Installs whose service user is root never migrate (a user manager for root is not the point) and
stay on the legacy path.

## What goes away later

`templates/`, `install_legacy_root` and the root branches of `auto-update.sh` exist for installs
still on the old layout. Once none is left, they go, and `fetch_payload` stops requiring
`templates/`. The `.env.example`, `setup-guide.md` and this page already describe only the current
layout.

## Operating it

```sh
myclaw status                         # systemctl --user status my-claw
myclaw update                         # latest release + web bundle; myclaw update 0.6.1 pins
myclaw update --file my-claw-0.6.1-linux-x64.tar.gz   # offline / testing
myclaw logs                           # tail -f /var/log/my-claw/my-claw.log
journalctl --user -u my-claw.service  # as the service user
systemctl --user list-timers my-claw-auto-update.timer
```

Rollback by hand, as the service user: `myclaw update <previous version>` (the tarball is fetched
again), or, offline, flip `current` to what `prev` points at and `systemctl --user restart
my-claw`.

`sudo ./packaging/uninstall.sh` removes both layouts; it keeps `~/.my-claw` and the user's linger.
