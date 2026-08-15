# my-claw-app Channel

## Overview

Inbound-only WSS channel for the my-claw client apps. A device initiates a WebSocket
connection to a `Bun.serve` server inside the my-claw process (the VPS can never contact
the device). The Android app is the first client; a browser client is expected to speak the
same protocol, which is why the channel is named after the app and not after a form factor.

A **device** is one paired client (a phone, a browser). An **owner** is whose conversations
it opens: devices sharing an owner share the thread list, the uploaded files and the live
replies, so a phone and a browser are two windows onto the same chat. `owner` defaults to
the device id, which keeps an unconfigured device on its own. `userId` and `chatId` are the
owner, never the device id.

## File Structure

```
src/channels/my-claw-app/
├── adapter.ts          # WSS server, device auth, media serving, frame handling
├── stream.ts           # Token streaming (chat.stream.* frames)
└── types.ts            # Wire protocol types
```

## Configuration

```json
{
  "channels": {
    "my-claw-app": {
      "enabled": true,
      "port": 8080,
      "approvals": false,
      "streaming": {
        "enabled": true,
        "minChars": 30
      },
      "devices": {
        "<deviceId>": {
          "token": "<device secret>",
          "name": "Pixel 8",
          "enabled": true,
          "owner": "neras"
        }
      }
    }
  }
}
```

- `port` is reboot-only (the socket binds at start). Devices, tokens, streaming and
  approvals hot-reload in place.
- Pairing is manual for now: the app generates a `deviceId` + `token` (token held in
  the Android Keystore), and the owner copies them into `devices`. A QR/token flow
  is planned with the chat UI.
- `approvals: true` turns on tool-approval round trips (`approval.request` /
  `approval.response`). Off by default: approval-required tools are denied.
- `owner` groups devices onto one conversation namespace. Omit it and the device stands
  alone under its own id. Changing it moves the device to another namespace: the threads and
  files of the previous owner stay where they are.
- The app connects to `ws://<host>:<port>/my-claw-app?device=<id>&token=<token>`.

## Wire Protocol

JSON frames, both directions. A frame that does not parse as JSON is treated as a
plain-text `chat.send` (the M1 console sends raw text).

### Conversations (threads)

Each owner can hold several independent conversations. Every chat frame carries a
`threadId` (safe charset `[A-Za-z0-9._-]`, max 64 chars). A `chat.send` without
`threadId` lands in the default thread. Sessions resolve to
`my-claw-app/thread/<owner>/<threadId>` (per-thread sessions, like Telegram forum
threads), so each conversation has its own context and runs in parallel.

