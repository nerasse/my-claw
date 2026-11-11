# Remote nodes

Status: implemented. Server, client, installers and the app's Nodes screen are all in service;
this file is the reference for all of them.

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
| Approvals | per node, **default: every call asks** (owner, 2026-11-11); the tools a node exposes are chosen per tool |
| Distribution | dl-hub, product path `node/` |

## Transport and identity

- Endpoint `/node` on the existing port, `Authorization: Bearer <node token>`. A node token opens
  only this endpoint: no chat, files, config or media.
- Pairing: a single-use 8-character code with a short TTL, traded by the node for its token
  (stored 0600 on the node, hashed on the server). The code is minted where the operator is
  (`myclaw node add`, later the app), claimed where the node is.
- Revoking a node closes its socket at once and invalidates its token. It also drops the standing
  grants scoped to that machine: a grant names a machine, and it is gone.
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

The two proxy blocks, for the operator's side. Four routes ever need to be reachable -- `/node`
(the socket), `/node/pair`, `/node/download` and `/node/install.sh` (how a machine joins):
`myclaw node add` and `myclaw node rm` talk to the daemon on loopback directly, so
`/node/ticket` and `/node/revoke` stay off the proxy. Each route carries its own credential
(a claim code or a node token), which is why none of them goes through the SSO gate.

