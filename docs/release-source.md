# Release source and download relay

Decided 2026-10-07. Nothing about my-claw is public: the server tarball carries `src/` and an image
carries the code, so publishing either is publishing the code. The people who run my-claw still
need to install and update it without an account on git.kssimi.fr.

```
 Install (VPS / PC)                                docker02deb (10.10.10.51)
┌──────────────────────┐  Authorization: Bearer  ┌──────────────────────────────────────┐
│ install.sh           │  ─────── HTTPS ───────► │ openresty: dl.kssimi.fr              │
│ myclaw update        │                         │   /key   behind Keycloak             │
│ auto-update          │                         │   rest   no sign-in, the key decides │
│ server -> APK, web   │                         │        │                             │
└──────────────────────┘                         │        ▼                             │
  ~/.my-claw/.env                                │ my-claw-dist (relay/, bun, no deps)  │
  MY_CLAW_RELEASE_URL=https://dl.kssimi.fr       │   read-only Forgejo token ───────────┼─► git.kssimi.fr
  MY_CLAW_RELEASE_KEY=mcr_...                    └──────────────────────────────────────┘
```

## The layout (the contract)

Every client reads one base URL and one optional key. The layout is neutral, not Forgejo's:

| Path | Content |
|---|---|
| `/server/latest.json` | `{version, file, size, sha256}` of the newest server release |
| `/server/<v>/my-claw-<v>-linux-x64.tar.gz` | the server tarball |
| `/app/latest.json` | `{version, apkSize, web, publishedAt}` of the newest app release (drafts and pre-releases skipped) |
| `/app/<v>/my-claw-app-v<v>.apk` | the APK |
| `/app/<v>/dist-web.tar.gz` | the web bundle |
| `/install.sh` | the installer, taken at the newest server tag |

`<v>` is three numbers, and must be the same in the directory and the file name. Files answer
`Range` and `HEAD` (the relay turns HEAD into a one-byte GET: the Forgejo package registry answers
405 to HEAD). A key travels as `Authorization: Bearer <key>`, never in a URL.

Moving to a public source one day means serving these files from any static host and dropping the
key: the clients change their URL and nothing else. GitHub Releases does not serve this layout as
is (`releases/download/<tag>/<file>`, no `latest.json`); it would need a small adapter, to be
decided with the publication itself.

## The relay (`relay/`)

`relay/forgejo.ts` is the only file that knows Forgejo: one table of routes, each a regex with the
version captured once and back-referenced. A path outside the table answers 404 without any call
to Forgejo, whatever the key.

- **Keys.** `mcr_` + 32 random bytes. Only the SHA-256 is stored (`/data/keys.json`, 0600), the key
  itself is shown once. A revoked key stops working on the next request. At most 20 per person.
  The relay is the only writer of the file: keys are created and revoked from the page, never by
  hand, so there are never two writers.
- **Self-service, behind Keycloak.** `/key` lists the signed-in person's keys, creates one per
  machine and revokes them. `RELAY_ADMINS` (Keycloak usernames) also see and revoke everyone's.
  The relay trusts the `X-Relay-User` header only alongside `X-Relay-Secret`, which openresty sets
  on `/key` alone; every other location clears both headers. A POST must come from the relay's own
  origin (the sign-in cookie rides along on a cross-site form).
- **Log.** One JSON line per request on stdout: method, path, status, Keycloak user and key id.
  Never the key. `/health` is not logged.
  `docker logs my-claw-dist | grep '"user":"amine"'`
- **Not done**, on purpose: cache, rate limit (a key is 256 bits), database.

| Variable | Default | |
|---|---|---|
| `FORGEJO_TOKEN` | required | the read-only token below |
| `RELAY_PROXY_SECRET` | required | shared with openresty, `openssl rand -hex 32` |
| `RELAY_PUBLIC_URL` | required | `https://dl.kssimi.fr`, for the commands shown and the origin check |
| `FORGEJO_URL` | `https://git.kssimi.fr` | |
| `RELAY_ADMINS` | none | comma-separated Keycloak usernames |
| `RELAY_DATA` | `/data` | where `keys.json` lives |
| `PORT` | `8090` | |

