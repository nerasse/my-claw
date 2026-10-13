# Remote nodes

Status: spec, decided 2026-10-13, not implemented.

A **node** is a small client installed on another machine. It gives my-claw hands there: the
tools the machine's owner chose to expose, run with the rights the node was installed with. Each
node is reached through a sub-agent of its own; the orchestrator never receives remote tools.

## Decisions

| Topic | Decision |
|---|---|
| Name | "node" everywhere (app, code, docs) |
| Transport | the node dials **out** to my-claw over WSS; nothing listens on the node machine |
| Tunnel | none. my-claw must be reachable, as it already is for the app; a private install uses its VPN |
| Admin install | system service under a dedicated account `myclaw-node`, with a targeted sudoers file |
| User install | user service (`systemd --user` + linger, LaunchAgent, Scheduled Task), the user's rights only |
| OS in v1 | Linux, macOS, Windows |
| Approvals | configurable per node and per tool, default none |
| Distribution | dl-hub, product path `node/` |

## Transport and identity

- Endpoint `/node` on the existing port, `Authorization: Bearer <node token>`. A node token opens
  only this endpoint: no chat, files, config or media.
- Pairing reuses `pairing.ts`: the app mints a single-use 8-character code with a short TTL, the
  installer trades it for the node token (stored 0600 on the node, hashed on the server).
- Revoking a node in the app closes its socket at once.
- The node reconnects with backoff. While it is offline its agent is listed as offline and a spawn
  answers so, immediately.

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

1. Protocol, pairing, `/node` endpoint, `node` base, generated agent, journal.
2. Binary, installers (admin and user, three OS), dl-hub publication.
3. App: list, add (code, QR, command), description wizard, tool choice, approvals, revoke.
