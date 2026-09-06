# CI/CD

Forgejo Actions. Debian Bookworm runner. No self-hosted runner needed.

## Variables

| Variable | Source | Default |
|---|---|---|
| `FORGEJO_URL` | `.env`, env | `https://git.kssimi.fr` |
| `FORGEJO_USER` | env | `neras` |
| `FORGEJO_TOKEN` | `.env`, env | — |
| `KEEP_VERSIONS` | env | `15` |

Token scope: `write:repository` (for Package Registry and releases).

Secrets in workflows:
- `release.yml` uses `${{ secrets.FORGEJO_TOKEN }}` for Package Registry upload and release creation.

## Workflows

### `ci.yml` — push to main / pull request

```
check: apt deps → ffmpeg 7.x (static binary) → bun → bun install → bun run check
test:  same deps → bun test
```

Jobs run sequentially (`needs: check`).

### `release.yml` — push tag `v*`

```
check → test → build-tar.sh → upload to Package Registry → create Forgejo Release → cleanup old versions
```

Idempotent: `DELETE` existing file before `PUT` (409 guard). `DELETE` existing release before `POST`.

## Package Registry

| Operation | Endpoint | Auth |
|---|---|---|
| List versions | `GET /api/v1/packages/{owner}` | Basic Auth |
| Download file | `GET /api/packages/{owner}/generic/{pkg}/{version}/{file}` | Basic Auth |
| Upload file | `PUT /api/packages/{owner}/generic/{pkg}/{version}/{file}` | Basic Auth |
| Delete file | `DELETE /api/packages/{owner}/generic/{pkg}/{version}/{file}` | Basic Auth |
| Delete version | `DELETE /api/packages/{owner}/generic/{pkg}/{version}` | Basic Auth |
| Create release | `POST /api/v1/repos/{owner}/{repo}/releases` | Basic Auth |
| Delete release | `DELETE /api/v1/repos/{owner}/{repo}/releases/{id}` | Basic Auth |

Basic Auth format: `--user "${FORGEJO_USER}:${FORGEJO_TOKEN}"`

## Scripts

| Script | Role | Runs as |
|---|---|---|
| `packaging/build-tar.sh` | Build `dist/my-claw-{VERSION}-linux-x64.tar.gz` | Any |
| `packaging/install.sh` | Install to `/opt/my-claw/releases/<v>`, hand the tree to the service user, linger, stub; then activate as that user | `root` (once) |
| `packaging/uninstall.sh` | Remove `/opt/my-claw`, user and legacy units, CLI, `/etc/my-claw*` | `root` |
| `packaging/update.sh` | Download tarball, stage `releases/<v>`, flip `current`, render user units, restart, health gate, rollback | service user |
| `packaging/install-remote.sh` | One-liner: download tarball from registry, run install.sh | Any (calls sudo) |
| `packaging/cleanup-versions.sh` | Keep last N versions in Package Registry | Any |
| `scripts/myclaw.sh` | CLI: `start`, `stop`, `restart`, `status`, `logs`, `dev`, `update`, `device`, `web`, `codex`, `claude` | service user (root is dropped to it) |
| `scripts/dev.sh` | Stop main app, keep deps, run `bun --watch` | Any (calls sudo to stop/start systemd) |

## Install / Update / Uninstall Cycle

### Fresh install (local tarball)

```bash
cd my-claw-0.1.11-linux-x64
sudo ./packaging/install.sh --user neras
```

Auto-detects bun in target user's `~/.bun/bin` if not in root PATH. Refuses `--user root`.
Auto-installs missing deps (`ffmpeg`, `chromium`, `Xvfb`, `x11vnc`, `websockify`) via apt/pacman/dnf.

### Fresh install (remote one-liner)

```bash
curl -fsSL https://git.kssimi.fr/claw/my-claw/raw/main/packaging/install-remote.sh | FORGEJO_TOKEN=xxx bash
```

### Update