Two thread ids do not name a conversation but a session of another kind, and are recognised
before that rule: a cron run (`cron-<jobId>-<runTs>`) and a sub-agent (`sub-<16 hex>`, a digest
because a sub-agent's name is model-written and may hold characters the charset forbids). One that
resolves to nothing falls through to a conversation id and reads as an empty session, so a stale
handle can never land on somebody else's thread. See `docs/subagent-navigation.md`.

Outgoing frames (replies, stream deltas, tool cards, approval requests) go to every
connected device of the owner. Sockets are resolved per frame, so a window that connects
mid-answer still receives the rest of the stream. An approval is asked on all of them and
the first answer wins.

### Device -> Server

```json
{ "type": "chat.send", "id": "uuid", "text": "...", "threadId": "projet", "ts": "iso", "attachments": [{ "id": "uuid", "type": "image|file" }, { "id": "uuid", "type": "audio", "audioAsVoice": true, "durationMs": 4200 }] }
{ "type": "chat.send", "id": "uuid", "text": "...", "threadId": "projet", "location": { "latitude": 48.8566, "longitude": 2.3522, "accuracyMeters": 24, "capturedAt": "iso" } }
{ "type": "chat.stop", "threadId": "projet" }
{ "type": "session.list" }
{ "type": "commands.list" }
{ "type": "files.list", "threadId": "projet" }
{ "type": "files.delete", "threadId": "projet", "id": "uuid" }
{ "type": "session.history", "threadId": "projet", "limit": 50, "before": 50 }
{ "type": "session.archive", "threadId": "projet" }
{ "type": "session.unarchive", "threadId": "projet" }
{ "type": "session.delete", "threadId": "projet" }
{ "type": "session.rename", "threadId": "projet", "title": "Infra maison" }
{ "type": "session.workspace.set", "threadId": "projet", "workspace": "default|sofa" }
{ "type": "approval.response", "id": "uuid", "accepted": true }
{ "type": "device.capabilities", "accessibility": true }
{ "type": "voice.mode.get" }
{ "type": "voice.mode.set", "mode": "cloud|local|auto" }
{ "type": "model.list" }
{ "type": "model.get", "threadId": "projet" }
{ "type": "model.set", "threadId": "projet", "model": "gpt-5.1" }
{ "type": "model.effort.set", "threadId": "projet", "level": "medium" }
{ "type": "model.context.set", "threadId": "projet", "choice": 128000 }
{ "type": "skills.list" }
{ "type": "skills.copy", "source": "built-in|custom|workspace", "name": "forgejo", "workspace": "sofa", "target": { "source": "custom|workspace", "workspace": "lab" }, "overwrite": true }
{ "type": "skills.move", "source": "custom|workspace", "name": "forgejo", "workspace": "sofa", "target": { "source": "custom|workspace", "workspace": "lab" }, "overwrite": true }
{ "type": "tools.list" }
{ "type": "workspaces.list" }
{ "type": "mcp.list" }
{ "type": "instructions.list" }
{ "type": "instructions.get", "workspace": "default|sofa", "file": "AGENTS.md", "nested": "svc/AGENTS.md", "threadId": "t9" }
{ "type": "instructions.set", "workspace": "sofa", "file": "AGENTS.md", "content": "...", "sha": "9f2b1c4d5e6a", "nested": "/home/me/dev/repo/AGENTS.md", "threadId": "t9" }
{ "type": "session.instructions.get", "threadId": "t9" }
{ "type": "instructions.layer.set", "workspace": "sofa", "file": "SOUL.md", "inherit": "lab|default|builtin|none", "off": true }
{ "type": "agents.config.get" }
 { "type": "agents.model.set", "agent": "global|orchestrator|general|research|cron", "model": "gpt-5.1", "effort": "medium" }
 { "type": "agents.model.clear", "agent": "orchestrator|general|research|cron" }
 { "type": "agents.fallback.set", "model": "gpt-5.1|claude-sonnet-5" }
 { "type": "agents.scope.set", "agent": "cron", "field": "skills|mcp", "mode": "inherit|all|list", "names": ["code-review"] }
{ "type": "agents.workspace.set", "agent": "cron", "workspace": "sofa" }
{ "type": "agents.iterations.set", "agent": "cron", "value": 12 }
{ "type": "agents.contextcap.set", "agent": "cron", "value": 200000 }
{ "type": "agents.file.get", "agent": "reviewer" }
{ "type": "agents.file.set", "agent": "reviewer", "sha": "9f2b1c4d5e6a", "description": "...", "base": "general|research", "tools": ["read"], "skillsMode": "absent|all|list", "skills": [...], "mcpMode": "absent|all|list", "mcp": [...], "model": "opus", "workspace": "sofa", "maxIterations": 10, "contextCap": 0, "instructions": ["CORE"], "prompt": "..." }
{ "type": "agents.file.create", "name": "reviewer", "description": "Reviews a diff" }
{ "type": "agents.file.delete", "agent": "reviewer" }
{ "type": "tools.toggle", "name": "cron", "disabled": true }
{ "type": "mcp.add", "name": "gitlab", "transport": "stdio|sse|http", "command": "mcp-gitlab", "args": ["--token-file", "/run/secrets/t"] }
{ "type": "mcp.remove", "name": "gitlab" }
{ "type": "mcp.enable", "name": "gitlab", "enabled": false }
{ "type": "config.get" }
{ "type": "config.set", "sha": "9f2b1c4d5e6a", "content": "{ ... }" }
{ "type": "workspaces.add", "key": "sofa", "path": "/srv/sofa" }
{ "type": "workspaces.remove", "key": "sofa" }
{ "type": "workspaces.rename", "from": "sofa", "to": "couch" }
{ "type": "workspaces.path.set", "key": "sofa", "path": "/srv/newsofa" }
{ "type": "tags.list" }
{ "type": "tags.upsert", "name": "opus", "model": "claude-opus-4-8", "effort": "xhigh", "contextCap": 50000 }
{ "type": "tags.delete", "name": "opus" }
{ "type": "ping" }
```

On every WebSocket connection the server sends the capability gate before other optional greetings:

```json
{ "type": "location.capabilities", "enabled": true, "address": true, "provider": "geoapify" }
```

The client hides the location action until this frame says `enabled: true`. A `chat.send.location`
value contains only device facts. The server ignores any client-supplied address, reverse geocodes
with its server-only `GEOAPIFY_API_KEY`, and broadcasts the enriched user value as:

```json
{ "type": "chat.location", "threadId": "projet", "replyToId": "uuid", "location": { "latitude": 48.8566, "longitude": 2.3522, "accuracyMeters": 24, "capturedAt": "iso", "address": { "formatted": "...", "level": "street", "provider": "geoapify" } } }
```

The composer previews the address without sending anything: `location.preview` asks the server to
geocode a staged fix (nothing is persisted, the same resolver and cache as chat.send serve it) and
`location.preview.result` answers with the enriched value. The owner may edit the display address:
`chat.send.location.addressOverride.formatted` carries the decision — an empty string sends
coordinates only, other text is shown as-is and flagged `edited: true` in the address. The override
is display text only; coordinates and accuracy stay exactly as captured.

Location data is persisted with the user turn and replayed in `chat.history`; it is not a media file.
Provider failure never prevents raw coordinates from being delivered. Do not log coordinates or
provider request URLs.

- `session.archive` / `session.unarchive` move a conversation between the drawer and the
  archived list by setting or clearing `archivedAt` on the session. Nothing is moved,
  snapshotted or deleted: messages, uploads, name and model override all stay put, and
  unarchiving hands the conversation back exactly as it was. Both answer with the refreshed
  `session.list.result`. Archiving a thread that was never opened is refused rather than
  creating one.
- `session.delete` hard-deletes the session file and every archive snapshot. There is no way
  to merely empty a conversation: archiving files it away reversibly and deleting destroys it,
  which leaves nothing for a third verb to do.
- `chat.stop` stops the run of the thread, whatever backend drives it (the wire version of
  `/stop`). Answered with a `chat.command.result`.
- `files.list` / `files.delete` manage the conversation's attachments.
- `session.rename` names a conversation and answers with the resulting `session.list.result`.
  A blank title hands it back to the automatic one, which is the opening words of the first
  turn -- a summary of how a thread started rather than of what it became. The name is stored
  on the session and survives an archive, since the owner named the thread and not the turns
  inside it. Renaming a thread that was never opened is refused rather than creating one.
- `session.workspace.set` sets the conversation's workspace (`default` or a `config.workspaces`
  key). Unlike rename, the session is created on the spot if it does not exist yet: the app's
  new-conversation picker chooses a workspace before the first message exists. On an existing
  conversation the switch applies from the next run onward. Answers with
  `session.workspace.set.result`, and the workspace key also rides on every entry of
  `session.list.result`.
- `model.list` answers with the model catalog and the configured default. Each model carries
  its provider key, so the app groups the catalog the same way the server counts it.
  `model.get` / `model.set` / `model.effort.set` answer with `model.result` carrying the state
  the server actually stored (setting the default model id clears the override). `model.set`
  refuses a model the server does not know.
- `instructions.list` / `instructions.get` / `instructions.set` drive the instructions page: the
  four files `buildSystemPrompt` reads (`CORE.md`, `SOUL.md`, `AGENTS.md`, `USER.md`), per
  workspace. `instructions.get` takes either a `file` or a `nested` path from the last list.
  `instructions.set` carries the `sha` the editor loaded, and an absent `sha` means "create this
  override" -- the server refuses a stale sha and an already existing file alike, because
  `AGENTS.md` is a file the agent writes too. A nested `AGENTS.md` is editable through the same
  two frames, with `nested` instead of `file`: relative to a workspace root as the scan lists it,
  or absolute when it comes from `session.instructions.result`, and then only with the `threadId`
  of the conversation that read it (see docs/session-instructions.md). Creation is refused for a
  nested file: which directories carry instructions is not a decision an editor screen presents. `nestedTruncated` names the workspaces whose nested
  scan hit the per-workspace cap, so the page says the list is incomplete rather than implying the
  directory holds nothing more; it is omitted when none were cut. See `docs/instructions-page.md`.
- `session.instructions.get` answers `session.instructions.result`: what one conversation is
  actually loaded with, layer by layer, plus the nested `AGENTS.md` its runs injected. The layers
  come from `composeSystemPrompt`, the same function the run joins into its system prompt, so the
  page cannot drift from what the model receives. Each layer carries its text, its size, where it
  was resolved from and, for the four prompt files, the `edit` target that opens the editor on it.
  See docs/session-instructions.md.
