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
| `packaging/install.sh` | Install to `/opt/my-claw`, systemd services, CLI | `root` |
| `packaging/uninstall.sh` | Remove `/opt/my-claw`, services, CLI, `/etc/my-claw` | `root` |
| `packaging/update.sh` | Download latest tarball, replace `/opt/my-claw`, restart services | `root` |
| `packaging/install-remote.sh` | One-liner: download tarball from registry, run install.sh | Any (calls sudo) |
| `packaging/cleanup-versions.sh` | Keep last N versions in Package Registry | Any |
| `scripts/myclaw.sh` | CLI: `start`, `stop`, `restart`, `status`, `dev`, `update` | `root` for start/stop/restart/update |
| `scripts/dev.sh` | Stop systemd, run `bun --watch` | User |

## Install / Update / Uninstall Cycle

### Fresh install (local tarball)

```bash
cd my-claw-0.1.8-linux-x64
sudo ./packaging/install.sh --user neras
```

Auto-detects bun in target user's `~/.bun/bin` if not in root PATH.
Auto-installs missing deps (`ffmpeg`, `chromium`, `Xvfb`, `x11vnc`, `websockify`) via apt/pacman/dnf.

### Fresh install (remote one-liner)

```bash
curl -fsSL https://git.kssimi.fr/claw/my-claw/raw/main/packaging/install-remote.sh | FORGEJO_TOKEN=xxx bash
```

### Update

```bash
sudo myclaw update
# or
sudo my-claw-update [version]
```

Reads `FORGEJO_URL` and `FORGEJO_TOKEN` from `/etc/my-claw/.env`. Backs up `config.json` before overwrite.

### Development mode

```bash
myclaw dev
# or from repo:
bun run dev
```

- Stops only `my-claw.service` (the main app)
- Keeps dependencies running: `xvfb`, `chromium`, `whisper`, `vnc`, `novnc`
- Starts missing dependencies if needed
- Launches `bun run --watch src/index.ts`
- Ctrl+C prompts to restart `my-claw.service`; dependencies stay up

### Uninstall

```bash
sudo /opt/my-claw/packaging/uninstall.sh
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
└── templates/
    └── *.service         # Systemd service templates
```

## Service Templates

Templates in `packaging/templates/` use `{{USER}}`, `{{HOME}}`, `{{BUN}}`, `{{PYTHON}}`, `{{APP_DIR}}`. Replaced at install/update time by `sed`.

Services: `my-claw-xvfb`, `my-claw-chromium`, `my-claw-whisper`, `my-claw-vnc`, `my-claw-novnc`, `my-claw`.

## Release Checklist

1. Bump `version` in `package.json`
2. `git commit`, `git push`
3. `git tag -a "vX.Y.Z" -m "Release vX.Y.Z"`
4. `git push origin "vX.Y.Z"`
5. CI builds, uploads, creates release
6. Verify: `curl --user "neras:${FORGEJO_TOKEN}" "${FORGEJO_URL}/api/packages/claw/generic/my-claw/X.Y.Z/my-claw-X.Y.Z-linux-x64.tar.gz"`
