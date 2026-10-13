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
   contact has no certificate yet). my-claw signs each node a client certificate at pairing
   (lands with the client, step 2), from a small CA it keeps under `$MY_CLAW_DIR/nodes/ca/`. The
   certificate is a second gate, checked by the proxy; the token stays the per-node, revocable
   lock. When the proxy forwards the verdict, `nodes.clientCertHeader` names the header my-claw
   itself refuses to do without.

The wildcard certificate already in place covers a dedicated hostname; nothing new to issue.

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
  "claimTtlSeconds": 600
}
```

All three optional. Absent, the surface is token-only and claim codes live ten minutes.

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
sudo scope, node version, and its tool manifest (name, description, JSON schema, ceiling flags).

## Two locks on the tools

1. **On the machine** (`node.json`): the ceiling. Tools exposed, allowed roots, read-only. The
   server cannot widen it; the machine's owner keeps the last word.
2. **In the app**: the owner narrows further per tool, and marks tools as needing approval
   (existing approvals flow, default none).

Every remote call is journaled (node, tool, arguments, outcome). Results are untrusted content.

## The agent

- One generated agent per node, `node-<name>`, with a new base `node`. Its tools are the node's
  tools, executed remotely; no local tool leaks in.
- The spawn catalog shows name, description and online state. The orchestrator delegates as it
  does to the browser agent.
- Description: auto facts from the handshake, plus guided fields in the setup wizard: purpose,
  what the machine is connected to (networks, services, data), what must never be touched, who
  owns it. The prompt is generated from these and stays editable like a file agent.

## Client

- One binary per target, `bun build --compile` (linux x64/arm64, darwin x64/arm64, windows x64).
- v1 tools: `bash` (PowerShell on Windows), `read`, `write`, `apply_patch`, `search`, `ls`, from
  the server's implementations.
- Installer picks the mode from its own privileges; `--user` forces user mode.
- Self-update through dl-hub, like the server.

## Lots

1. Protocol, pairing, `/node` endpoint, `node` base, generated agent, journal. **Done.**
2. Binary, installers (admin and user, three OS), dl-hub publication, client certificates.
3. App: list, add (code, QR, command), description wizard, tool choice, approvals, revoke.