- `agents.config.get` answers with the whole agent-defaults snapshot: the global default
  model and effort, the configured providers (never a secret, only whether the env key is
  set) and one entry per agent with the model that actually runs for it (own pin or
  inherited) and its raw `skills`/`mcp`/`workspace`/`context.cap`/`maxIterations` config.
  `agents.model.set` with `agent: "global"` writes `llm.defaultModel`, with an agent key it
  writes `agents.<key>.llm`; the effort rides in the same frame — a level, or `""` to remove
  the pin — and writes `llm.effort` for the global target, `agents.<key>.llm.effort` for an
  agent. `agents.model.clear` removes an agent's model pin *and* its effort, so an unpinned
  agent never keeps the effort of a model it no longer runs. Every
  mutation answers with a fresh `agents.config.result`, never an optimistic echo, and a
  mutation that fails is refused with scope `agents`. Each agent row carries its own
  `effort` (absent when the agent pins none).
  The `agents` array is the two reserved roles followed by every file-defined agent
  (docs/file-agents.md), so a file dropped in `agents/` appears with no app release. A
  file-defined entry additionally carries `source`, `path`, `base` and, for a workspace tier,
  `layer`; a reserved role carries none of the four because it exists without a file. `skills`,
  `mcp`, `workspace`, `contextCap` and `maxIterations` show the effective value, config entry over
  file. Writes are refused for a name that is neither a role nor an existing agent, so the app
  cannot create an `agents.<typo>` section nothing reads.
  Each agent row additionally carries `unknownSkills` / `unknownMcp` (scope entries, from the
  config entry or the agent file, that match no installed skill and no declared MCP server) and
  `unknownWorkspace` (a workspace key absent from `config.workspaces`). The app renders them
  in red: an entry that exists in config but not in any live catalog is dead weight, and hiding
  it would make it unremovable.
- `agents.scope.set` writes the `agents.<key>.skills|mcp` override in the resolver's own
  vocabulary: `"inherit"` removes the key (the orchestrator's list applies, or everything),
  `"all"` is the `["*"]` wildcard, `"list"` the names picked (`[]` means "nothing", kept as a
  decision). Names are never validated against the live catalogs: the config is the truth, and
  a stale name is flagged red, not refused. `agents.workspace.set` pins or removes (null)
  `agents.<key>.workspace` and refuses a key that is not in `config.workspaces`. `agents.iterations.set`
  writes `maxIterations` (positive integer, null removes it); `agents.contextcap.set` writes
  `context.cap` (0 lifts the ceiling, null falls back on the global cap). Every mutation answers
  with a fresh `agents.config.result`.
- `agents.file.get` opens a file-defined agent as structured fields (`agents.file.result`):
  the frontmatter the loader reads (`description`, `base`, `tools`, `skills`, `mcp`, `model`,
  `workspace`, `maxIterations`, `contextCap`, `instructions`) plus the prompt body, the file's
  sha and `toolOptions` — the tool names of the agent's baseline, what the `tools:` picker may
  offer. `tools:` entries outside the baseline are reported in `unknownTools`: they are dropped
  at run time, so they are flagged instead of being silently saved into a set that never applies.
  `editable` is false for the built-in tier (repo-synced at boot); the app offers a fork, which
  is an `agents.file.create` with the same name in the custom tier. `agents.file.set` sends
  structured fields back; the server serializes the flat frontmatter itself (so a client can
  never produce a file the loader would reject), validates through the same `parseAgentFile` as
  the loader, and refuses a stale sha as a conflict. `agents.file.create` takes a name (the
  loader's own name rules) and the mandatory description; `agents.file.delete` removes a
  custom/workspace tier file and refuses the built-in tier. Writes land through the same atomic
  write + snapshot path as the other config edits, and the agent watcher reloads the registry,
  so the new agent or the edited scope applies on the next run with no restart.
- `tools.toggle` adds or removes a name in the global `tools.disabled` denylist and answers
  with the fresh `tools.list.result`. The listing carries `missing`, the denylist entries no
  tool carries anymore: the page shows them red so they can be cleaned, the same way a stale
  agent scope entry is.
- `mcp.add` declares a server under `mcp.<name>` (`stdio` needs a `command`, `sse`/`http` a
  `url`); `mcp.remove` deletes it; `mcp.enable` toggles `enabled` (absent is enabled). All
  three answer with the fresh `mcp.list.result`. The listing shows the declared wiring minus
  the secrets: `command`, `args` and `url` are shown, `env` and `headers` never leave the
  server. The config watcher's mcp applier opens/closes the connections, so the toggle applies
  live.
- `config.get` / `config.set` are the one surface without a structured editor: the raw
  config.json text with a sha round-trip. `config.set` runs the content through the same
  parser as boot before writing, so a structurally broken file never reaches disk; the watcher
  hot-reloads what survives, and the `config.saved` answer reports which sections changed and
  which ones need a reboot (channel tokens, the bind port, the workspace path).
- `workspaces.add` / `workspaces.remove` / `workspaces.rename` / `workspaces.path.set` are the
  full CRUD of `config.workspaces`. Keys follow the boot validator (no "default", no "/",
  absolute paths); `add` and `path.set` create the directory so the skills and agent tiers can
  open under it. `rename` moves the key and rewrites every `agents.<key>.workspace` pin that
  referenced the old name in the same write; a pin left pointing at a removed workspace is
  exactly what the red `unknownWorkspace` flag surfaces, and resolution now falls back to the
  default workspace instead of throwing, so a removed workspace never takes the runs that
  referenced it down. All four answer with the fresh `workspaces.list.result`, and since
  `workspaces` is hot-reloaded with the skills/agent watchers re-targeting their tiers, the
  new directory's layers follow live.
- `providers.upsert` / `providers.remove` / `providers.rename` are the CRUD of
  `config.llm.providers`, and `providers.env.set` / `providers.env.rename` /
  `providers.env.remove` / `providers.env.list` manage the `~/.my-claw/.env` side of the same
  entries -- the full surface of docs/providers-admin.md. Provider mutations answer with the
  fresh `agents.config.result`, env mutations with `providers.env.result` (names only, never
  values). `env.set` is the one frame that carries a secret value; it is never logged or
  echoed, and every provider write reloads the config and refreshes the model catalog so a new
  key discovers its models immediately.
- `jobs.list` / `jobs.save` / `jobs.delete` are the CRUD of the scheduled tasks
  (`~/.my-claw/cron/jobs.json`, the same store the `cron` tool edits). `jobs.list` answers
  with the fresh `jobs.list.result`; every mutation answers with the same fresh listing, never
  an optimistic echo, and a mutation that fails is refused with scope `jobs`. `jobs.save`
  without an `id` creates a job, with one it updates it; the `schedule` string is parsed
  server-side with the same rules as the `cron` tool (a cron expression, "every Xm/h/d", an
  ISO timestamp), and a schedule that does not parse is refused — the scheduler could not run
  it. `jobs.delete` removes a job and refuses an unknown `id`. A job made from the app always
  delivers `local` (its output is saved under `~/.my-claw/cron/output/<id>/`, nothing is sent):
  a phone has no chat of origin, so no other target is honest; the listing's `deliver` shows
  what existing jobs carry anyway.
  Each entry carries the job's editable fields (`name`, `prompt`, `schedule`, `enabled`,
  `model`, `effort`, `workspace`), its run bookkeeping (`state`, `repeat`, `completedRuns`,
  `nextRunAt`, `lastRunAt`, `lastStatus`, `lastError`, `createdAt`, `pausedReason`) and the
  per-job scope overrides in the app's editing vocabulary: `skillsMode`/`mcpMode`/`toolsMode`
  is `"inherit" | "all" | "list"` with the `skills`/`mcp`/`tools` names when a list applies.
  The overrides are slotted above `agents.cron` at run time exactly like the job's `model`
  and `effort` pins (the scheduler hands them to the session; `resolveAgent` applies them
  first), so a
  job with no scope field inherits the cron agent as before. Like the agent rows, each job
  carries `unknownModel`, `unknownWorkspace` and `unknownSkills`/`unknownMcp`/`unknownTools`
  computed against the live catalogs; the app paints them red but never refuses the save — the
  job is the truth. An unknown `workspace` is the one case with teeth: it pauses the job at its
  next run, so the page calls it out.
- A `chat.send` whose text is a known slash command (the catalog) is executed server-side
  like on the other channels and answered with `chat.command.result`; it never reaches the
  agent. Commands outside the catalog still route as normal messages. A command that has not
  answered within 400 ms first gets a `chat.command.pending` frame: `/compact` on a full
  session runs for minutes, and the chat showed nothing at all for that whole time. The
  placeholder is only ever sent when the wait is real, so a fast command never flickers one.
- A command and the bubble it produced are journaled on the conversation (`session.commands`),
  because a command never reaches the router and so leaves no trace in `messages`. Without the
  journal, `/compact`, `/stop` and their answers vanished from the thread at the first history
  reload: those bubbles only ever existed in the device's memory, and `seedHistory` replaces the
  screen with what the server has. See "The command journal" below.
- `notifications.register` hands the device's UnifiedPush subscription (`endpoint`, plus
  `pubKey`/`auth`) to the push store; an empty `endpoint` unregisters the device.
  `notifications.state` reports the device's foreground state (`foreground`, optional
  `threadId` of the active thread) so the server can skip run-completion notifications for the
  thread that is already on screen. Full design: `docs/notifications.md`.