## Deploying on docker02deb

1. **Forgejo account.** Create a user `my-claw-dist`, add it as a *Read* collaborator on
   `claw/my-claw` and `claw/my-claw-app`. Signed in as that user, create a token with
   `read:package` and `read:repository` only. Check that it reaches the registry (collaborators
   already download the tarball with their own token, so it should):
   ```sh
   curl -s -H "Authorization: token $T" "https://git.kssimi.fr/api/v1/packages/claw?type=generic&q=my-claw" | jq -r '.[0].version'
   ```
2. **Files.** `/home/neras/docker/my-claw-dist/` with `relay/compose.yml` from the repo as
   `compose.yml`, the five `relay/*.ts` in `relay/`, an empty `data/` owned by 1000:1000, and
   `.env` (0600): `FORGEJO_TOKEN=...`, `RELAY_PROXY_SECRET=...`. Then `docker compose up -d`.
   The image is `oven/bun:1.3.13-alpine` as is: nothing to build. Read-only root, no capability.
3. **openresty.** A vhost for `dl.kssimi.fr`, outside the Keycloak default, with the existing
   Keycloak block on `/key` only. The lua must hand the username to nginx:
   ```nginx
   server {
     server_name dl.kssimi.fr;
     # listen / ssl_certificate as for the other vhosts
     client_max_body_size 4k;

     location / {
       proxy_set_header X-Relay-User "";
       proxy_set_header X-Relay-Secret "";
       proxy_buffering off;
       proxy_request_buffering off;
       proxy_read_timeout 300s;
       proxy_pass http://10.10.10.51:8090;
     }

     location /key {
       set $relay_user "";
       access_by_lua_block {
         -- the same Keycloak block as the other vhosts, then:
         -- ngx.var.relay_user = res.id_token.preferred_username
       }
       proxy_set_header X-Relay-User $relay_user;
       proxy_set_header X-Relay-Secret "<RELAY_PROXY_SECRET>";
       proxy_pass http://10.10.10.51:8090;
     }
   }
   ```
4. **Check**, from outside:
   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://dl.kssimi.fr/server/latest.json   # 401
   curl -s -o /dev/null -w '%{http_code}\n' https://dl.kssimi.fr/key                  # 302 to sso
   curl -s -H "X-Relay-User: neras" https://dl.kssimi.fr/key -o /dev/null -w '%{http_code}\n'  # 302 too
   ```
   Then sign in on `https://dl.kssimi.fr/key`, create a key, and:
   ```sh
   curl -s -H "Authorization: Bearer $KEY" https://dl.kssimi.fr/server/latest.json
   curl -sI -H "Authorization: Bearer $KEY" https://dl.kssimi.fr/app/<v>/my-claw-app-v<v>.apk
   ```
5. **Port 8090** must only be reachable from openresty (10.10.10.50). The secret already makes a
   direct `/key` useless, and downloads need a key anyway; the firewall rule is the second lock.

Updating the relay: copy the new `relay/*.ts` and `docker compose restart`.

## Clients

Lot 2 (not done yet): `install-remote.sh`, `update.sh`, `auto-update.sh`, the app-update relay
(`src/channels/my-claw-app/updates.ts`), `myclaw web` and the compose entrypoint read
`MY_CLAW_RELEASE_URL` and `MY_CLAW_RELEASE_KEY` from `~/.my-claw/.env`. `myclaw release-key <key>`
writes both lines. `FORGEJO_USER:-neras` goes away.

Transition: three installs of collaborators read Forgejo directly with their own `FORGEJO_TOKEN`.
Until each has a key, an install with no `MY_CLAW_RELEASE_URL` keeps that direct path. It is a
deliberate, temporary exception to "no backward-compatibility shims", removed by the first release
after the relay log shows every install on a key.
