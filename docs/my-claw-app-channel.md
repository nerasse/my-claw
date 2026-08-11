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

Outgoing frames (replies, stream deltas, tool cards, approval requests) go to every
connected device of the owner. Sockets are resolved per frame, so a window that connects
mid-answer still receives the rest of the stream. An approval is asked on all of them and
the first answer wins.

### Device -> Server

```json
{ "type": "chat.send", "id": "uuid", "text": "...", "threadId": "projet", "ts": "iso", "attachments": [{ "id": "uuid", "type": "image|file" }, { "id": "uuid", "type": "audio", "audioAsVoice": true, "durationMs": 4200 }] }
{ "type": "chat.stop", "threadId": "projet" }
{ "type": "session.list" }
{ "type": "commands.list" }
{ "type": "files.list", "threadId": "projet" }
{ "type": "files.delete", "threadId": "projet", "id": "uuid" }
{ "type": "session.history", "threadId": "projet", "limit": 50 }
{ "type": "session.archive", "threadId": "projet" }
{ "type": "session.unarchive", "threadId": "projet" }
{ "type": "session.delete", "threadId": "projet" }
{ "type": "session.rename", "threadId": "projet", "title": "Infra maison" }
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
{ "type": "tools.list" }
{ "type": "workspaces.list" }
{ "type": "mcp.list" }
{ "type": "instructions.list" }
{ "type": "instructions.get", "workspace": "default|sofa", "file": "AGENTS.md", "nested": "svc/AGENTS.md" }
{ "type": "instructions.set", "workspace": "sofa", "file": "AGENTS.md", "content": "...", "sha": "9f2b1c4d5e6a" }
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
  `AGENTS.md` is a file the agent writes too. See `docs/instructions-page.md`.
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
  agent. Commands outside the catalog still route as normal messages.
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

### Server -> Device

```json
{ "type": "chat.message", "id": "uuid", "text": "...", "threadId": "projet", "attachments": [...], "replyToId": "uuid" }
{ "type": "chat.run.start", "threadId": "projet", "run": "a1b2c3d4" }
{ "type": "chat.run.end", "threadId": "projet", "reason": "done|aborted|error", "run": "a1b2c3d4" }
{ "type": "chat.stream.start", "id": "uuid", "threadId": "projet", "replyToId": "uuid" }
{ "type": "chat.stream.delta", "id": "uuid", "threadId": "projet", "text": "..." }
{ "type": "chat.stream.done", "id": "uuid", "threadId": "projet" }
{ "type": "chat.stream.abort", "id": "uuid", "threadId": "projet", "error": "..." }
{ "type": "chat.tool", "id": "uuid:tool:1", "threadId": "projet", "turnId": "uuid", "name": "bash", "args": {...}, "durationMs": 4, "ok": true, "output": "...", "truncated": false, "ts": "iso" }
{ "type": "chat.history", "threadId": "projet", "messages": [{ "id": "h-...", "role": "user|assistant", "text": "...", "ts": "iso", "transcript": "...", "attachments": [{ "id": "uuid", "type": "image", "filename": "photo.png", "mimeType": "image/png", "sizeBytes": 5120, "durationMs": 3100, "deleted": false }] }] }
{ "type": "session.list.result", "sessions": [{ "threadId": "...", "title": "...", "messageCount": 4, "createdAt": "...", "lastActiveAt": "...", "archived": true, "activeRun": true }] }
{ "type": "commands.list.result", "commands": [{ "name": "status", "description": "..." }] }
{ "type": "files.list.result", "threadId": "projet", "files": [{ "id": "uuid", "filename": "note.pdf", "type": "file", "mimeType": "application/pdf", "sizeBytes": 5120, "ts": "iso" }], "totalBytes": 5120 }
{ "type": "approval.request", "id": "uuid", "threadId": "projet", "toolName": "bash", "args": {...}, "expiresAt": 123 }
{ "type": "chat.transcript", "threadId": "projet", "replyToId": "uuid", "items": [{ "id": "uuid", "text": "ce que le serveur a entendu" }] }
{ "type": "chat.command.result", "threadId": "projet", "replyToId": "uuid", "text": "output of a command the server executed" }
{ "type": "chat.cleared", "threadId": "projet" }
{ "type": "voice.mode.result", "mode": "auto", "resolved": "cloud", "cloudAvailable": true }
{ "type": "model.list.result", "models": [{ "id": "gpt-5.1", "label": "GPT-5.1", "group": "OpenAI/Pro", "provider": "openai", "effortLevels": ["low", "medium", "high"], "context": 400000 }, { "id": "tag:opus", "label": "opus", "group": "Tags", "effort": "xhigh" }], "defaultModel": "gpt-5.1" }
{ "type": "model.result", "threadId": "projet", "model": "gpt-5.1", "defaultModel": "gpt-5.1", "effort": { "level": "medium", "levels": ["low", "medium", "high"], "supported": true }, "context": { "raw": 400000, "effective": 256000, "cap": 256000, "choice": 256000 } }
{ "type": "skills.list.result", "skills": [{ "name": "voice", "description": "Voice mode plumbing", "version": "1.0.0", "source": "built-in|custom|workspace", "path": "/home/neras/.my-claw/skills/.builtin/voice/SKILL.md", "workspace": "sofa" }] }
{ "type": "tools.list.result", "tools": [{ "name": "bash", "description": "Run a command in the workspace", "source": "built-in", "disabled": false }, { "name": "my_weather", "description": "Forecast for a city", "source": "plugin", "disabled": false }, { "name": "mcp__mailcow__get_status", "description": "Mail server status", "source": "mcp", "server": "mailcow", "disabled": false }], "missing": ["cron"] }
{ "type": "workspaces.list.result", "workspaces": [{ "key": "default", "path": "/home/neras/.my-claw/workspace", "default": true }, { "key": "sofa", "path": "/home/neras/dev/SOFA", "default": false }] }
{ "type": "mcp.list.result", "servers": [{ "name": "mailcow", "transport": "stdio|sse|http", "state": "connected|disabled|failed", "toolCount": 2, "lastError": "spawn ENOENT", "lastAttemptAt": "iso", "enabled": false, "command": "mcp-mail", "args": ["--port", "2525"], "url": "http://mcp.local" }] }
{ "type": "instructions.list.result", "entries": [{ "workspace": "sofa", "file": "AGENTS.md", "origin": "own|inherited|fallback|off", "from": "default", "bytes": 1240, "sha": "9f2b1c4d5e6a", "inherit": "default|lab|builtin|none", "off": false }], "nested": [{ "workspace": "default", "path": "svc/AGENTS.md", "bytes": 400 }], "files": ["CORE.md", "SOUL.md", "AGENTS.md", "USER.md"], "maxBytes": 262144, "agentLayers": [{ "agent": "reviewer", "layers": ["CORE", "USER"] }] }
{ "type": "instructions.file", "workspace": "sofa", "file": "AGENTS.md", "content": "...", "origin": "own|inherited|fallback|off|nested", "from": "default", "sha": "9f2b1c4d5e6a", "editable": true }
{ "type": "instructions.saved", "workspace": "sofa", "file": "AGENTS.md", "ok": false, "sha": "", "conflict": true, "error": "changed on the server since it was opened" }
{ "type": "agents.config.result", "defaultModel": "gpt-5.1", "defaultProvider": "openai", "defaultEffort": "high", "effortLevels": ["low", "medium", "high", "xhigh", "max", "ultra"], "providers": [{ "key": "anthropic", "type": "claude-sdk", "group": "Claude", "discover": true, "models": 14, "keyEnv": "ANTHROPIC_API_KEY", "keyPresent": true }], "agents": [{ "key": "orchestrator", "label": "Orchestrator", "description": "The agent you talk to", "model": "gpt-5.1", "provider": "openai", "pinned": false, "inheritsFrom": "global" }, { "key": "cron", "label": "Scheduled tasks", "description": "Jobs on a schedule", "model": "gpt-5.1", "pinned": false, "inheritsFrom": "orchestrator" }] }
{ "type": "agents.file.result", "name": "reviewer", "source": "custom", "path": "/home/neras/.my-claw/agents/reviewer.md", "editable": true, "sha": "9f2b1c4d5e6a", "description": "Reviews a diff", "base": "research", "tools": ["read", "grep"], "skillsMode": "list", "skills": ["code-review"], "mcpMode": "absent", "prompt": "You review code.", "toolOptions": ["read", "grep", "find", "ls"], "unknownTools": [] }
{ "type": "agents.file.saved", "name": "reviewer", "ok": true, "sha": "9f2b1c4d5e6a", "conflict": false }
{ "type": "config.result", "content": "{ ... }", "sha": "9f2b1c4d5e6a", "maxBytes": 524288 }
{ "type": "config.saved", "ok": true, "sha": "9f2b1c4d5e6a", "conflict": false, "changed": ["llm"], "rebootRequired": [] }
{ "type": "notifications.info", "vapidPublicKey": "..." }
{ "type": "tags.result", "tags": [{ "name": "Default", "model": "gpt-5.1" }, { "name": "opus", "model": "claude-opus-4-8", "effort": "xhigh", "contextCap": 50000 }] }
{ "type": "jobs.runs.result", "jobId": "abc123def456", "runs": [{ "threadId": "cron-abc123def456-1723200000000", "runAt": 1723200000000, "messageCount": 4, "title": "Morning report · 08/08 19:30" }] }
{ "type": "error", "message": "...", "scope": "chat|files|session|diag|logs|voice|model|skills|agents|mcp|tools|instructions|config|workspaces|jobs|notifications" }
```

- `skills.list.result` feeds the app's skills page. `path` is display-only (where to edit the
  file on the server); reading goes through `GET /skills?device&token&source&name`, which
  serves the raw `SKILL.md` (`text/markdown`) with the same device auth as `/media`.
  `workspace` is present only on skills of a named workspace.
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
- `chat.cleared` says the server dropped the thread's history (a typed `/new`); the app drops
  its copy on this frame rather than guessing from an empty history.
- `model.list.result` / `model.result` feed the app's model picker and the per-thread
  indicator. `effort.level` is `""` when the model discards effort.`commands.list.result` carries the shared command catalog (same source as the
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