- `jobs.runs { jobId }` lists the run sessions of one job, newest first, as
  `jobs.runs.result { jobId, runs: [{ threadId, runAt, messageCount, title }] }`. Every run
  leaves a real session on disk (the scheduler keeps them, capped at 25 per job), so each
  `threadId` (`cron-<jobId>-<runTs>`, the slash-less form of the session id `cron/<jobId>/<runTs>`)
  is openable like any conversation: `session.history` reads it, `chat.send` routes to it and
  the stream answers on it. `chat.stop`, rename and delete work the same way. An unknown
  `jobId` is refused on the jobs scope.
- `subagents.list { threadId }` lists the sub-agents reachable from that conversation, as
  `subagents.list.result { threadId, agents: [...] }`. `threadId` is the parent conversation;
  the answer is scoped by the runner, so a `private` sub-agent belonging to another conversation
  is absent rather than hidden. One-shot agents (`subagent/run-<uuid>`) are kept after their run
  and listed the same way, for their parent conversation only. Each entry carries its own
  `threadId` (`sub-<16 hex>`, a digest of the session id) which is what the app opens; `id` is the
  real session id and is what the roster shows, because `displayName` is picked by the model and is
  not unique. Refused on the `subagents` scope when the threadId is invalid or the runner is not
  wired. Deleting a conversation removes its private sub-agents with it; shared ones survive and
  stay listed everywhere.
