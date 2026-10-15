# Remote nodes

Status: spec, decided 2026-10-13. Step 1 (server side) implemented; the client, its installers
and the app screens are steps 2 and 3.

A **node** is a small client installed on another machine. It gives my-claw hands there: the
tools the machine's owner chose to expose, run with the rights the node was installed with. Each
node is reached through a sub-agent of its own; the orchestrator never receives remote tools.

## Decisions

| Topic | Decision |
|---|---|
| Name | "node" everywhere (app, code, docs) |
| Transport | the node dials **out** to my-claw over WSS; nothing listens on the node machine |
| Endpoint | any reachable URL the operator gives the client. No domain is required |
| Tunnel | none needed. my-claw must be reachable, as it already is for the app; a private install uses its VPN |
| Admin install | system service under a dedicated account `myclaw-node`, with a targeted sudoers file |
| User install | user service (`systemd --user` + linger, LaunchAgent, Scheduled Task), the user's rights only |
| OS in v1 | Linux, macOS, Windows |
| Approvals | configurable per node and per tool, default none |
| Distribution | dl-hub, product path `node/` |

## Transport and identity

- Endpoint `/node` on the existing port, `Authorization: Bearer <node token>`. A node token opens
  only this endpoint: no chat, files, config or media.
- Pairing: a single-use 8-character code with a short TTL, traded by the node for its token
  (stored 0600 on the node, hashed on the server). The code is minted where the operator is
  (`myclaw node add`, later the app), claimed where the node is.
- Revoking a node closes its socket at once and invalidates its token.
- The node reconnects with backoff. While it is offline its agent is listed as offline and a spawn
  answers so, immediately.

## Deployment modes

Both are supported, and the server behaves the same in each: it is the operator's proxy that
differs, and the node client only ever takes one URL.

1. **Plain endpoint.** A `location /node` (and `POST /node/pair`) on the existing reverse proxy,
   without the SSO gate the browser routes sit behind. The node token is the only lock, with the
   claim code rate-limited. Five lines of proxy config, nothing else.
2. **mTLS endpoint.** A hostname of its own where the proxy requires a client certificate on
   `/node` (`ssl_verify_client on`, with the location for `/node/pair` exempted: the first
   contact has no certificate yet). With `nodes.mtls: true`, my-claw signs each node a client
   certificate at pairing, from a small CA it keeps under `$MY_CLAW_DIR/nodes/ca/`. The
   certificate is a second gate, checked by the proxy; the token stays the per-node, revocable
   lock. When the proxy forwards the verdict, `nodes.clientCertHeader` names the header my-claw
   itself refuses to do without.

The wildcard certificate already in place covers a dedicated hostname; nothing new to issue.

The two proxy blocks, for the operator's side. Only `/node` and `/node/pair` ever need to be
reachable: `myclaw node add` and `myclaw node rm` talk to the daemon on loopback directly.

```nginx
# Mode 1: the existing vhost, no SSO gate on these two locations.
location = /node {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;   # idle between calls; the node's keepalive is 30 s
}
location = /node/pair {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
}
```

```nginx
# Mode 2: a hostname of its own, client certificate required on /node only.
server {
    listen 443 ssl;
    server_name node-myclaw.example;
    ssl_certificate     /etc/letsencrypt/live/example/fullchain.pem;   # the wildcard
    ssl_certificate_key /etc/letsencrypt/live/example/privkey.pem;
    ssl_client_certificate /path/to/nodes/ca/ca.crt;   # my-claw's node CA (step 2)
    ssl_verify_client optional;

    location = /node {
        if ($ssl_client_verify != SUCCESS) { return 403; }
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-SSL-Client-Verify $ssl_client_verify;
        proxy_read_timeout 3600s;
    }
    location = /node/pair {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
    }
}
```