```nginx
# Mode 1: the existing vhost, no SSO gate on these four locations.
location = /node {
    set $claw 127.0.0.1:8080;
    proxy_pass http://$claw;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;   # idle between calls; the node's keepalive is 30 s
}
location = /node/pair {
    set $claw 127.0.0.1:8080;
    proxy_pass http://$claw;
    proxy_set_header Host $host;
}
location = /node/download {
    set $claw 127.0.0.1:8080;
    proxy_pass http://$claw;
    proxy_set_header Host $host;
}
location = /node/install.sh {
    set $claw 127.0.0.1:8080;
    proxy_pass http://$claw;
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
    ssl_client_certificate /path/to/nodes/ca/ca.crt;   # my-claw's node CA, copied from the server
    ssl_verify_client optional;                        # /node requires it below; the rest cannot

    location = /node {
        if ($ssl_client_verify != SUCCESS) { return 403; }
        set $claw 127.0.0.1:8080;
        proxy_pass http://$claw;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-SSL-Client-Verify $ssl_client_verify;
        proxy_read_timeout 3600s;
    }
    location = /node/pair {
        set $claw 127.0.0.1:8080;
        proxy_pass http://$claw;
        proxy_set_header Host $host;
    }
    location = /node/download {
        set $claw 127.0.0.1:8080;
        proxy_pass http://$claw;
        proxy_set_header Host $host;
    }
    location = /node/install.sh {
        set $claw 127.0.0.1:8080;
        proxy_pass http://$claw;
        proxy_set_header Host $host;
    }
    location / { return 404; }
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
| `POST /node/revoke` | a paired device | revokes a node, closes its socket, removes its agent, drops its standing grants |

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

## The Nodes screen

Settings > Nodes, beside Devices: the same operations as the CLI, plus the ones only a screen
makes usable. Each row is a node -- online dot, OS and arch, mode, user, version, the tools it
announces, its agent file, when it was last seen -- and opens a page for it:

- **Add a node**: a name, then a single-use code and one install command, generated for the
  machine it will run on -- Linux/macOS or Windows, as a service (admin) or as the account
  (user) -- and copied in one tap. The command names the address the app itself reaches the
  server at, the same rule as `myclaw node add`: whoever knows the address says it.
- **Rename**: the record and its agent file move together, so `node-<name>` follows the roster.
  A name another node or another agent file already holds is refused rather than suffixed; the
  prompt below the header is never rewritten.
- **Description**: the `description:` line of the agent file, which is what the spawn catalog
  shows the orchestrator. One line by construction; the prompt below it is the owner's. The
  guided fields (what it is for, what it reaches, what must never be touched) compose that line
  from three answers, and the result stays editable before it is saved.
- **Enabled**: off means the node's agent does not run -- a spawn is refused with that reason, and
  the catalog reads `[disabled]`. The machine stays paired and connected: its version, its tools
  and its updates are all still visible, and nothing else changes.
- **What it may run**: per tool, exposed or not, and one switch to ask before running anything
  there, on from pairing. A tool left out is absent from the agent's set, never added back.
- **MCP servers**: add, edit or remove a server the machine runs (a name, and a command with its
  arguments or a URL), with how each came up -- 3 tools, failed and why. A server the machine's
  own config declares is shown, marked as not managed here.
- **Update now**: offered for a connected node behind the server's version. The client retries a
  version once per half hour; this asks it right away (`node.update { force: true }`), which is
  the way out of a download that failed mid-flight.
- **Revoke**: closes the socket at once, drops the record and removes the agent file. The client
  stays installed on that machine.

## Journal

Every remote call is journaled in `~/.my-claw/logs/orchestrator-<date>.log`: node, tool,
arguments (truncated), duration, outcome. The connection, its hello and its disconnect are
logged too.

## Handshake

The node announces facts nobody has to type: OS, arch, hostname, user, mode (`admin`/`user`),
node version, and its tool manifest -- only the tools its config exposes -- plus how each MCP
server it runs came up.

## Two locks on the tools

1. **On the machine** (`config.json` under the node's config dir): the ceiling. Tools exposed,
   allowed roots, read-only. The server cannot widen it; the machine's owner keeps the last word.
   A node announces exactly what its config allows, so a name the record holds and the machine
   does not offer is never matched.
2. **In the app**: `nodes.json` holds the node's `tools` (the exposed subset; absent means
   everything the machine offers, an empty list nothing), `approval` (`false` when the owner let
   the machine run unasked; absent, every call there asks) and `disabled` (its agent does not
   run). The agent file's `tools:` narrows the same way, exactly like a local baseline, and the
   config denylist applies on top. All three are filters: a name outside a set is dropped, never
   added.

Everything here is read again at each turn of a run, not frozen when it starts: the set is
rebuilt before every request, so a tool added or taken away applies to the next turn of a run
already in flight, and the approval flag is read at each call. Rebuilding changes the tool block of
the prompt, which invalidates the provider's cached prefix for that turn -- the owner's call: a run
never works from a stale set. A machine that goes away keeps its last set, so its calls answer
"not connected" instead of the prompt emptying under the model.

Approval rides the existing flow (`Tool.requiresApproval` on every tool of a node, `nodeAsksFirst`).
**A paired machine asks before every call**, a read or an `ls` included: pairing grants it no
rights of its own, whatever its install mode (owner, 2026-11-11). Until 0.7.165 the default was
none, and a machine ran everything its config exposed the moment it was paired. Only the owner's
switch writes `approval: false`; a record without the key, or with the `true` older versions
wrote, asks. Each call is a prompt unless the owner answers "allow for this session" (offered
for every tool but the per-invocation ones, `bash` and `memory`) or "always allow this exact
call".
The node's agent is a sub-agent, so its sheet is drawn in the parent conversation -- the run carries
the parent's thread and the runner injects the approval handler into every sub-agent bridge -- and a
push goes out when the sheet has to reach a device that is not on that thread (docs/tool-approvals.md).
A node's prompt is raised whatever `channels["my-claw-app"].approvals` says: that flag is the
opt-in for this server's own blacklisted tools, and a machine that asks by default would
otherwise be refused on every install that never turned it on. With no device of the owner
connected, the prompt is refused: an unattended run cannot use a machine that asks.

Every node tool carries its `approvalOrigin`, so the sheet and the approvals page say which machine
a prompt is about, and a standing grant ("always allow this exact call") is scoped to that machine:
the same command approved here never auto-runs on archy. The agent reads that side of the same
state with `approval(action="grants", origin="archy")` before it plans work there: which calls go
straight through, and whether every call on that machine still asks. docs/tool-approvals.md.

Every remote call is journaled (node, tool, arguments, outcome). Results are untrusted content.

## MCP servers on a node

An MCP server that lives on that machine (Godot's addon, a Blender bridge) has to run there: the
node hosts its own MCP clients, and the list is owned by the app.

- The app's list is the truth: `nodes.json` keeps it, it is handed to the machine as
  `node.config { mcp }` on every connect and on every change, and the node persists it in its own
  `config.json` before starting anything. A machine that was offline catches up at its next hello.
- The node starts each server with the transport its entry names (`stdio` with a command and
  arguments, or `http`/`sse` with a URL), and their tools join its manifest as
  `mcp__<server>__<tool>` -- the same namespace the server's own MCP uses, so an agent reads one
  shape wherever a tool comes from. A call is an ordinary `node.call`: the node dispatches it to
  the right client.
- Everything the tools section says applies unchanged: the per-tool switches, the approval, the
  agent file's `tools:`. A server that fails to start says why in the hello, and the app shows it.
- The machine is still the one that runs the code. Letting the app edit this list means the app
  can make that machine spawn a command of its choosing; a node that exposes `bash` could already
  run one, so the app is the ceiling here by design (owner's call, 2026-10-20).

## Files between a node and this server

Text only was the old rule, and it is not enough for the case nodes exist for: Blender renders a
picture the model has to see, and an asset the owner sends has to reach the machine.

- **Node to server.** A media file the node's `read` opens (or an MCP tool returns as an image
  block) is uploaded with `POST /node/upload` -- the node's own token, 32 MB ceiling -- and the
  tool result names it under `attachments`. The bytes land in `$MY_CLAW_DIR/nodes/files/<nodeId>/`,
  and only a path inside that directory is accepted from a node's frame: a machine may claim any
  path, and a claim is not a file. The model sees the image and the app draws it like any other.
- **Server to node.** A node agent also holds `send_file_to_node { path }` (the one tool this
  server adds to the machine's manifest; the agent file's `tools:` and the denylist still
  remove it). It puts the file behind a one-shot ticket and sends `node.put { path, url }`; the
  node fetches the bytes with its token, writes them inside its roots, and answers the path it
  wrote. The socket never carries the bytes.

## The agent

- One generated agent per node, `node-<name>`, with a new base `node`. Its tools are the node's
  tools, executed remotely; no local tool leaks in. Two exceptions, both running here and neither
  touching the machine: `send_file_to_node`, which moves a file of this server's over (the node
  agent has no read access here), and `skills` in its read-only form. The second is not optional --
  layer 5 of the prompt lists the skill catalog for whatever scope the agent has and tells it to
  call `skills(name)`, so withholding the tool left every node agent told to call something it did
  not hold. A skill is knowledge: nothing in it executes through the socket. Both go through the
  file's `tools:` and the config denylist, so neither can be handed to an agent that did not name
  it.
- The spawn catalog shows name, description, online state and `[disabled]`, so the orchestrator
  does not pick an agent that cannot run.
- The generated description carries the facts from the handshake and says what is missing; the
  Nodes screen writes the `description:` line (one line, the spawn catalog's words), and the
  prompt below it stays editable like any file agent.
- The `remote-nodes` skill carries both halves: how the orchestrator reaches a machine, and what
  the machine's own agent may and may not do (`roots`, `readOnly`, the call limits).

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

## Updates

The release carries the client beside the server tarball, so "aligned" has one answer: the version
the server runs. On every connect the server compares the node's hello with its own version and,
when they differ, offers the build (`node.update { version, target }`). The node fetches it through
the same relay that installed it -- `/node/download` accepts a paired node's own token, so it needs
no claim code -- proves the staged binary prints the expected version before it replaces the
running one, swaps it in and exits. systemd and launchd restart it on the new build; the Windows
Scheduled Task would not, so there the node hands the new binary its own detached process first.

Best-effort by design: a refused download or a binary that fails its check leaves the old build
serving (one attempt per version every half hour), and the protocol number in the hello is what
actually refuses an incompatible client. Re-running the installer stays the manual path, and the
app's per-node "Update now" is the immediate one: it offers the same frame with `force: true`,
which lifts the client's window for an attempt the owner asked for.

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

The product block, complete (dl-hub `/admin`, Products, my-claw). `node` is its own component
and its downloads carry a `Node (...)` label: the app's devices (Android, web) and the remote
nodes are different things and are named apart.

```json
{
  "name": "my-claw",
  "access": "claw/my-claw",
  "installer": {
    "component": "server",
    "path": "packaging/install-remote.sh"
  },
  "instructions": "New install:\ncurl -fsSL -H \"Authorization: Bearer {key}\" {url}/install.sh | sudo bash\n\nAn install that already runs:\nmyclaw release-key {key}\n\nA machine to give my-claw hands on (from a running install):\nmyclaw node add",
  "components": {
    "server": {
      "repo": "claw/my-claw",
      "files": [
        "my-claw-{v}-linux-x64.tar.gz"
      ],
      "package": {
        "owner": "claw",
        "name": "my-claw"
      }
    },
    "app": {
      "repo": "claw/my-claw-app",
      "files": [
        "my-claw-app-v{v}.apk",
        "dist-web.tar.gz"
      ]
    },
    "node": {
      "repo": "claw/my-claw",
      "files": [
        "my-claw-node-{v}-linux-x64",
        "my-claw-node-{v}-linux-arm64",
        "my-claw-node-{v}-darwin-x64",
        "my-claw-node-{v}-darwin-arm64",
        "my-claw-node-{v}-windows-x64.exe"
      ]
    }
  },
  "downloads": {
    "apk": {
      "component": "app",
      "file": "my-claw-app-v{v}.apk",
      "label": "Android"
    },
    "web": {
      "component": "app",
      "file": "dist-web.tar.gz",
      "label": "Client web"
    },
    "linux": {
      "component": "server",
      "file": "my-claw-{v}-linux-x64.tar.gz",
      "label": "Serveur (Linux)"
    },
    "node-linux-x64": {
      "component": "node",
      "file": "my-claw-node-{v}-linux-x64",
      "label": "Node (Linux x64)"
    },
    "node-linux-arm64": {
      "component": "node",
      "file": "my-claw-node-{v}-linux-arm64",
      "label": "Node (Linux arm64)"
    },
    "node-darwin-x64": {
      "component": "node",
      "file": "my-claw-node-{v}-darwin-x64",
      "label": "Node (macOS Intel)"
    },
    "node-darwin-arm64": {
      "component": "node",
      "file": "my-claw-node-{v}-darwin-arm64",
      "label": "Node (macOS Apple Silicon)"
    },
    "node-windows-x64": {
      "component": "node",
      "file": "my-claw-node-{v}-windows-x64.exe",
      "label": "Node (Windows x64)"
    }
  }
}
```

## Lots

1. Protocol, pairing, `/node` endpoint, `node` base, generated agent, journal. **Done.**
2. Binary, installers (admin and user, three OS), dl-hub publication, client certificates. **Done**
   (macOS and Windows installers written, not tested here -- no such machine).
3. App: list, add (code and the generated install command), rename, description, tool choice,
   approvals, revoke. **Done.**

What is left, and who owns it:

- **The installers on macOS and Windows.** Written, never run here: no such machine. First real
  install proves them.
- **mTLS.** The server issues the certificate and reads the proxy's verdict; no deployment uses
  it yet. The operator's proxy blocks are above.
- **A real install from the app.** The whole loop -- code from the screen, command pasted on a
  machine, node online, agent spawning -- has only been exercised with a fake app socket.
- **A real MCP on a real machine.** The node's client is proven against fixture servers here;
  Godot's and Blender's bridges have never been run from this repo.