- `chat.send` with a sub-agent handle as its `threadId` drives that sub-agent: history, streaming,
  tool cards and reasoning behave as in any conversation, and `chat.stop` reaches it. Such a send
  carries `parentThreadId`, the conversation the roster was read from, which is matched against the
  sub-agent's recorded parent to apply the visibility rule; absent, only a `global` sub-agent
  answers. A message sent while the sub-agent is already running is injected into that run at the
  next iteration boundary rather than queued; its answer streams back on the same thread, with the
  usual turn switch, unless the running turn was started by its parent (parent-driven runs are
  non-streaming, so the answer then lands in the sub-agent's history).
- `subagents.kill { threadId, parentThreadId }` deletes a sub-agent, transcript included;
  `subagents.reset { threadId, parentThreadId }` archives its transcript and starts it over with its
  identity and workspace kept. `parentThreadId` is the caller the visibility rule is applied to, as
  for a sub-agent `chat.send`. Both answer with `subagents.list.result` for the parent thread; a
  refusal is an `error` on the `subagents` scope and sends no roster.

Handing a sub-agent's answer back to its parent needs no frame of its own: it is a `chat.send` on
the parent thread whose text quotes the sub-agent, which the router injects into a running parent or
runs fresh like any other message.

### Server -> Device

```json
{ "type": "chat.message", "id": "uuid", "text": "...", "threadId": "projet", "attachments": [...], "replyToId": "uuid" }
{ "type": "chat.run.start", "threadId": "projet", "run": "a1b2c3d4" }
{ "type": "chat.run.end", "threadId": "projet", "reason": "done|aborted|error", "run": "a1b2c3d4" }
{ "type": "chat.stream.start", "id": "uuid", "threadId": "projet", "replyToId": "uuid" }
{ "type": "chat.stream.delta", "id": "uuid", "threadId": "projet", "text": "..." }
{ "type": "chat.reasoning.delta", "id": "uuid", "threadId": "projet", "text": "..." }
{ "type": "chat.reasoning.tokens", "id": "uuid", "threadId": "projet", "tokens": 1240 }
{ "type": "chat.stream.done", "id": "uuid", "threadId": "projet" }
{ "type": "chat.stream.abort", "id": "uuid", "threadId": "projet", "error": "..." }
{ "type": "chat.tool", "id": "uuid:tool:1", "threadId": "projet", "turnId": "uuid", "name": "bash", "args": {...}, "durationMs": 4, "ok": true, "output": "...", "truncated": false, "ts": "iso" }
{ "type": "chat.history", "threadId": "projet", "before": 50, "hasMore": true, "nextBefore": 100, "messages": [{ "id": "h-...", "role": "user|assistant", "text": "...", "ts": "iso", "transcript": "...", "attachments": [{ "id": "uuid", "type": "image", "filename": "photo.png", "mimeType": "image/png", "sizeBytes": 5120, "durationMs": 3100, "deleted": false }] }] }
{ "type": "session.list.result", "sessions": [{ "threadId": "...", "title": "...", "messageCount": 4, "createdAt": "...", "lastActiveAt": "...", "archived": true, "activeRun": true, "workspace": "default" }] }
{ "type": "session.workspace.set.result", "threadId": "projet", "workspace": "sofa" }
{ "type": "commands.list.result", "commands": [{ "name": "status", "description": "..." }] }
{ "type": "files.list.result", "threadId": "projet", "files": [{ "id": "uuid", "filename": "note.pdf", "type": "file", "mimeType": "application/pdf", "sizeBytes": 5120, "ts": "iso" }], "totalBytes": 5120 }
{ "type": "approval.request", "id": "uuid", "threadId": "projet", "toolName": "bash", "args": {...}, "expiresAt": 123 }
{ "type": "chat.transcript", "threadId": "projet", "replyToId": "uuid", "items": [{ "id": "uuid", "text": "ce que le serveur a entendu" }] }
{ "type": "chat.command.pending", "threadId": "projet", "replyToId": "uuid", "text": "Running /compact..." }
{ "type": "chat.command.result", "threadId": "projet", "replyToId": "uuid", "text": "output of a command the server executed", "details": "long aside, folded in the bubble" }
{ "type": "chat.send.queued", "threadId": "projet", "replyToId": "uuid", "reason": "compaction" }
{ "type": "chat.cleared", "threadId": "projet" }
{ "type": "voice.mode.result", "mode": "auto", "resolved": "cloud", "cloudAvailable": true }
{ "type": "model.list.result", "models": [{ "id": "gpt-5.1", "label": "GPT-5.1", "group": "OpenAI/Pro", "provider": "openai", "effortLevels": ["low", "medium", "high"], "context": 400000 }, { "id": "tag:opus", "label": "opus", "group": "Tags", "effort": "xhigh" }], "defaultModel": "gpt-5.1" }
{ "type": "model.result", "threadId": "projet", "model": "gpt-5.1", "defaultModel": "gpt-5.1", "effort": { "level": "medium", "levels": ["low", "medium", "high"], "supported": true }, "context": { "raw": 400000, "effective": 256000, "cap": 256000, "choice": 256000, "used": 94000 } }
{ "type": "skills.list.result", "skills": [{ "name": "voice", "description": "Voice mode plumbing", "version": "1.0.0", "source": "built-in|custom|workspace", "path": "/home/neras/.my-claw/skills/.builtin/voice/SKILL.md", "workspace": "sofa" }] }
{ "type": "tools.list.result", "tools": [{ "name": "bash", "description": "Run a command in the workspace", "source": "built-in", "disabled": false }, { "name": "my_weather", "description": "Forecast for a city", "source": "plugin", "disabled": false }, { "name": "mcp__mailcow__get_status", "description": "Mail server status", "source": "mcp", "server": "mailcow", "disabled": false }], "missing": ["cron"] }
{ "type": "workspaces.list.result", "workspaces": [{ "key": "default", "path": "/home/neras/.my-claw/workspace", "default": true }, { "key": "sofa", "path": "/home/neras/dev/SOFA", "default": false }] }
{ "type": "mcp.list.result", "servers": [{ "name": "mailcow", "transport": "stdio|sse|http", "state": "connected|disabled|failed", "toolCount": 2, "lastError": "spawn ENOENT", "lastAttemptAt": "iso", "enabled": false, "command": "mcp-mail", "args": ["--port", "2525"], "url": "http://mcp.local" }] }
{ "type": "instructions.list.result", "entries": [{ "workspace": "sofa", "file": "AGENTS.md", "origin": "own|inherited|fallback|off", "from": "default", "bytes": 1240, "sha": "9f2b1c4d5e6a", "inherit": "default|lab|builtin|none", "off": false }], "nested": [{ "workspace": "default", "path": "svc/AGENTS.md", "bytes": 400 }], "nestedTruncated": ["dev"], "files": ["CORE.md", "SOUL.md", "AGENTS.md", "USER.md"], "maxBytes": 262144, "agentLayers": [{ "agent": "reviewer", "layers": ["CORE", "USER"] }] }
{ "type": "instructions.file", "workspace": "sofa", "file": "AGENTS.md", "content": "...", "origin": "own|inherited|fallback|off|nested", "from": "default", "sha": "9f2b1c4d5e6a", "editable": true }
{ "type": "instructions.saved", "workspace": "sofa", "file": "AGENTS.md", "ok": false, "sha": "", "conflict": true, "error": "changed on the server since it was opened" }
{ "type": "agents.config.result", "defaultModel": "gpt-5.1", "defaultProvider": "openai", "defaultEffort": "high", "effortLevels": ["low", "medium", "high", "xhigh", "max", "ultra"], "providers": [{ "key": "anthropic", "type": "claude-sdk", "group": "Claude", "discover": true, "models": 14, "keyEnv": "ANTHROPIC_API_KEY", "keyPresent": true }], "agents": [{ "key": "orchestrator", "label": "Orchestrator", "description": "The agent you talk to", "model": "gpt-5.1", "provider": "openai", "pinned": false, "inheritsFrom": "global" }, { "key": "cron", "label": "Scheduled tasks", "description": "Jobs on a schedule", "model": "gpt-5.1", "pinned": false, "inheritsFrom": "orchestrator" }] }
{ "type": "agents.file.result", "name": "reviewer", "source": "custom", "path": "/home/neras/.my-claw/agents/reviewer.md", "editable": true, "sha": "9f2b1c4d5e6a", "description": "Reviews a diff", "base": "research", "tools": ["read", "search"], "skillsMode": "list", "skills": ["code-review"], "mcpMode": "absent", "prompt": "You review code.", "toolOptions": ["read", "search", "ls"], "unknownTools": [] }
{ "type": "agents.file.saved", "name": "reviewer", "ok": true, "sha": "9f2b1c4d5e6a", "conflict": false }
{ "type": "config.result", "content": "{ ... }", "sha": "9f2b1c4d5e6a", "maxBytes": 524288 }
{ "type": "config.saved", "ok": true, "sha": "9f2b1c4d5e6a", "conflict": false, "changed": ["llm"], "rebootRequired": [] }
{ "type": "notifications.info", "vapidPublicKey": "..." }
{ "type": "hello", "version": "0.1.204" }
{ "type": "tags.result", "tags": [{ "name": "Default", "model": "gpt-5.1" }, { "name": "opus", "model": "claude-opus-4-8", "effort": "xhigh", "contextCap": 50000 }] }
{ "type": "jobs.runs.result", "jobId": "abc123def456", "runs": [{ "threadId": "cron-abc123def456-1723200000000", "runAt": 1723200000000, "messageCount": 4, "title": "Morning report · 08/08 19:30" }] }
{ "type": "error", "message": "...", "scope": "chat|files|session|diag|logs|voice|model|skills|agents|mcp|tools|instructions|config|workspaces|jobs|notifications" }
```

- `skills.list.result` feeds the app's skills page. `path` is display-only (where to edit the
  file on the server); reading goes through `GET /skills?device&token&source&name`, which
  serves the raw `SKILL.md` (`text/markdown`) with the same device auth as `/media`.
  `workspace` is present only on skills of a named workspace. The catalog is the *unresolved*
  one (every tier, every workspace), so each entry says which copy wins: `overriddenIn` lists
  the workspaces masking a global entry, `overrides` names the global tier a workspace skill
  masks. See docs/skills.md.
