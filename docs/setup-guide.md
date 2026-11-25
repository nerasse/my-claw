# my-claw: installation guide (VPS / VM / Linux machine)

This guide is written to be followed step by step, by a human **or** by an AI agent (opencode, etc.),
on a fresh Debian/Ubuntu machine. Each step gives the command, then the expected check.
If a check fails, the [Troubleshooting](#troubleshooting) section lists the known causes.

> This guide covers my-claw server `>= 0.4.71` (unified native pairing) and web client `>= 0.5.53`.
> Earlier versions have a different pairing flow (copy/paste of the token into config.json).

---

## 1. Overview

my-claw = single-tenant personal agent, served from the browser or the Android app.
A single server process (Bun) exposes everything: the chat (WebSocket), the web client (static
bundle), pairing, media, health. Around it, optional services:

| Service | Role | Required |
|---|---|---|
| `my-claw` | The server (Bun): chat, tools, memory | **Yes** |
| `my-claw-xvfb` | Virtual display :99 for the automated browser | Yes (installer) |
| `my-claw-chromium` | Chromium CDP :9222 for navigation | Yes (installer) |
| `my-claw-browser-sidecar` | Node sidecar :9223 (Playwright, driven by Bun) | If Node is installed |
| `my-claw-whisper` | Local STT (faster-whisper) :8000 | On demand: started by the server only if STT is local (`docs/on-demand-services.md`) |
| `my-claw-vnc` / `my-claw-novnc` | VNC :5900 / noVNC :6080 (see the browser) | Yes (installer) |
| `my-claw-auto-update.timer` | Automatic update every 15 min | **Yes** |

**After installation you have:** a `myclaw` CLI (start/stop/status/dev/update/device/web/codex/claude),
a server on `:8080`, a paired web client, automatic updates.

> **Other format: compose.** `docker compose -f packaging/compose/compose.yml up -d --build`
> from the repository, server and browser in containers, local engines in profiles:
> `docs/compose.md`. This guide covers the bare-metal install.

---

## 2. Hardware prerequisites

| Item | Minimum | Recommended |
|---|---|---|
| OS | Debian 12+ / Ubuntu 22.04+ (apt). Arch/DNF supported by the installer | Debian 12 |
| Architecture | x86_64 (linux-x64, the only published tarball) | x86_64 |
| RAM | 4 GiB | 8 GiB+ (local embeddings, whisper, Chromium) |
| Disk | 5 GB free | 10 GB+ (155 MB tarball, ~1.5 GB extracted, updates ×2, data) |
| User | a non-root service account | — |

**Disk:** the updater preflight requires about 5× the tarball size in `/var/tmp` and about 4× in the
parent directory of `/opt`. A 10 GB VPS passes, barely; 20 GB is comfortable.

---

## 3. System dependencies

**Nothing to install beforehand.** `install.sh` installs everything, and skips whatever is already
there:

- packages: `jq curl unzip ffmpeg xvfb x11vnc novnc websockify xdotool dbus-user-session python3
  python3-venv` (apt; pacman and dnf best-effort);
- Chromium: the distribution package, otherwise (Ubuntu, which only ships it as a snap) Chrome for
  Testing in `/opt/my-claw-chromium`, linked as `/usr/bin/chromium`;
- Node.js >= 20 (the browser sidecar): the official Node LTS under `/usr/local`, pinned and
  verified, if the machine has nothing more recent (Debian 12 ships Node 18);
- Bun (pinned) in the home of the service user;
- `edge-tts` (cloud speech synthesis) in `~/.my-claw/runtime/venv`.

Nothing local (Whisper, Piper, embeddings) is downloaded: the default is cloud
(`docs/services.md`). Tested on fresh Debian 12 and Ubuntu 24.04: `docs/install-test.md`.

> Optional: `qrencode` is no longer useful, `myclaw setup` displays the QR code itself.

---

## 4. Ports

| Port | Service | Recommended exposure |
|---|---|---|
| **8080** | my-claw (HTTP + WebSocket + web bundle) | public behind TLS, or VPN |
| 8000 | whisper STT | loopback (127.0.0.1) |
| 9222 | Chromium CDP | loopback |
| 9223 | sidecar (Node) | loopback |
| 5900 / 6080 | x11vnc / noVNC | controlled network; protected by the `~/.vnc/passwd` password (created at install, shown in the app: Browser → Connect with VNC) |
| 8888 | **SearXNG** (deployed by you, see §9) | loopback or public |

**Security:** never expose 9222/9223/5900/6080 to the Internet (CDP and VNC without auth).
For 8080: either a VPN, or a TLS reverse proxy (see §7.3).

---

## 5. The Forgejo token (needed to install and update)

The tarball and the web bundle live in a **private** repository (`git.kssimi.fr`). A token is
required:

1. Open `<forgejo-url>/user/settings/applications`, create a token with the **`write:repository`**
scope.
2. Keep it. It is used for the installation AND stored in `/etc/my-claw/.env` for the updates.

No other key is **strictly mandatory** at installation:
- LLM key (see §7.2): needed for the agent to answer;
- `GROQ_API_KEY` (cloud voice), `GEOAPIFY_API_KEY` (location): optional.

---

## 6. Installation

### 6.1 One-liner (recommended)

The repository is public, no key is needed:

```bash
curl -fsSL https://raw.githubusercontent.com/nerasse/my-claw/main/packaging/install-remote.sh | sudo bash
```

`sudo bash -s -- --version 0.7.201` pins a version, `--url` points to another release source. The
URL is written into `~/.my-claw/.env`: updates go through the same source
(`docs/release-source.md`).

### 6.2 What the installer does

Root only does the system part, once; everything else belongs to the service user and runs under
**their** systemd (`systemctl --user`). See `docs/install-layout.md`.

- Missing packages (`ffmpeg`, `chromium`, `Xvfb`, `x11vnc`, `websockify`, `jq`,
`dbus-user-session`).
- `/opt/my-claw/` (owned by the user): `releases/<version>/`, `current` → the live release,
  `.install-meta`. `/var/log/my-claw/` (owned by the user).
- `~/.my-claw/`: `config.json`, `.env` (secrets, 600), then sessions, web, workspace, app logs.
- `loginctl enable-linger <user>`: the user manager starts at boot without a session.
- `/usr/local/bin/myclaw`: a root stub that drops back to the user before executing anything from
  the tree (`sudo myclaw ...` works out of habit, without ever running a user file as root).
- Then, **as the user**: units rendered from `units/` into `~/.config/systemd/user/`, `enable`,
  start, health gate, web bundle if the token is there.
- Best-effort disabling of conflicting user services (`xvfb`, `x11vnc`, `novnc`, `chromium-cdp`).

### 6.3 Verification

```bash
myclaw status                                      # active (running), en tant que l'utilisateur
ss -tlnp | grep 8080                               # LISTEN *:8080 bun
readlink /opt/my-claw/current && grep -m1 '"version"' /opt/my-claw/current/package.json
```

---

## 7. Configuration

The server reads **`~/.my-claw/config.json`** (app config) and the secrets in
**`~/.my-claw/.env`**. Both are created by the installer from the templates, and **re-read at
runtime**: editing `.env` or `config.json` does not require a restart.

### 7.1 The `.env` file

```bash
vim ~/.my-claw/.env     # en tant que l'utilisateur de service ; chmod 600 est déjà fait
```

Minimum values to start and stay up to date:

```dotenv
# LLM : la clé du provider que vous allez utiliser (voir §7.2). Exemple :
LITELLM_API_KEY=...          # OU OPENROUTER_API_KEY / GROQ_API_KEY / COMMANDCODE_KEY / OPENCODE_GO_KEY
# Updates (écrit par l'installeur, ou par `myclaw release-key`) :
MY_CLAW_RELEASE_URL=https://github.com/nerasse/my-claw
```

Optional: `GROQ_API_KEY` (cloud STT), `GEOAPIFY_API_KEY` (location), `MY_CLAW_WEB_SEARCH_TOKEN`
(protected SearXNG).

ChatGPT and Claude subscriptions: they sign in from the app (Settings → Models → Providers → `+`),
not through `.env`. Without the app: `myclaw codex login` or `myclaw claude login`, which add the
provider if it is missing. A `CLAUDE_CODE_OAUTH_TOKEN` pasted into `.env` is still accepted: on the
next boot, a Claude provider takes it (created if there is none) and the line is removed from
`.env`.

The daemon, `myclaw` and the updater all read the same file, `~/.my-claw/.env`. An older install had
a second copy in `/etc/my-claw/.env`: its migration merged it here and left the root copy in
`/etc/my-claw.migrated/` (delete it when you are sure).

### 7.2 Choosing an LLM model, from the app (recommended) or by hand

The template starts with no provider (`llm.providers: {}`, `defaultProvider: ""`): nothing is
imposed.

**From the app (zero manual editing):** Settings → Providers → add:
- type `openai`, `baseUrl` of your provider, `apiKeyEnv` = name of the env variable
  (e.g. `LITELLM_API_KEY`), `discover: true` (the picker lists the models), optional `group`;
- put the key in `.env` (Settings → Providers → env);
- then Settings → Model → choose the default model.

**By hand** (equivalent):

```json
"llm": {
  "defaultProvider": "monprovider",
  "defaultModel": "monprovider/qwen-...",
  "providers": {
    "monprovider": {
      "type": "openai",
      "baseUrl": "https://mon-gateway/v1",
      "apiKeyEnv": "MA_CLE_ENV",
      "discover": true
    }
  },
  "models": []
}
```

> With no provider configured, the server **starts** but the first message fails with
> "Provider not found in config" (visible in the app). This is the intended behaviour:
> the LLM setup happens on screen, never imposed by a default vendor.

### 7.3 TLS reverse proxy (recommended for public exposure)

The channel config is already prepared for it (`web.enabled: true`), the proxy has to be declared:

```json
"channels": {
  "my-claw-app": {
    "enabled": true,
    "port": 8080,
    "pairing": { "enabled": true },
    "web": {
      "enabled": true,
      "trustedProxies": ["127.0.0.1", "10.0.0.0/8"]
    }
  }
}
```

`trustedProxies` = IP addresses of the reverse proxy. Without it:
- `x-forwarded-host`/`x-forwarded-proto` are ignored → the pairing claim link generated by
  `myclaw device add` points to IP:8080 instead of the public domain, and the `Secure` cookie is
  not set behind TLS.

nginx example:

```nginx
server {
  listen 443 ssl;
  server_name claw.exemple.fr;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

### 7.4 The instruction files (the agent's brain)

This is THE customization point: **who the agent is, how it communicates, what it knows about you.
Everything lives in Markdown files in the workspace.**

**On first boot**, the server creates `~/.my-claw/workspace/` and copies the templates there
(shipped in the tarball, `docs/prompt/`) if the files do not already exist:

| File | Role | Read by the engine? |
|---|---|---|
| **`CORE.md`** | Base directives: safety, non-negotiable rules | ✅ always (hardcoded fallback if missing) |
| **`SOUL.md`** | Personality, tone, communication style | ✅ |
| **`AGENTS.md`** | Development rules / workspace conventions | ✅ |
| **`USER.md`** | What the server knows about you (fill it in!) | ✅ |
| `SYSTEM.md` | System thoughts, for yourself | ❌ (not read, a simple note) |
| `MEMORY.md` | Exported view of long-term memory | ❌ read by memory, not in the prompt |

**What to do at setup** (5 minutes):

```bash
cd ~/.my-claw/workspace
# Adapter au moins USER.md (qui vous êtes, timezone, contexte) et SOUL.md (ton voulu).
# AGENTS.md : règles de codage / conventions du projet si vous développez dedans.
```

> ⚠️ **This is reversible but not automatic**: the templates are copied ONLY if the file does
> not exist. Deleting `SOUL.md` does not recreate it (the layer drops silently, the engine keeps the
> last known content). Keep a backup, or take the template back from `docs/prompt/` in the tarball.

**Hot reload**: the server re-reads the 4 files on every message (mtime cache).
No restart: edit, send a message, it is active.

**From the app**: Settings → Instructions → edit each file (the same resolution ladder is used, so
what you see is what the engine reads).

**Workspace and inheritance**:
- `config.workspace`: the working directory (default `~/.my-claw/workspace`).
- `config.workspaces`: additional named workspaces (e.g. `"dev": "/home/user/dev"`).
- `config.workspacePrompts`: per workspace, per file, where the content comes from
  (`off` = cut the layer, `inherit: "default"` = follow the default workspace,
  `"builtin"` = template). A workspace without a file inherits from default, which inherits from the
  template.

Example:

```json
"workspace": "/home/user/dev",
"workspaces": { "default": "/home/user/.my-claw/workspace" },
"workspacePrompts": {
  "default": { "SOUL.md": { "inherit": "builtin" } }
}
```

> **`MEMORY.md`** is an auto-generated file (a view of `memory.db`): do not edit it by hand
> to delete it, the entries are managed by the memory tool. It is recreated on every boot.

---

## 8. The web client (bundle)

The server does **not** carry the web client: it installs it. From the private forge (token
required):

```bash
myclaw web install latest        # ⚠️ n'existe PAS : il faut une version précise
```

```bash
myclaw web install 0.5.53       # la version voulue (le plus récent des tags my-claw-app)
myclaw web ls                    # versions installées + laquelle est current
myclaw web use <version>         # rollback instantané (symlink)
myclaw web rm <version>          # purge (jamais la version derrière current)
```

> **Which version?** `myclaw web ls`, then open the most recent release of `claw/my-claw-app` on the
> forge (or trust the auto-update: the timer installs the bundle **behind** the up-to-date server,
> which is the only `latest` path actually available).

Verification: `curl -fsS http://127.0.0.1:8080/ | head -5` must return some HTML
(a 302 → `/pair` is normal as long as no device is paired; otherwise it is the bundle).

---

## 9. SearXNG (web search), an external service to deploy

The server talks to a SearXNG instance (JSON). It is **not** provided by the package: you deploy it
(Docker recommended), then you set `webSearch.baseUrl`.

**Deployment** (adapted from `~/dev/searxng/container/docker-compose.yml`):

```bash
mkdir -p ~/searxng && cd ~/searxng
cat > docker-compose.yml <<'YAML'
name: searxng
services:
  core:
    image: docker.io/searxng/searxng:latest
    restart: always
    ports:
      - "8888:8080"            # ⚠️ PAS 8080 : conflit avec my-claw
    volumes:
      - ./settings.yml:/etc/searxng/settings.yml:ro
  valkey:
    image: docker.io/valkey/valkey:9-alpine
    command: valkey-server --save 30 1 --loglevel warning
    restart: always
YAML
docker compose up -d
```

Minimal `settings.yml` (it must allow the JSON format):

```yaml
server:
  port: 8080
  bind_address: 0.0.0.0
search:
  formats: [html, json]     # sans "json" : le tool web_search reçoit du HTML → invalid JSON
```

**Verification:**

```bash
curl -fsS "http://127.0.0.1:8888/search?q=test&format=json" | head -c 200
# → {"query":"test","results":[...]}
```

**my-claw config** (hot reload: no need to restart):

```json
"webSearch": {
  "baseUrl": "http://127.0.0.1:8888",
  "language": "fr"
}
```

- Behind a domain: `baseUrl: "https://search.exemple.fr"` + optionally
  `MY_CLAW_WEB_SEARCH_TOKEN` in `.env` (Bearer) if the instance is protected.
- The tool is **registered** only if `baseUrl` is non-empty. `baseUrl: ""` = no tool.
- Known pitfall: if SearXNG is on the same machine and you leave the compose on `8080`,
  `my-claw` does not start (EADDRINUSE). Hence the `8888` above.

---

## 10. Client pairing, the unified flow

Three ways to bring a device in, a single primitive on the server side (`docs/web-pairing.md`):

| Who | How | When |
|---|---|---|
| the server terminal | `myclaw setup` or `myclaw device add` | the very first device, or with no device at hand |
| an already paired device (app or web) | Settings › Devices › **Add a device**: QR + code | the normal case, for a relative too: no terminal |
| the new device itself | Join screen › **Ask for access**: code + 3 digits, approved elsewhere | when nothing can be scanned |

**First device: `myclaw setup`.** The installer runs it at the end and displays a code, a link and a
QR (single use, ten minutes):

```
Code    K7QW-3M2P   (single use, ten minutes)
Web     http://10.0.0.7:8080/pair#K7QW3M2P
App     server ws://10.0.0.7:8080/my-claw-app, then type the code
```

The address is the machine's (`hostname -I`). Behind a domain or a reverse proxy:
`myclaw setup --url https://claw.exemple.fr`. Code wrong or expired: run `myclaw setup` again, which
issues a new code for the same device. As soon as a device has connected, `setup` does nothing:
the following ones are added from it (Settings › Devices › Add a device), or with
`myclaw device add`. The app's get started leads there too: its "Your other devices" step opens
the invitation directly.

### 10.1 Inviting a device from the app or the web

On an already paired device: Settings › Devices › **Add a device**, a name ("Dad's phone"), then
**Create the invitation**. The card shows a QR, the code `XXXX-XXXX` and a link, single use, valid
for ten minutes. The address field is the one the **new** device will use: by default the inviting
device's, change it if the new one goes through another path (a web behind SSO inviting a phone on
the LAN: `http://10.0.0.7:8080`).

