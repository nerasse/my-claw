# Sub-agents

> **Historical note**: this document was written when my-claw also served Telegram and Matrix.
> Both channels have been removed (only `my-claw-app` remains). The mentions and file paths
> `channels/telegram/*` and `channels/matrix/*` below are kept as the trace of the decision:
> they no longer describe the code.

Persistent, named sub-agents with isolated sessions and optional workspace directories.

## Architecture

A sub-agent is a `SessionData` object with `meta: SubAgentMeta` stored on disk. No background process. The sub-agent "runs" only when `send()` or `spawn(mode="session")` is called, creating a temporary `AgentBridge` that loads the session, executes, and saves back to disk.

### Storage

```
~/.my-claw/sessions/subagent/
└── <displayName>-<hex4>/          # one directory per agent, since the storage switch
    ├── entries.jsonl              # the conversation, append-only -- docs/session-log.md
    └── meta.json                  # settings, SubAgentMeta, and the quota wait
```

The filesystem is the source of truth. `SubAgentRegistry` scans `sessions/subagent/` on boot, and
`subagentSessionIdsSync` accepts both shapes: a name that is a directory today was a `<id>.json`
before the switch, and a name that is both is one id. No separate registry file.

## Types

| Type | Tools | Use case |
|---|---|---|
| `general` | All base tools (bash, read, write, apply_patch, fetch, search, ls, memory) | Execution tasks |
| `research` | Read-only: read, search, ls, fetch | Exploration, analysis |
| `browser` | The `browser_*` tools and nothing else | Web tasks. Not offered by `spawn`: reached through `delegate_browser_task`, which frames the task, runs it in windows of its own on the one Chromium and reads the handoff back (`docs/browser.md`, `docs/browser-windows.md`). Its runs are private one-shots of the caller, listed, opened and driven like any other. The door takes the same `model` a spawn does, pinned on the run |

Depth is read off the sessions' own parent links (`depthUnder`), not assumed: the orchestrator is
level 0, a spawned agent level 1, and a browser task it delegates level 2. `MAX_SUBAGENT_DEPTH` is 2
and the check lives in `spawn`, which both doors pass through, whatever tools a role happens to hold:
a role that read the wrong field handed every sub-agent of a cron job the delegation tools, and
browser tasks delegated to browser tasks 325 levels deep for six hours (2026-09-28).

`spawn` is still in `SUBAGENT_EXCLUDED_TOOLS`, so a sub-agent cannot *spawn*; the second level is
reached through `delegate_browser_task`, which is the one door deliberately open below the root.

## Lifecycle

### `spawn(name, type, mode, task, workspaceDir?)`