- `skills.copy` / `skills.move` transfer one skill **directory** (SKILL.md plus its references
  and scripts) between tiers, and are answered with a fresh `skills.list.result`. Rules, all
  enforced server-side:
  - `target.source` is never `built-in`, and `built-in` cannot be a *move* source: that tier is
    resynced from the release by hash at every boot, so a write there is undone and a delete
    comes back.
  - a name already taken in the target tier is refused unless `overwrite` is set, so a replace
    is always something the owner asked for twice.
  - names and workspace keys are held to `[A-Za-z0-9._-]+` on the wire, then re-resolved against
    the tier root before anything touches the filesystem (same two fences as `GET /skills`).
  - a move is a copy followed by the source delete, in that order: an interrupted transfer
    leaves a visible duplicate rather than nothing.
- `tools.list.result` feeds the app's tools page: the whole catalog as the orchestrator sees
  it (per-agent narrowing is a run-time concern, not a reading surface). `source` tells where
  each tool comes from -- built into the server, an owner-authored `tools.d/` plugin, or an
  external MCP server; MCP tools carry their `server` name so the page can group them, and
  the MCP *settings* stay on the `mcp.list` page. `disabled` mirrors the global
  `tools.disabled` denylist, read live so a hot-reloaded edit shows up on the next visit.
  Parameters are deliberately absent: the wire carries a catalog to read, not schemas to edit.
- `workspaces.list.result` feeds the settings page: the default workspace plus every named
  entry of `config.workspaces`.
- `mcp.list.result` is the wire version of `/mcp`: every server declared under `config.mcp`,
  with the state the manager holds for it. A server that failed to connect is listed with
  `state: "failed"` and its `lastError`, since dropping it would hide exactly the entry worth
  reporting, and a disabled one is listed with no `lastAttemptAt` because it was never tried.
  The declared wiring is shown minus the secrets: `command`, `args` and `url` reach the device
  so the page can display what a server is and offer add/remove/enable, while `env` and
  `headers` never leave the server. The frame exists so the app can name the servers an agent's
  `mcp` scope refers to instead of asking the owner to type names it cannot check.
- `instructions.list.result` never reports a file as missing: a workspace that does not carry
  one reads the configured source's copy, and that is what the agent reads, so the entry
  carries `origin` and `from` instead of a hole. `inherit` and `off` are the workspace's
  effective per-file policy, always normalised; their *absence* is how the app detects a server
  that predates the layer controls, and hides them instead of showing a dead button.
  `agentLayers` carries the file-defined agents and the layers each declares, so the layer
  screen can say which agents already cut a layer in their own file. `files` and `maxBytes`
  come from the server so the app never hardcodes limits the server enforces.
- `instructions.layer.set` sets the per-file policy of one workspace: each absent field keeps
  the current one, `"default"` and `false` are the no-op resets, and it answers with a fresh
  `instructions.list.result` rather than an echo. The server drops fields that say nothing, so
  a policy that is back to the default disappears from `config.workspacePrompts` entirely.
- `instructions.saved` answers every `instructions.set`, refusals included. A refusal does not
  go through the error scope because the editor must tell a conflict (`conflict: true`, meaning
  reload before saving again) apart from a plain failure. The previous content is snapshotted
  before every write, so `/config rollback` can undo an edit made from the app.

- `chat.command.result` is the output of a slash command executed by the server. The app
  renders it as a distinct bubble so a command result never masquerades as an agent answer.
- `details` on a command result is an aside too long to state inline: today, the summary a
  `/compact` produced. The app folds it under the outcome line, in the same collapsed block it
  uses for a model's reasoning, so the thread keeps one short bubble either way.
- A replayed command answer carries `command: true` on its history entry, and its aside in
  `details`: the same two fields the live frames set, so a reopened thread draws the same bubble.
- `chat.command.pending` announces a command still running past 400 ms, keyed on the same
  `replyToId` as its result. The app draws it as a placeholder bubble that the result replaces
  in place, so the wait and the answer are one bubble, never two. A placeholder is also dropped
  when a stream starts on the thread: the agent answered, so no result is coming.
- `chat.send.queued` says a send is parked: a compaction holds the session, so the router waits
  for it before opening the run (`docs/compaction.md`). The app marks that bubble with a running
  counter instead of leaving it silent for the length of the compaction, which read as a dropped
  message. It is lifted by `chat.stream.start`, by a `chat.message`, or by `chat.run.end`, so a
  single lost frame cannot strand the mark.
- `chat.cleared` says the server dropped the thread's history (a typed `/new`); the app drops
  its copy on this frame rather than guessing from an empty history.
