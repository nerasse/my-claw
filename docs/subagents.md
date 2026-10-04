# Sub-agents

> **Note historique** : ce document a été écrit quand my-claw servait aussi Telegram et Matrix.
> Ces deux canaux ont été supprimés (seul `my-claw-app` subsiste). Les mentions et chemins de
> fichiers `channels/telegram/*` et `channels/matrix/*` ci-dessous sont conservés pour la trace
> de la décision : ils ne décrivent plus le code.

Persistent, named sub-agents with isolated sessions and optional workspace directories.

## Architecture

A sub-agent is a `SessionData` object with `meta: SubAgentMeta` stored on disk. No background process. The sub-agent "runs" only when `send()` or `spawn(mode="session")` is called, creating a temporary `AgentBridge` that loads the session, executes, and saves back to disk.

### Storage

```
~/.my-claw/sessions/subagent/
└── <displayName>-<hex4>.json   # SessionData + SubAgentMeta
```

The filesystem is the source of truth. `SubAgentRegistry` scans `sessions/subagent/` on boot. No separate registry file.

## Types

| Type | Tools | Use case |
|---|---|---|
| `general` | All base tools (bash, read, write, apply_patch, fetch, search, ls, memory) | Execution tasks |
| `research` | Read-only: read, search, ls, fetch | Exploration, analysis |
| `browser` | The `browser_*` tools and nothing else | Web tasks. Not offered by `spawn`: reached through `delegate_browser_task`, which frames the task, runs it in windows of its own on the one Chromium and reads the handoff back (`docs/browser.md`, `docs/browser-windows.md`). Its runs are private one-shots of the caller, listed, opened and driven like any other |

Depth 0 (orchestrator) can spawn depth 1. `MAX_DEPTH` is 2, but **depth 2 is currently unreachable**:
`spawn` is in `SUBAGENT_EXCLUDED_TOOLS` (`src/tools/registry.ts`), so no sub-agent of any type can
spawn, and `executeRunWithSession` hard-codes `depth = 1`.

## Lifecycle

### `spawn(name, type, mode, task, workspaceDir?)`