- **A phone**: install the APK (the hub's `/dl` link), open the app: the **Join a server** screen
  opens by itself. **Scan the QR**, or type the server address (`http://<ip>:8080` is enough,
  the app derives the socket) and the code, then **Join**.
- **A browser**: open the link, or open `/pair` and type the code in "or type an
  invitation code".

Nothing is created on the server side until the invitation is used; on use, the inviting device
shows "device added" and the list updates everywhere.

### 10.2 Requesting access, without an invitation

On the new phone, Join screen › **Ask for access** (the server address must be entered).
It displays a code and three digits. On an already paired device: Settings › Devices ›
**Approve a request**, scan or type the code, **check that the three digits are the same**,
name the device, **Approve**. The phone receives its identity (`app-…`) and connects.

A browser does the same from `/pair`, which displays its code and QR: the app approves from
Approve a request. The three digits, the origin and the IP are shown before approving
(anti-phishing: without them, someone else's QR would pair **their** browser to your
conversations).

### 10.3 A device the server no longer knows

Device revoked, reinstalled, or server reinstalled: the server answers 401. The app reopens the Join
screen on **every** refusal that follows a connection attempt, with "This server does not know this
device". Closed, it leaves the Settings › Server(s) page, where **Join** replaces Connect as long as
the server refuses. A new invitation is all it takes.

### 10.4 Several servers on one phone (Android)

Settings › **Servers**: this one (rename), its address and its connection, the others (Switch,
rename, forget), **Add a server** (opens the Join screen, the scanned invitation names the server).
From two servers on, the bottom of the side menu shows the current server and switches in one touch.
Each server keeps its identity, its pending messages, its completed get started steps and its
notifications (an inactive server still notifies, touching the notification switches to it).
A server reached by two paths (LAN and VPN) stays **one** server: its address is edited.
Details: `docs/servers.md` in the app repository.

### 10.5 On the command line

```bash
myclaw device add --name "Bureau" --kind web --owner ton_owner
myclaw device add --name "Phone" --kind app --owner ton_owner
```

Output: the identifier, the token (shown once) and the `Claim` link
(`http://<host>/pair#K7QW-3M2P`, ten minutes, single use) with its QR. A browser opens the link; the
app scans it, or types the address and the code.

### 10.6 Verification

```bash
myclaw device ls
# → web-a3f19c22  web  owner=...  "Bureau"  last seen ...
myclaw device rm <deviceId>       # révoquer
myclaw device disable <deviceId>  # fermer la porte sans supprimer
```

---

## 11. Voice and location (optional)

| Feature | Key / dependency | In .env |
|---|---|---|
| Cloud STT | `GROQ_API_KEY` | `GROQ_API_KEY=...` |
| Local STT | `faster-whisper` (pip) + `my-claw-whisper` service | — |
| Cloud TTS | `edge-tts` (global pip: `pip install edge-tts`) | — |
| Local TTS | `piper` binary + model | — |
| Location | `GEOAPIFY_API_KEY` (reverse geocoding) | `GEOAPIFY_API_KEY=...` |

`voice.mode` = `auto` | `cloud` | `local`, refined by `voice.stt.mode` and `voice.tts.mode`. The
template sets STT and TTS to `cloud`: nothing local runs. Switching STT to `local` (in the app or the
config) makes the server start `my-claw-whisper`, switching back to cloud stops it
(`docs/on-demand-services.md`). In `auto`: cloud if `GROQ_API_KEY` is present, otherwise local.
Without a Groq key in cloud mode, the error says what to do; it never falls back to a stopped engine.
`GEOAPIFY_API_KEY` without a non-empty `.trim()` ⇒ location sharing disabled.

---

## 12. Updates

```bash
myclaw update                   # dernier release serveur + bundle web (si "latest"), sans sudo
myclaw update 0.6.1             # épingler une version (pas de bundle)
myclaw update --file my-claw-0.6.1-linux-x64.tar.gz   # depuis un tarball local
```

Everything happens under the service user: download, verification, full staging, stop, switch of the
`current` link, unit rendering from the release, start, health gate. A failure after the switch
switches back to `prev` and restarts. Details: `docs/install-layout.md`.

**Auto-update**: systemd timer every 15 min. It checks the registry, and **never touches a running
run** (health gate: `GET /health` answers `activeRun`; if `true`, it waits).
Once the server is up to date, it installs the web bundle (rule: the bundle never runs ahead of the
server).

**Rollback**: `/opt/my-claw/prev` points to the previous release until the next `update`.
The simplest: `myclaw update <version précédente>`. Offline: `systemctl --user stop my-claw`,
point `current` back at the `prev` target (`ln -sfn`), `systemctl --user start my-claw`.
For the bundle: `myclaw web use <version>`.

---

## 13. Full post-install verification guide

```bash
# 1. Services (en tant que l'utilisateur de service)
systemctl --user is-active my-claw my-claw-xvfb my-claw-chromium   # → active active active
systemctl --user is-active my-claw-browser-sidecar                 # active si Node installé
systemctl --user list-timers my-claw-auto-update.timer --no-pager  # next run dans < 15 min

# 2. Ports
ss -tlnp | grep -E '8080|9222|9223|8000'

# 3. Santé (device authentifié)
curl -fsS -H "X-My-Claw-Device: <id>" -H "Authorization: Bearer <token>" http://127.0.0.1:8080/health   # → {"activeRun":false}

# 4. Web
curl -fsS http://127.0.0.1:8080/ | grep -q "<html" && echo "bundle OK"
curl -fsS "http://127.0.0.1:8888/search?q=test&format=json" | head -c 80

# 5. Logs (boot propre)
tail -50 /var/log/my-claw/my-claw.log                   # ou: myclaw logs
journalctl --user -u my-claw --since "5 min ago" --no-pager | tail -20
tail -f ~/.my-claw/logs/my-claw-app-$(date +%F).log
```

**Final functional test:** send a message from the app or the web. The server must
stream the answer and display the tool cards.

---

## 14. Troubleshooting

| Symptom | Probable cause | Fix |
|---|---|---|
| `my-claw.service` does not start | Port 8080 taken (misconfigured SearXNG, another service) | `ss -tlnp | grep 8080`, free it or change `channels.my-claw-app.port` (reboot-only) |
| `my-claw-whisper` crash-loop | STT local and `faster-whisper` not installed | `pip install faster-whisper`, or switch STT back to cloud (the server then stops the service) |
| Auto-update does nothing | `jq` missing, or release key missing/revoked | `apt install jq`, `myclaw release-key <clé>` |
| `systemctl --user`: "Failed to connect to bus" | Shell without a session (ssh without login, `su`) | `export XDG_RUNTIME_DIR=/run/user/$(id -u)`; `myclaw` does it by itself |
| Nothing starts after a reboot | Linger disabled | `sudo loginctl enable-linger <user>` |
| `myclaw web install` → 401/404 | Release key missing or revoked | `myclaw release-key <clé>` (the key only goes to the release source) |
| First page = "Unauthorized" | Normal: no device paired | Open the Claim URL from `myclaw device add` |
| The app shows "Join a server" on open | Device unknown to the server (401) | An invitation from a paired device (§10.1), or Ask for access (§10.2) |
| `web_search` answers "not configured" | `webSearch.baseUrl` empty | Set the SearXNG URL (§9) |
| `web_search` answers "invalid JSON" | `formats: [html]` without `json` | `search.formats: [html, json]` |
| noVNC does not connect | x11vnc squatting on 5900 | `systemctl --user restart my-claw-vnc my-claw-novnc` |
| The claim link points to IP:8080 instead of the domain | `trustedProxies` not declared | Add the proxy IP in `web.trustedProxies` |
| Message → "Provider not found" | No LLM configured | Settings → Providers (§7.2) |
| Run interrupted during update | Health gate: never upgrade during a run | Wait; the timer retries in 15 min |
| A lot of RAM/CPU only when cold | Local embeddings + Chromium | Plan for 8 GB; embeddings downloaded on first use |

---

## 15. Uninstallation

```bash
sudo /opt/my-claw/current/packaging/uninstall.sh
```

Removes `/opt/my-claw`, the units (user and, if any are left, system), the CLI, `/var/log/my-claw`,
`/etc/my-claw*`. **Does not delete** `~/.my-claw` (sessions, config, secrets) nor the user's linger:
erase them by hand if you want to start from a clean slate.