```bash
myclaw update
# or
myclaw update [version] [--force] [--file <tarball>]
```

Reads `FORGEJO_URL` and `FORGEJO_TOKEN` from `~/.my-claw/.env`. Layout, ownership and migration of older installs: `install-layout.md`.

Without a version argument it also brings the web client bundle to the latest app release, the
same step the timer runs (`docs/auto-update.md`). With a pinned version it leaves the bundle
alone, because the bundle must never get ahead of the server it talks to.

### Development mode

```bash
myclaw dev          # via CLI wrapper (uses /usr/local/bin/myclaw)
bun run dev         # from repo (uses scripts/dev.sh)
```

Both do the same thing. `package.json` defines `"dev": "bash scripts/dev.sh"`.

- Stops only `my-claw.service` (the main app)
- Keeps dependencies running: `xvfb`, `chromium`, `whisper`, `vnc`, `novnc`
- Starts missing dependencies if needed
- Launches `bun run --watch src/index.ts` with correct `HOME`
- **Ctrl+C**: kills the watch process, then prompts:
  - `Restart my-claw systemd service? [Y/n]`
  - `Y` (default) → starts `my-claw.service`, deps stay up
  - `N` → leaves `my-claw.service` inactive; run `myclaw start` to relaunch

### Uninstall

```bash
sudo /opt/my-claw/current/packaging/uninstall.sh
```

Preserves `~/.my-claw/` (user data, sessions, workspace).

## Tarball Structure

```
my-claw-{VERSION}-linux-x64/
├── src/                  # TypeScript source
├── node_modules/         # Pre-installed dependencies
├── package.json
├── tsconfig.json
├── packaging/
│   ├── install.sh
│   ├── uninstall.sh
│   └── update.sh
├── scripts/
│   └── myclaw.sh         # CLI wrapper
├── etc/
│   ├── config.json       # Default config template
│   └── .env.example      # Env template
├── units/
│   └── *.service|*.timer # systemd user units, rendered into ~/.config/systemd/user/ at each update
└── templates/
    └── *.service         # Legacy system unit templates, for installs that have not migrated yet
```

## Service Templates

Units in `packaging/units/` (and the legacy `packaging/templates/`) use `{{USER}}`, `{{HOME}}`, `{{BUN}}`, `{{NODE}}`, `{{PYTHON}}`, `{{APP_DIR}}`. Replaced at install/update time by `sed`; `{{APP_DIR}}` is `/opt/my-claw/current`, so a rollback flip needs no re-render to point units at the right tree.

Services: `my-claw-xvfb`, `my-claw-chromium`, `my-claw-browser-sidecar`, `my-claw-whisper`, `my-claw-vnc`, `my-claw-novnc`, `my-claw`.

`my-claw-browser-sidecar` runs Playwright under **Node** (`node sidecar/server.mjs`, `Restart=always`, `After=my-claw-chromium`). The main app (Bun) drives it over loopback HTTP because Playwright's `connectOverCDP` hangs under Bun. See `browser.md`.

### Stale process cleanup

Some templates include `ExecStartPre` to kill stale user processes from previous sessions:

| Service | Kills stale |
|---|---|
| `my-claw-xvfb` | `Xvfb :99` (restricted to target user) |
| `my-claw-chromium` | `chromium.*9222` |
| `my-claw-whisper` | `faster-whisper-server.*8000` |

`myclaw start` also detects and kills these stale processes before launching systemd services, and stops any user-level `xvfb.service`.

## Release Checklist

1. Bump `version` in `package.json`
2. `git commit`, `git push`
3. `git tag -a "vX.Y.Z" -m "Release vX.Y.Z"`
4. `git push origin "vX.Y.Z"`
5. CI builds, uploads, creates release
6. Verify: `curl --user "neras:${FORGEJO_TOKEN}" "${FORGEJO_URL}/api/packages/claw/generic/my-claw/X.Y.Z/my-claw-X.Y.Z-linux-x64.tar.gz"`
