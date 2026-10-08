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
  MY_CLAW_RELEASE_URL=https://dl.kssimi.fr       │   two read-only Forgejo tokens ──────┼─► git.kssimi.fr
  MY_CLAW_RELEASE_KEY=mcr_...                    └──────────────────────────────────────┘
```

## The registry is public until `claw` is closed

Measured 2026-10-08: `claw` is a public account, and Forgejo derives a package's visibility from
its owner, not from the private repository. Anonymously, `/api/v1/packages/claw` answers 200 and
the server tarball (with `src/`) downloads in full. Release assets of the private repositories
answer 404. Closing it means setting `claw` to private (it owns no public repository), which also
cuts the collaborators who read the registry directly: their installs need a key first.

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
- **Collaborators only.** Access follows the collaborators of `claw/my-claw` on Forgejo, checked
  with the relay's own token (`GET /repos/claw/my-claw/collaborators/<user>`: 204 yes, 404 or 422
  no). Signed in to Keycloak is not enough: someone who is not a collaborator gets a refusal page
  and cannot create a key. The check also runs on every download, so removing a collaborator in
  Forgejo cuts every key they made within 5 minutes (the answer is held that long, in memory).
  Forgejo failing the check is a 502, never an open door. The Keycloak username must be the
  Forgejo username, which holds as long as Forgejo accounts are created by the Keycloak sign-in.
  At startup the relay refuses to run if its token cannot read `claw/my-claw`: Forgejo answers the
  same 404 to "not a collaborator" and to "repository not visible", and a blind token would
  otherwise refuse everyone in silence.
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
| `FORGEJO_TOKEN` | required | `claw` token limited to `claw/my-claw` and `claw/my-claw-app`, `read:repository` |
| `FORGEJO_PACKAGE_TOKEN` | required | `claw` token with `read:package` alone |
| `RELAY_PROXY_SECRET` | required | shared with openresty, `openssl rand -hex 32` |
| `RELAY_PUBLIC_URL` | required | `https://dl.kssimi.fr`, for the commands shown and the origin check |
| `FORGEJO_URL` | `https://git.kssimi.fr` | |
| `RELAY_ADMINS` | none | comma-separated Keycloak usernames |
| `RELAY_DATA` | `/data` | where `keys.json` lives |
| `PORT` | `8090` | |

## Deploying on docker02deb

Same layout as docker01deb: the stack in `/home/neras/docker/my-claw-dist/`, the data as host bind
mounts in `/home/neras/appdata/my-claw-dist/`, no named volume.

```
/home/neras/docker/my-claw-dist/   compose.yml, .env (0600)
/home/neras/appdata/my-claw-dist/
├── relay/                         forgejo.ts keys.ts page.ts relay.ts server.ts (mounted read-only)
└── data/                          keys.json (written by the relay, uid 1000)
```

1. **Two tokens on the `claw` account** (Settings > Applications), no extra account. Forgejo will
   not put both scopes on one narrow token: "Access tokens with specified repositories can only be
   used with the read:issue, write:issue, read:repository, and write:repository scopes", and the
   package registry belongs to the owner, not to a repository.
   - `FORGEJO_TOKEN`: *specific repositories* `claw/my-claw` and `claw/my-claw-app`, scope
     `read:repository`. Releases (APK, web bundle), the installer, the collaborator list.
   - `FORGEJO_PACKAGE_TOKEN`: scope `read:package` alone. It reads packages and no repository;
     the only package `claw` owns is the server tarball.
   The relay checks both at startup and names the one that is wrong.
2. **The stack**, on docker02deb:
   ```sh
   mkdir -p /home/neras/docker/my-claw-dist
   cd /home/neras/docker/my-claw-dist
   read -rsp 'repository token: ' T; echo
   read -rsp 'package token: ' P; echo
   printf 'FORGEJO_TOKEN=%s\nFORGEJO_PACKAGE_TOKEN=%s\nRELAY_PROXY_SECRET=%s\n' "$T" "$P" "$(openssl rand -hex 32)" > .env
   chmod 600 .env
   curl -fsS -H "Authorization: token $T" \
     "https://git.kssimi.fr/api/v1/repos/claw/my-claw/raw/relay/get.sh?ref=main" -o get.sh
   sh get.sh                 # fetches relay/*.ts and compose.yml with the same token
   docker compose up -d
   docker logs my-claw-dist  # "relay listening"; a wrong token is named, and the relay exits
   ```
   The image is `oven/bun:1.3.13-alpine` as is: nothing to build. Read-only root, no capability,
   uid 1000.
3. **openresty** (docker01deb). A vhost for `dl.kssimi.fr`, outside the Keycloak default, with the
   existing Keycloak block on `/key` only. The lua must hand the username to nginx, and the secret
   is the `RELAY_PROXY_SECRET` from `.env`:
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
4. **Firewall**: port 8090 on docker02deb open to 10.10.10.50 only. The secret already makes a
   direct `/key` useless and downloads need a key; this is the second lock.
5. **Check**, from outside:
   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://dl.kssimi.fr/server/latest.json             # 401
   curl -s -o /dev/null -w '%{http_code}\n' https://dl.kssimi.fr/key                            # 302 to sso
   curl -s -o /dev/null -w '%{http_code}\n' -H "X-Relay-User: neras" https://dl.kssimi.fr/key   # 302 too
   ```
   Then sign in on `https://dl.kssimi.fr/key`, create a key, and:
   ```sh
   curl -s -H "Authorization: Bearer $KEY" https://dl.kssimi.fr/server/latest.json
   ```

Updating the relay: `cd /home/neras/docker/my-claw-dist && sh get.sh && docker compose restart`.
`sh get.sh <commit>` pins a version.

## Clients

Lot 2 (not done yet): `install-remote.sh`, `update.sh`, `auto-update.sh`, the app-update relay
(`src/channels/my-claw-app/updates.ts`), `myclaw web` and the compose entrypoint read
`MY_CLAW_RELEASE_URL` and `MY_CLAW_RELEASE_KEY` from `~/.my-claw/.env`. `myclaw release-key <key>`
writes both lines. `FORGEJO_USER:-neras` goes away.

Transition: three installs of collaborators read Forgejo directly with their own `FORGEJO_TOKEN`.
Until each has a key, an install with no `MY_CLAW_RELEASE_URL` keeps that direct path. It is a
deliberate, temporary exception to "no backward-compatibility shims", removed by the first release
after the relay log shows every install on a key.
