# Install test

The bare-metal installer, run on fresh machines in containers. Decided with the owner on
2026-10-03: no test VM, containers instead; the compose install is tested by hand
(`docs/compose.md`), the bare-metal one by this.

```sh
packaging/build-tar.sh                         # the tarball of this tree, in dist/
tests-install/run.sh debian12                  # or ubuntu2404; --keep leaves the machine up
tests-install/upgrade.sh debian12              # an older release (dist/old/) updated to this tree
tests-install/release-source.sh debian12       # install and updates through a dl-hub, with a key
tests-install/no-token.sh debian12             # an old install with no forge token, updated by the one-line install
tests-install/compose-run.sh                   # the compose install, built from this tree
INSTALL_E2E=1 bun test tests-e2e/install       # all four, as a gated test (~10 min each)
```

Every scenario talks to the server the way the app does, through `tests-install/ws-probe.ts` (one
frame on the device's socket, the first answer back).

`tests-install/compose.yml` holds two machines, Debian 12 and Ubuntu 24.04, with systemd as PID 1
(privileged, the host's cgroups: test machines only, never a deployment), sudo, curl and one user.
Nothing of my-claw. `run.sh` installs the tarball as root and checks, as the service user:

1. `install.sh --user claw` succeeds with nothing installed beforehand;
2. server, Xvfb, Chromium, sidecar, VNC and noVNC are active; local Whisper is neither enabled nor
   running; edge-tts is installed;
3. a pairing code and link were printed, and the device they are for answers `/health`;
4. the sidecar drives Chromium;
5. switching speech-to-text to local enables Whisper, back to cloud disables it;
6. `services.get` from the app's socket: voice in the cloud with the Groq key named as missing,
   embeddings and search off, the browser up; a non-http URL refused;
7. speech-to-text set to this server from the app installs faster-whisper into its venv and starts
   Whisper, which answers; back to the cloud by hand-editing the file stops it, and Free removes it;
8. embeddings set to this server download and warm up the model in `~/.my-claw/models`, then are
   switched off and freed;
9. `myclaw update --file … --force` goes through the real updater and leaves the server up and
   Whisper off.

`no-token.sh`: an owner on 0.7.72 who never set a forge token (the old template's placeholder),
stuck there; the one-line install with a key, run over it, takes it to this tree in place and keeps
`.env` lines, config, workspace, paired device and the old release for a rollback, then the timer
reads the hub. It also caught the updater refusing every release older than `release-source.sh`.

`release-source.sh` (docs/release-source.md): a fake dl-hub (`fake-hub.py`, in a python container
beside the machine, which has no python) serves this tarball, a copy of it one version higher, and
an app release with a web bundle. The one-line install with `--key`, the key in `.env` (600, claw),
`myclaw update` bringing the web bundle, the timer installing the higher version, every request
carrying the key, a revoked key (timer retries, `myclaw update` and `myclaw release-key` refuse
and say why, nothing written), then `myclaw release-key` from stdin.

`upgrade.sh`: an owner on 0.7.72 running local speech-to-text the way the old guide said (`pip
--user faster-whisper`, voice on `auto`, the old template's placeholder Groq key), updated by their
own old updater. Their Whisper must stay enabled and answering, nothing reinstalled over the working
system package, `stt` read as self-hosted, Chromium not restarted.

`compose-run.sh`: `myclaw setup` prints the published port; the browser driven from `my-claw`, the
screenshot shared, `xdotool` on `browser:99`; search and speech-to-text set to the compose engines
from the app and answering; the app's update button answering with the host command.

`down -v` at the end, unless `--keep`. Not in CI: the runner has no Docker.

## What it found on its first runs (2026-10-03)

- Free right after switching an engine off was refused: the check read the live config, which the
  watcher had not updated yet, while the page offers Free from the file as written. It reads the
  file now (`engineInUse`).

- The version was read with `jq` before the installer installed `jq`: every fresh machine failed
  at the first line.
- Ubuntu 24.04 has no Chromium package (a snap only): `apt-get install chromium` failed, and with it
  the whole package line. Chrome for Testing is now installed in `/opt/my-claw-chromium`, root-owned,
  linked as `/usr/bin/chromium`, so the browser unit is the same everywhere.
- `apt-cache policy chromium | grep -q` read false under `pipefail` (grep exits early, apt-cache
  takes SIGPIPE): Debian got Chrome for Testing instead of its own package.
- Debian 12's Node is 18, playwright-core asks for 20: the official Node LTS is installed under
  `/usr/local` (pinned, checksum verified) when the machine has nothing newer.
- `novnc` was never installed (the unit serves `/usr/share/novnc`), nor `xdotool`.
- (2026-10-03, second pass) VNC answered with no password on every interface: the unit had `-nopw`.
  `run.sh` now does the RFB handshake and requires password-only (security type 2); `upgrade.sh`
  checks an old install gets its password on update.
- (2026-10-05) A Claude token pasted into `.env` on a fresh install found no Claude provider and was
  never offered. `run.sh` pastes one and requires the provider declared, the token in
  `accounts/claude.json`, the line gone from `.env` (`^CLAUDE_CODE_OAUTH_TOKEN=`: the template keeps
  a commented one) and the account connected. Compose VNC had `-nopw`: the browser container now
  makes a password in the shared home and `compose-run.sh` requires password-only. SearXNG's
  engines suspend a machine that searched too often, so `compose-run.sh` requires a JSON answer
  from our SearXNG and only notes an empty result list.