- `model.list.result` / `model.result` feed the app's model picker and the per-thread
  indicator. `effort.level` is `""` when the model discards effort. `context.used` is how full
  the window is (docs/context-window.md): the chat header shows it as a percentage, and the app
  re-asks `model.get` at the end of each run to refresh it.`commands.list.result` carries the shared command catalog (same source as the
telegram bot menu), so the app's slash-menu can never drift from the server:
the device asks for it again whenever the menu opens.


Every refusal goes through one exit that logs it and tags it with the screen that asked
(`scope`), so the app shows it where the user is looking rather than in an unrelated
conversation -- and so a server-side bug can never present itself as a dead button.

### Voice notes

A recording held on the mic button is uploaded like any other attachment, then referenced
in `chat.send` with `audioAsVoice: true` and the duration measured while recording. Both are
honoured only when the stored file really is audio, so a client cannot steer the transcription
policy by mislabelling a photo.

The flag is not decoration: it selects the language policy of the existing STT pipeline
(`src/voice/stt.ts`). Dictation gets `voice.stt.language`; an audio file the owner merely picked
gets auto-detection, because forcing a language on unknown speech makes Whisper invent plausible
words instead of failing. Nothing else in the pipeline is channel-specific -- the transcript, the
echo, and the `[Audio]: "..."` rewrite are the same code that serves Telegram and Matrix.

The transcript comes back as `chat.transcript`, addressed to the `chat.send` id the device
generated, with one entry per recording keyed by attachment id, so each note renders its own
words. A message can carry several: the mic stays available while there is no text, and the
`[Audio 1]`, `[Audio 2]` labels in the stored turn keep them apart in the prompt too. Telegram and Matrix get the
same text as an echo message (`voice.stt.echoFormat`); here that echo is dropped, because a
standalone turn quoting the bubble above it says the same thing twice and pushes the conversation
apart. A take that failed has no transcript, so its warning still arrives as a message.

`voice.mode.get` / `voice.mode.set` expose the engine choice: `cloud` (Groq whisper-large-v3),
`local` (faster-whisper, nothing leaves the machine), or `auto`. A set is persisted to
`config.json` rather than applied in memory only, because a switch flipped in the app means "from
now on" and must survive a restart; `voice` is hot-reloaded, so the next recording uses it.
`cloudAvailable` is false when no `GROQ_API_KEY` is set, so the app can say why cloud is not an
option instead of offering a choice that fails.

### Attachments

The device uploads files over HTTP first, then references them in `chat.send`:

```
POST /media?device=<id>&token=<token>
  headers: x-filename, x-type (image|audio|video|file), x-thread-id
  body: raw bytes
-> { "id": "uuid", "type": "image", "filename": "...", "mimeType": "...", "sizeBytes": 123 }
```

Files are stored per conversation as `<id>__<filename>` under
`$MY_CLAW_DIR/files/my-claw-app/<owner>/<threadId>/`, and removed with the session
(archive/delete). The uploader's name is part of the entry so a listing stays a single
readdir with nothing to keep in sync; entries written before that convention
(`<id>.<ext>`) still list, under their id as name. `GET /media/<id>` serves them back
for display/download, and `GET /media/<id>?thumb=1` serves a generated video preview
frame (one JPEG per video, extracted with ffmpeg on first request and cached under
`$MY_CLAW_DIR/files/my-claw-app/.thumbs/`; non-video media answers 404). The channel
keeps no size cap: uploads stream straight to disk, and attachments the agent sends
(`MEDIA:` refs and programmatic attachments) are copied into the same store, so they
count toward the conversation's file size, are served like uploads, and die with the
session. Attachments past
`channels["my-claw-app"].files.warnSizeBytes` (default 50 MB) are logged with a
warning and stored anyway. The agent receives the
attachment as a path it can read with its tools, and images are routed to a
vision-capable model when the active model cannot take them. The files outlive
the run that used them: they are only removed by `files.delete` or with the
session, and later turns re-read them to keep an image in the conversation.


#### Attachments in a replayed conversation

A stored turn keeps the LLM-facing rendering of its attachments, an `[Attachments]`
block of server paths appended to the user text. `session.history` strips that block
and returns the attachments as structured metadata instead, resolved against the
thread's own file listing, so a reopened conversation shows the same bubbles as the
live one: a thumbnail or a named chip that opens the viewer, never a path. An
attachment deleted since carries `deleted: true` -- it is still named, but there is
nothing left to open.

A replayed voice note is rebuilt to match the live bubble rather than the storage format. The
turn is stored as `[Audio]: "..."` because that is what the model must read; history hands the
words back as `transcript` and the duration back on the attachment, so the reopened thread shows
the same player and the same sentence under it instead of printing the marker as body text.

Audio is listed in that block, but with only its path and duration. Its words are already in the
text above, so mime, size and file name are three facts the model will not use and pays for on
every replay of the conversation -- about 14 tokens per recording per turn. Duration stays,
because it is the one thing that cannot be recovered without decoding the file. It was excluded once, on the grounds that
its words were already in the text: the cost was that a replayed voice note came back as bare
text with no bubble to play, and the agent never saw the file it had just been read from -- so
"keep that recording" had no path to work with.

### Diagnostics

```
-> { "type": "diag.snapshot", "threadId": "..." }
<- { "type": "diag.snapshot.result", "text": "..." }

-> { "type": "logs.tail", "scope": "my-claw-app", "level": "warn", "run": "a1b2c3d4",
     "contains": "upload", "limit": 200 }
<- { "type": "logs.tail.result", "text": "...", "lines": 42, "query": { ... } }
```

Both are read-only and redacted server-side (config secrets by value, plus the usual key
shapes). `limit` is clamped to 1000 lines. `run` is the correlation id stamped on every log
line of a single inbound message; it is echoed on `chat.message` and `chat.stream.start` so a
reply can be traced back to its run. Verbosity is `logging.level` in config (hot-reloaded), or
`MY_CLAW_LOG_LEVEL` which overrides it.

`chat.history` is also the ack for `session.delete` (empty messages list).

History is paged backwards. `session.history` takes `before`, a count of messages back
from the newest one; absent or `0` is the newest page, which the app uses to replace the
thread. The reply carries `hasMore` and `nextBefore`, and the app sends `nextBefore` back
as `before` to walk further. The cursor is an offset rather than a message id because a
session is append-only: what sits before a given point never changes. It comes from the
server because the app cannot derive it -- one stored message can become two bubbles (an
assistant turn plus its tool card) and a `role:"tool"` message becomes none of its own, so
the entry count says nothing about how far back the app now is. A cursor past the start of
the session is an empty page with `hasMore: false`, not an error. A server that answers
neither field is one that predates this, and the app simply never asks for an older page.