With the header set as above, `nodes.clientCertHeader: "X-SSL-Client-Verify"` makes my-claw itself
refuse a `/node` upgrade that did not come through the certificate check.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /node` (upgrade) | node token, plus the client-cert header when configured | the node's one WebSocket |
| `POST /node/pair` | the claim code alone, rate-limited | trades a code for the node token |
| `POST /node/ticket` | a paired device (like `/my-claw-app/ticket`) | mints a claim code for `myclaw node add` |
| `POST /node/revoke` | a paired device | revokes a node, closes its socket, removes its agent |

The client-certificate check applies to `/node` only; `/node/pair` must stay reachable without a
certificate, since the first contact is what obtains one.

## Config

```json
"nodes": {
  "clientCertHeader": "X-SSL-Client-Verify",
  "clientCertValue": "SUCCESS",
  "mtls": true,
  "claimTtlSeconds": 600
}
```

All four optional. Absent, the surface is token-only and claim codes live ten minutes.
`mtls` only issues certificates; the header check above is what enforces them, and both belong
to the mTLS deployment mode.

## CLI

`myclaw node add [--name <name>] [--url <base>]` prints a single-use code and the server URL;
`myclaw node ls` lists what is paired; `myclaw node rm <nodeId>` revokes. `add` and `rm` go
through the running daemon (a claim code lives in its memory, a revoke closes a socket) and
authenticate with a paired device, like `myclaw device add`.

## Journal

Every remote call is journaled in `~/.my-claw/logs/orchestrator-<date>.log`: node, tool,
arguments (truncated), duration, outcome. The connection, its hello and its disconnect are
logged too.

## Handshake

The node announces facts nobody has to type: OS, arch, hostname, user, mode (`admin`/`user`),
node version, and its tool manifest -- only the tools its config exposes.

## Two locks on the tools

1. **On the machine** (`config.json` under the node's config dir): the ceiling. Tools exposed,
   allowed roots, read-only. The server cannot widen it; the machine's owner keeps the last word.
2. **In the app**: the owner narrows further per tool, and marks tools as needing approval
   (existing approvals flow, default none). The agent file's `tools:` narrows too, exactly like a
   local baseline.

Every remote call is journaled (node, tool, arguments, outcome). Results are untrusted content.

## The agent

- One generated agent per node, `node-<name>`, with a new base `node`. Its tools are the node's
  tools, executed remotely; no local tool leaks in.
- The spawn catalog shows name, description and online state. The orchestrator delegates as it
  does to the browser agent.
- Description: auto facts from the handshake, plus guided fields in the setup wizard: purpose,
  what the machine is connected to (networks, services, data), what must never be touched, who
  owns it. The prompt is generated from these and stays editable like a file agent.

## The client

One binary per target, cross-compiled from `src/node-client` (`scripts/build-node-client.sh`,
linux x64/arm64, darwin x64/arm64, windows x64), attached to every release as
`my-claw-node-<v>-<target>`.

```
myclaw-node pair --server wss://myclaw.example/node --code ABCD1234 [--name web01] [--workdir /srv]
myclaw-node run      # what the service runs
myclaw-node status   # what this machine is paired to
```

The tools are implemented client-side (`src/node-client/tools.ts`), not imported from the server:
this runs on someone else's machine, where there is no workspace, no config store and no hooks.
The schemas and result shapes follow the server's tools. On Windows, `bash` is PowerShell.

Everything lives in one directory (`MYCLAW_NODE_DIR`, default `~/.my-claw-node`; the admin
install uses `/etc/my-claw-node`): `config.json`, `token` (0600), and the certificate bundle when
the server issued one. The config is the machine's ceiling:

```json
{
  "server": "wss://myclaw.example/node",
  "name": "web01",
  "workdir": "/srv",
  "tools": ["bash", "read", "write", "apply_patch", "search", "ls"],
  "readOnly": false,
  "roots": ["/srv", "/etc/nginx"]
}
```

`roots` fences the file tools (`bash` is the machine's own shell and stays whole); `readOnly`
drops `write` and `apply_patch`. Both are the machine owner's decision, written by hand or at
install time.

## Install

`myclaw node add` prints a single line to run on the machine:

```sh
curl -fsSL 'https://myclaw.example/node/install.sh' | sudo sh -s -- --pair ABCD1234 --server wss://myclaw.example/node
```

`sudo` for the admin install (system service, dedicated `myclaw-node` account, passwordless sudo
for that account); without it, the user install (user service, the user's own rights). macOS uses
the same script (LaunchDaemon or LaunchAgent); Windows has `install.ps1` (Scheduled Task as SYSTEM
or at logon). The installer is idempotent -- re-run the same command to update.

The binary and the installer come from the my-claw being joined (`/node/download`,
`/node/install.sh`), gated by the same claim code, and the my-claw fetches them from the release
source with its own key: the node machine needs no dl-hub key of its own. For machines that want
the direct path, dl-hub serves the same files under the `node` component of the my-claw product
(`/my-claw/node/latest.json`, `/my-claw/node/<v>/<file>`), one key per machine as usual. The
dl-hub component to declare:

```json
"node": { "repo": "claw/my-claw", "files": [
  "my-claw-node-{v}-linux-x64", "my-claw-node-{v}-linux-arm64",
  "my-claw-node-{v}-darwin-x64", "my-claw-node-{v}-darwin-arm64",
  "my-claw-node-{v}-windows-x64.exe"] }
```

## Lots

1. Protocol, pairing, `/node` endpoint, `node` base, generated agent, journal. **Done.**
2. Binary, installers (admin and user, three OS), dl-hub publication, client certificates. **Done**
   (macOS and Windows installers written, not tested here -- no such machine).
3. App: list, add (code, QR, command), description wizard, tool choice, approvals, revoke.