- `mode: "run"` — one-shot. No cap on concurrent runs: the owner removed it (2026-09-23) so
  the model can fan out freely; depth stays structural (sub-agents have no `spawn`). The session is **kept** after the run:
  the app lists it as a temporary sub-agent and can open and drive it like any other. It is always
  `private`, so only the conversation that asked for it sees it, and it dies with that conversation
  (the app's delete cascades, see `docs/subagent-navigation.md`).
- `mode: "session"` — persistent. Creates `sessions/subagent/<name>-<hex4>.json`. The answer ends with
  `[sub-agent id: subagent/<name>-<hex4>]`: the id is the only way back to that agent, and the caller
  has no other source for it. A one-shot gets no such line, nothing is meant to drive it again.
- A **session spawn whose first run fails** is undone: the session is deleted before the error is
  rethrown. The caller holds an error and no id, so anything left on disk would be a roster entry
  nobody can name, drive or kill. An aborted run is kept, the owner stopped it and its transcript
  is the point.
- `workspaceDir` — optional absolute path. All filesystem tools (`read`, `write`, `apply_patch`, `bash`, `ls`, `search`) resolve against this path instead of the global workspace.
- `model` — optional: a tag (`tag:Cheap`) or a model id (`provider/model`); the configured
  sub-agent model otherwise. A plain string, checked when the call comes in: a known id or tag
  passes, anything else is refused with the five ids that look most like it and the tags.
  It used to be an `enum` of the whole catalog, 544 ids and about 5 000 tokens on every request of
  the orchestrator (measured 2026-10-04), and the enum moved whenever discovery found a model while
  the tool definitions open the cached prefix. The tags, a handful that change only with the
  config, are named in the parameter's description.

### `send(id, message, attachments?)`

Loads the session, appends the message (with optional attachments), executes an `AgentBridge` run, saves the session.

**FIFO queueing**: concurrent `send` to the same sub-agent chains sequentially. No reject, no error. The second `send` waits for the first to complete, then executes.

### `agents(action, id?)`

One tool for the three rare actions on persistent sub-agents (they were `list_agents`,
`kill_agent` and `reset_agent` until 2026-10-04: three definitions on every request for one shape).
`spawn` and `send` stay their own, they are the hot path.

- `list` — scans `sessions/subagent/`. Returns: id, displayName, type, messageCount, status
  (`idle` | `running`), visibility.
- `kill` (id) — deletes the session permanently. Workspace directory is NOT touched.
- `reset` (id) — archives the current session to `sessions-archive/`, then recreates an empty
  session with the same `meta` (preserving name, type, workspaceDir).

## Attachments

`send` accepts an `attachments` array:

```json
[
  { "path": "/tmp/photo.png", "type": "image" },
  { "path": "/tmp/doc.pdf", "type": "file" }
]
```

Every attachment is listed as an `[Attachments]` block in the turn's text, so the sub-agent sees the
paths and can `read` them if accessible.

**Images are carried, not just listed.** They are also written to the user entry as
`attachments: [{ type: "image", path }]`, which is what `attachImages` (`src/agent/bridge.ts`)
rebuilds into image blocks on every request. Two consequences worth stating:

- The picture survives its own turn. Chat APIs are stateless, so an image is only visible while it
  is resent; the entry is the source the prompt is rebuilt from, up to `MAX_HISTORY_IMAGES`.
- The run resolves as one that carries images, so a model without vision reroutes to
  `llm.visionFallback` and, failing that, warns that the image was dropped.

Before this, the entry was written without the field and the run's message carried an empty
attachment array: the picture reached the model as a filesystem path in prose, and the drop warning
could not fire because it reads the same empty array. Everything that is not an image stays listed
rather than carried, which is the current state of the sub-agent media path.

## Limits

| Limit | Value | Configurable |
|---|---|---|
| Max concurrent one-shot runs | 3 | Hardcoded |
| Max spawn depth | 2 | Hardcoded |
| Max messages per persistent session | 500 (auto-truncates to last 50) | Hardcoded |
| Iteration budget (orchestrator) | 90 | `agents.orchestrator.maxIterations` |
| Iteration budget (sub-agent) | 50 | `agents.general.maxIterations`, `agents.research.maxIterations` |
| Unlimited persistent sub-agents on disk | Yes | — |

Each agent (orchestrator and every sub-agent) gets its own isolated `IterationBudget`. A sub-agent burning 50 iterations does not affect the parent's budget. When a budget is exhausted, the agent makes one final toolless LLM call to produce a graceful summary instead of returning a truncated error.

## Streaming behavior

Single message per agent run on both Telegram and Matrix. Tool call output is appended inline after execution (not before), so timing data is included.

### `/verbose` toggle (per session, ON by default)

| Mode | Format | Example |
|---|---|---|
| **ON** | Code block with args + timing | `bash({"cmd":"ls"}) [120ms]` |
| **OFF** | Blockquote with names only | `> bash, read` |

### Rules

- Arguments truncated to 240 chars if JSON > 300 chars; full display otherwise
- Natural chunking when message limit reached (Telegram 4096, Matrix 4000)
- Typing indicator active during entire agent run, stopped on completion or max iterations
- `onToolUse` fires after tool execution (captures timing), not before

## Reboot behavior

On boot, `SubAgentRegistry.load()` scans `sessions/subagent/`. All existing sub-agents appear as `idle` in `agents(action="list")`. A `send()` immediately reloads the full session history from disk and continues the conversation.

## Example interaction

```
User: "create a code-explorer"
LLM → spawn("code-explorer", "research", "session", "explore src/")
→ "Read src/, 42 files. [sub-agent id: subagent/code-explorer-a7b3]"

User: "ask it to analyze core/"
LLM → send("subagent/code-explorer-a7b3", "analyze core/")
→ (sub-agent reuses its full session history)

User: "list my sub-agents"
LLM → agents(action="list")
→ "subagent/code-explorer-a7b3 | code-explorer | research | 12 messages | idle"

User: "reset code-explorer"
LLM → agents(action="reset", id="subagent/code-explorer-a7b3")
→ "Session reset. Workspace preserved."

User: "delete it"
LLM → agents(action="kill", id="subagent/code-explorer-a7b3")
→ "Sub-agent deleted."
```

## Implementation

| File | Role |
|---|---|
| `src/subagents/types.ts` | `SubAgentMeta`, `SubAgentInfo`, `SubAgentType` |
| `src/subagents/registry.ts` | `SubAgentRegistry` — ID generation, FIFO enqueue, scan |
| `src/subagents/runner.ts` | `SubAgentRunner` — spawn, send, kill, reset, list |
| `src/tools/spawn.ts` | `spawn` tool |
| `src/tools/send.ts` | `send` tool with attachments |
| `src/tools/agents.ts` | `agents` tool (list, kill, reset) |
| `src/tools/workspace.ts` | `resolveWorkspacePath(input, workspaceDir?)` |
| `src/agent/bridge.ts` | Injects `__workspaceDir` into tool args |

## One-shots queue like everyone else

A `mode: "run"` sub-agent used to call its executor directly while the `mode: "session"` path went
through `registry.enqueue`. `registry.isRunning` reads exactly that queue map, so a one-shot
reported **`idle` in the roster for its entire life** -- caught on a run that was 187 iterations
deep at the time. The same queue is what `send()` serialises on, so a send arriving mid-run could
also race the one-shot on its session file, which is the thing the session path's comment already
said it was there to prevent.

Both paths enqueue now. See `tests/subagent.test.ts`.