A page is a count of messages but a conversation is read in turns, so the slice is grown
backwards to the user message that opened the turn it starts in. One agentic turn is easily
fifty tool results: cut at the count, the newest page began inside the work and left the
question that caused it on the page above, which reads as a lost message rather than as
pagination. The walk back is capped at one extra page, so a turn longer than that still starts
mid-flight instead of dragging the whole session into one reply. Pages stay disjoint: the next
cursor is the grown start, so the page above ends exactly where this one begins.
`session.list.result` carries both halves in one round-trip: archived threads are
flagged `archived: true` rather than left out, so the app can fill its two lists and
show the archived count without asking twice. Most recently active first, capped at 50.

App conversations are never swept: `pruneOldSessions` drops stale sessions on the chat
platforms only. A thread the owner can see listed, named and archived must still be there
after a quiet month.

### Tool calls

Unlike the text channels, which glue a formatted note inside the reply, this
channel emits one `chat.tool` frame per executed tool so the client can render a
collapsed card and expand it on tap. `turnId` is the stream id the run started
with, which groups the cards of a turn.

A tool card seals the text bubble it interrupts: the streamer sends
`chat.stream.done` for the current id, then the cards, then a fresh
`chat.stream.start` with id `<turnId>#<n>` for the text that follows. Bubbles
therefore stay in chronological order without the client reordering anything.

### Reasoning

`chat.reasoning.delta` carries what the model thought, for the bubble named by
`id`; `chat.reasoning.tokens` carries a running estimate instead, for engines
that redact the text (the Claude Code bridge). Either one **opens the bubble on
its own**, before any answer text, because the thinking phase is the silence the
owner is waiting through. Reasoning belongs to the segment it arrived in, so a
tool card resets it just as it resets the text.

This is the only channel that receives them: Matrix and Telegram never provide a
reasoning sink to the run. Full rules, per-engine capability and the reason the
reasoning is never replayed to a model: `docs/reasoning-visibility.md`.

### Run lifecycle

One inbound message is one run, bracketed by `chat.run.start` and
`chat.run.end` regardless of how many tools or model turns it takes: the
client pins its Stop affordance to these frames, not to the stream bubbles,
so it survives tool calls and only disappears when the run does. `reason`
distinguishes a finished run from one stopped by the user (`aborted`) or one
that failed (`error`). `activeRun` on `session.list.result` carries the same
state to a device that connects or reconnects mid-run.

`output` is the result handed to the model, capped at 4000 characters
(`truncated: true` past that). Nested `AGENTS.md` injections are excluded.
`/verbose off` suppresses the frames entirely.

History replays the same cards from the session file: entries with
`role: "tool"` carry `name`, `args`, `durationMs`, `ok`, `output`, `truncated`.
`durationMs` is absent for turns recorded before timings were persisted.

### Attachments

`chat.message` carries attachment metadata only:

```json
{ "id": "media-id", "type": "image", "mimeType": "image/png", "filename": "a.png", "sizeBytes": 42 }
```

The file is fetched over HTTP (same auth query params as the WS handshake):

```
GET /media/<id>?device=<deviceId>&token=<token>
```

The app builds the URL from its own credentials; the media registry is a small
look-aside cache over the session store and dropped on adapter stop.

## The command journal

A slash command is answered by the server and never routed, so nothing about it lands in
`session.messages`. Its three bubbles (the command, the optional `Running /...` placeholder, the
answer) lived only in the device's memory, and the first `chat.history` wiped them: `seedHistory`
replaces the screen with the server's version by design, so an old build can never leave a stale
bubble behind. Observed effect: a `/compact` or a `/stop` disappeared from the thread minutes
after it ran.

The record is `session.commands`, an array of `{ input, output, timestamp, details? }` stored
inside the session file:

- **Beside the messages, not among them.** On the home loop `messages` *is* the prompt, so a
  `/status` table stored there would be fed back to the model and then summarized by the next
  compaction. The journal is read by `history()` only.
- **Deleted with the conversation, by construction.** It is a field of the session, so `remove`,
  the archive purge and `/new` (which builds a fresh session object) take it along. There is no
  side file to orphan.
- **Capped at `MAX_SESSION_COMMANDS` (200), newest kept.** A session is one JSON file rewritten
  in full on every turn, the same reason reasoning is capped.
- **Masked.** `input` goes through `redactCommandArgs`, so `/claude set-token` is journaled as
  `set-token [redacted]`.

Three cases are left out on purpose: `/new` (it ends the history a journal belongs to), a
`/status` answered with a structured payload (the app draws a page rather than a bubble, so
replaying one would show something that never existed on screen), and a command on a thread with
no session yet (there is no history to attach it to). Failures are journaled: the owner saw that
bubble too.

`history()` merges the journal into the page it belongs to, by timestamp. Entries are flushed as
the messages are walked, so a command sits where it was typed rather than in a block at one end.
A page is bounded below by its first message and above by the first message of the page after it,
which is what keeps a command out of two pages at once; the newest page has no upper bound, so a
command typed after the last message (the usual case) still shows up.

The two ends of the history are deliberately open:

- **The first page has no lower bound.** A local compaction rewrites `session.messages` down to a
  head, a summary and a tail, so the journal outlives the messages it was interleaved with. Bounded
  by the oldest surviving message, everything typed before it became unreachable while still
  sitting in the file.
- **`MAX_PAGE_COMMANDS` (20) per page, newest kept.** The other half of the same situation: eight
  messages left and a two hundred entry journal is a screen of replayed commands with the
  conversation buried under it. This one is a display cap, nothing is deleted; `MAX_SESSION_COMMANDS`
  remains the only rule that forgets.

## Security

- No public exposure: the WSS/HTTP server is only reachable where the device can
  reach the VPS (private network); the VPS never dials out to the device.
- Every connection and every media fetch is authenticated by device id + token.
- Tokens are per-device and revocable (remove the entry from `devices`, or set
  `enabled: false`), so one window can be cut off without touching the others.
- Approved tools are `allow-session`; unanswered requests time out to `deny`
  (2 minutes).
- Stale sockets (no inbound frame for 90s) are closed by a sweep every 30s.

## Limitations / Roadmap

- Auth is a static per-device token passed as a query parameter, with no expiry. It is
  adequate for a phone on a private network holding the token in the Android Keystore; it is
  the first thing to harden before a browser client, where the URL is far more exposed.
- M3: device tools (accessibility snapshot, notifications, media capture) gated by
  `device.capabilities` and per-action approval in the app.
