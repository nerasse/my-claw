# Compose install

The second install, beside bare metal (systemd user units, `docs/install-layout.md`). Decided with
the owner on 2026-10-03: both are kept, the owner's own box stays on bare metal, images are built
locally from the repo (published images are phase 2). Files: `packaging/compose/`.

## Start

```sh
git clone <repo> my-claw && cd my-claw
docker compose -f packaging/compose/compose.yml up -d --build
docker compose -f packaging/compose/compose.yml exec my-claw myclaw setup
```

The server listens on `127.0.0.1:8080` (`MYCLAW_BIND`, `MYCLAW_PORT`), noVNC on `127.0.0.1:6080`. VNC
asks for a password, made once by the browser container in the shared home (`~/.vnc/passwd`) and
shown in the app's Browser page, as on bare metal.
Data lives in the `home` volume (`/home/claw/.my-claw`: config, `.env`, sessions, workspace).

## Services

| Service | Default | What it is |
| --- | --- | --- |
| `my-claw` | on | the server: Bun, ffmpeg, git, edge-tts, xdotool |
| `browser` | on | Xvfb, Chromium (CDP on its own loopback), the sidecar, VNC, noVNC |
| `whisper` | profile | local speech-to-text, `http://whisper:8000` |
| `piper` | profile | local text-to-speech, `http://piper:5000` |
| `searxng` | profile | web search, `http://searxng:8080` |
| `ntfy` | profile | push server, instead of ntfy.sh |

Defaults are the cloud (`docs/services.md`). A profile runs an engine, the config points at it:
the server derives `whisper:8000` and `piper:5000` from `MY_CLAW_INSTALL=compose` when the mode is
local and no URL is set; search needs `webSearch.baseUrl`. Local embeddings need no service: they
run inside `my-claw`.

## Decisions

- **No Docker socket in `my-claw`.** It would be root on the host for an agent with a shell. So the
  server does not start its neighbours: on bare metal it starts its units (`docs/on-demand-services.md`),
  in compose the owner enables a profile and the server checks the URL answers.
- **Same paths in both containers.** The agent hands the sidecar paths (files to upload, where to
  save a download) and the sidecar writes screenshots to `/tmp`. `my-claw` and `browser` mount the
  same `home` volume at `/home/claw` and the same `tmp` volume at `/tmp`, as one machine would.
- **The display on the compose network.** Xvfb listens on TCP without access control so `xdotool`
  in `my-claw` reaches `browser:99` (closing a native dialog that eats VNC clicks). The sidecar
  listens on `browser:9223`. Neither is published; only the compose network reaches them.
- **Chromium runs with `--no-sandbox`**: Docker's default seccomp profile refuses the namespaces its
  sandbox needs. The container is the boundary.
- **One container for the browser stack.** Its five processes are started by one script; any of them
  exiting stops the container and compose restarts it, the restart the bare-metal units get one by one.
- **First start writes the config** from the template, pointed at the neighbours (`sidecarUrl`,
  `display`, `novncUrl`, no systemd units to report). Written into the file, so what the server talks
  to is visible where it is changed.
- **Web client:** installed at each start from the release source when `.env` has one
  (`myclaw release-key <key>`, then restart; `packaging/web-bundle.sh`, the same step as the
  bare-metal updater). `docs/release-source.md`.
- **Updates come from the host**: pull the repo, `up -d --build`. The app's update button answers
  with that command instead of starting a unit (`COMPOSE_UPDATE`, `src/core/self-update.ts`).
- **bash limits:** no systemd in the container, so no cgroup per command
  (`docs/bash-limits.md` falls back to `oom_score_adj`). `mem_limit` bounds the whole container.

## Updating, backing up

```sh
git pull && docker compose -f packaging/compose/compose.yml up -d --build
docker run --rm -v my-claw_home:/data -v "$PWD":/out debian tar czf /out/my-claw-home.tgz -C /data .
```