- `mode: "run"`: one-shot. No cap on concurrent runs: the owner removed it (2026-09-23) so
  the model can fan out freely; depth stays structural (sub-agents have no `spawn`). The session is **kept** after the run:
  the app lists it as a temporary sub-agent and can open and drive it like any other. It is always
  `private`, so only the conversation that asked for it sees it, and it dies with that conversation
  (the app's delete cascades, see `docs/subagent-navigation.md`).
- `mode: "session"`: persistent. Creates `sessions/subagent/<name>-<hex4>/`. The answer ends with
  `[sub-agent id: subagent/<name>-<hex4>]`: the id is the only way back to that agent, and the caller
  has no other source for it. A one-shot gets no such line, nothing is meant to drive it again.
- A **session spawn whose first run fails** is undone: the session is deleted before the error is
  rethrown. The caller holds an error and no id, so anything left on disk would be a roster entry
  nobody can name, drive or kill. An aborted run is kept, the owner stopped it and its transcript
  is the point.
- `workspaceDir`: optional absolute path. All filesystem tools (`read`, `write`, `apply_patch`, `bash`, `ls`, `search`) resolve against this path instead of the global workspace.
- `model`: optional, a tag (`tag:Cheap`) or a model id (`provider/model`); the configured
  sub-agent model otherwise. A plain string, checked when the call comes in: a known id or tag
  passes, anything else is refused with the five ids that look most like it and the tags.
  It used to be an `enum` of the whole catalog, 544 ids and about 5 000 tokens on every request of
  the orchestrator (measured 2026-10-04), and the enum moved whenever discovery found a model while
  the tool definitions open the cached prefix. The tags, a handful that change only with the
  config, are named in the parameter's description.
- `effort` and `contextCap`: optional, and they are the sub-agent's own pins. A sub-agent's
  session is a session: they are written to `effortOverride` and `contextOverride`, exactly the
  two fields a chat's `/effort` and `/cap` set, so the resolver and the window reader apply them
  with the precedence that already exists (session > tag > agent > global) and no second one to
  keep in step. A `mode: "session"` sub-agent keeps them across `send()` the way a chat keeps its
  own. Omitted, nothing is written and the agent's own scope decides: a spawn only ever adds to
  what the agent file and the config say.

### Background, and the return

Delegating never waits. `spawn`, `send` and `delegate_browser_task` return as soon as the child is
working, with its id:

```
Started eyes (research, id: subagent/eyes-1a2b) in the background. It works on its own and you will
get a <subagent> message when it is done. Do not sleep, poll or duplicate its work: continue with
something else, or end your turn and let the return wake you.
```

Same rule as opencode, codex and deepseek-harness: the model-facing call returns immediately and the
runtime owns the completion. `wait: true` is the escape hatch for a caller that cannot do anything
without the answer (a cron job, one step of a browser chain); it blocks and returns the child's own
words, and it is the only path that still appends `[sub-agent id: …]` for a `session` spawn.

**A wait has a budget: two minutes.** Past it the child carries on and its answer arrives as the
return, exactly as if it had been launched without one, and the caller is handed the launch line
instead of the answer. The budget exists because a wait is an escape hatch the model chooses, and a
browser task that took seven minutes held the conversation that asked for it for seven minutes with
nothing on screen but a Stop button (owner, 2026-11-25). A bounded wait starts on the background
footing (no caller signal, registered as background work) because it may become one: a child that
would be cut by its caller's end is not a child that can carry on without it. The delivery is
attached only once the budget is spent, so the caller is never told the same answer twice.

- **The child outlives the run.** A background child is started without the caller's abort signal:
  the end of that run (the normal case, the model ends its turn while the child works) must not
  cut it. A Stop of the conversation is different: it names the children explicitly
  (`stopBackgroundOf`), because there is no signal left to cascade.
- **The return is one turn of the caller's conversation.** Written as a `user` entry with
  `from: { sessionId, label, kind: "return", status }`, and carried as a `<subagent …>` tag so the
  model never mistakes it for the owner speaking. The app reads `from` and draws a card, not a
  bubble; `display.ts` strips the tag for the reader.
- **Delivery reuses the one door.** A conversation with a run in flight has an open mailbox and
  absorbs it at the next boundary; a conversation at rest is woken by it, through the same path a
  cron `followUp` or a hand-back uses. A child stopped with its conversation reports nothing: a
  return would wake the run the owner just ended.
- **The launch card is the same card.** `subagent:spawn` opens it, the terminal state folds onto it
  from `spawn_state`, and the return draws its own card with the child's answer and pictures.
- **A runner with no return sink launches nothing in the background**: every call waits, which is
  what keeps the behaviour unchanged on a channel with nobody to wake.

The same three parameters are on `delegate_browser_task` (a browsing run is pinned like a spawned
one), and they are read by `judgePins` in `src/tools/model-choice.ts` so one door cannot accept an
effort the other refuses. The effort ladder is the resolver's own, not the model's trimmed list:
which levels a model accepts is clamped downstream.

`model` takes the whole `provider/model` reference and nothing less. A label the app shows
("GPT-6 Luna") and a bare id tail (`gpt-6-luna`) are both refused with the ids that look like
them: an install carries six models under that name, and picking one for the caller is picking
whose quota gets spent.

### `send(id, message?, attachments?, model?, effort?, contextCap?, fallback?, scope?)`

Loads the session, appends the message (with optional attachments), executes an `AgentBridge` run, saves the session.

**FIFO queueing**: concurrent `send` to the same sub-agent chains sequentially. No reject, no error. The second `send` waits for the first to complete, then executes.

**The run's execution is part of the call.** The same `model`/`effort`/`contextCap` a `spawn`
takes, judged by the same `refuseUnknownModel` and `judgePins`, plus a fallback policy:

| Field | What it does |
|---|---|
| `model` | A tag or a whole `provider/model` id for this run. Applied as `session.modelOverride` inside the child's queue entry, so it never lands on a live iteration. |
| `effort`, `contextCap` | `effortOverride` / `contextOverride`, exactly as `/effort` and `/cap` write them. |
| `fallback: "forbid"` | The run uses that model or stops: no other model, no other family. See `docs/provider-failures.md`. `"inherit"` or absent keeps the configured chain. |
| `scope: "run"` (default) | The four fields apply to this invocation, and are put back before the session is persisted. This is the default because changing an agent's standing model as a side effect of resuming it is a choice the caller states, not one it walks into. |
| `scope: "session"` | They stay for the agent's later runs. |

Omitted fields are absent, not cleared: a `send` that names nothing leaves the agent exactly as it
was, which is what every pre-existing caller relies on.

**A provider failure answers in fields**, not prose, through `blockedReportOf` in
`src/subagents/blocked.ts`: `reason` (quota_exhausted, rate_limited, auth, transport, ...),
`requested` model and provider, `partialWork` (`possible` | `unknown`, never `none`),
`historyPreserved`, `resumable`, `retry.eligibleAt` when the provider named one, and `nextActions`.
The readable sentence comes first and the same report rides after it as one `blocked: {...}` line.

### `agents(action, id?, query?, status?, type?, limit?, offset?)`

One tool for the rare actions on persistent sub-agents (they were `list_agents`,
`kill_agent` and `reset_agent` until 2026-10-04: three definitions on every request for one shape).
`spawn` and `send` stay their own, they are the hot path.

- `list`: scans `sessions/subagent/`. Returns: id, displayName, type, messageCount, status
  (`idle` | `running`), visibility, and the model when the session records one. Narrow it with
  `query` (substring on id, display name and type), `status` and `type`; page it with `limit`
  (default 50, max 200) and `offset`. A page that is shorter than the match set says so, so a
  filtered answer cannot be read as a total.
- `inspect` (id): one agent in detail, read off its own log: `lifecycle` (`never-run`,
  `running`, `complete`, `failed`, `stopped`, `lost`, `blocked`), its last tool and whether it
  succeeded, `resumable`, the armed quota wait when the owner's retry is what stopped it, and
  `nextActions` in the words of the tools that do them. `blocked` is a failed run whose
  `run_end.failure` is `quota_exhausted`: the one failure that clears itself with time. The class
  is written by the bridge from `classifyProviderFailure`, not inferred from the owner's chat-level
  wait: a sub-agent never has one.
- `kill` (id): deletes the session permanently. Workspace directory is NOT touched.
- `reset` (id): archives the current session to `sessions-archive/`, then recreates an empty
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
| Unlimited persistent sub-agents on disk | Yes | n/a |

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
| `src/subagents/types.ts` | `SubAgentMeta`, `SubAgentInfo`, `SubAgentDetail`, `SubAgentLifecycle`, `SubAgentType` |
| `src/subagents/registry.ts` | `SubAgentRegistry`: ID generation, FIFO enqueue, scan |
| `src/subagents/runner.ts` | `SubAgentRunner`: spawn, send (with execution), inspect, kill, reset, list |
| `src/subagents/blocked.ts` | `blockedReportOf`: what a caller is told when a provider refused the run |
| `src/tools/spawn.ts` | `spawn` tool |
| `src/tools/send.ts` | `send` tool: message, attachments, model, effort, contextCap, fallback, scope |
| `src/tools/agents.ts` | `agents` tool (list with filters and pages, inspect, kill, reset) |
| `src/tools/workspace.ts` | `resolveWorkspacePath(input, workspaceDir?)` |
| `src/agent/bridge.ts` | Injects `__workspaceDir` into tool args |

## One-shots queue like everyone else

A `mode: "run"` sub-agent used to call its executor directly while the `mode: "session"` path went
through `registry.enqueue`. `registry.isRunning` reads exactly that queue map, so a one-shot
reported **`idle` in the roster for its entire life**, caught on a run that was 187 iterations
deep at the time. The same queue is what `send()` serialises on, so a send arriving mid-run could
also race the one-shot on its session file, which is the thing the session path's comment already
said it was there to prevent.

Both paths enqueue now. See `tests/subagent.test.ts`.

## Tests

- `tests/subagents/quota-retry.test.ts`: a child arms its own wait (switch on, provider reset
  published, same one-minute buffer), arms nothing with the switch off, counts attempts across
  walls, and `resumeArmedWait` refuses a finished child while resuming an unanswered one.
- `tests/subagents/handoff.test.ts`: the blocked report's handoff: settled calls in order, calls
  from a previous turn excluded, an interrupted one marked uncertain, a cap with the count admitting
  what it left out, and an empty log that never becomes "nothing happened".
- `tests/subagents/inspect.test.ts`: the lifecycle read off the markers, `blocked` included.
- `tests/subagents/send-execution.test.ts`: `fallback: "forbid"` against a spent account: **one**
  request, nothing on another family; the same call without the policy still walks to the default;
  the blocked report's fields; a run-scoped model put back on disk, a session-scoped one kept; a
  refused id reaching no wire; a nonsense `fallback`/`scope` refused before any run.
- `tests/subagents/model-resolution.test.ts`: the model a spawn/pick resolves, read off the wire.
- `tests/tools/agents-tool.test.ts`: list filters and pages, `inspect` describing a log, an
  unknown action refused, and the schema's required fields.
- `tests/continue/subagent-resume.test.ts`: `send(id)` with no message adds no turn and picks up
  where the run stopped.
- `tests/llm/provider-fallback.test.ts`: the order of the targets and the case that must stay empty.
