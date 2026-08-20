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

Depth 0 (orchestrator) can spawn depth 1. `MAX_DEPTH` is 2, but **depth 2 is currently unreachable**:
`spawn` is in `SUBAGENT_EXCLUDED_TOOLS` (`src/tools/registry.ts`), so no sub-agent of any type can
spawn, and `executeRunWithSession` hard-codes `depth = 1`.

## Lifecycle

### `spawn(name, type, mode, task, workspaceDir?)`

- `mode: "run"` — one-shot. Max 3 concurrent runs globally. The session is **kept** after the run:
  the app lists it as a temporary sub-agent and can open and drive it like any other. It is always
  `private`, so only the conversation that asked for it sees it, and it dies with that conversation
  (the app's delete cascades, see `docs/subagent-navigation.md`).
- `mode: "session"` — persistent. Creates `sessions/subagent/<name>-<hex4>.json`. Returns stable ID.
- `workspaceDir` — optional absolute path. All filesystem tools (`read`, `write`, `apply_patch`, `bash`, `ls`, `search`) resolve against this path instead of the global workspace.

### `send(id, message, attachments?)`

Loads the session, appends the message (with optional attachments), executes an `AgentBridge` run, saves the session.

**FIFO queueing**: concurrent `send` to the same sub-agent chains sequentially. No reject, no error. The second `send` waits for the first to complete, then executes.

### `list_agents()`

Scans `sessions/subagent/*.json`. Returns: id, displayName, type, messageCount, status (`idle` | `running`).

### `kill_agent(id)`

Deletes the session file permanently. Workspace directory is NOT touched.

### `reset_agent(id)`

Archives the current session to `sessions-archive/`, then recreates an empty session with the same `meta` (preserving name, type, workspaceDir).

## Attachments

`send` accepts an `attachments` array:

```json
[
  { "path": "/tmp/photo.png", "type": "image" },
  { "path": "/tmp/doc.pdf", "type": "file" }
]
```

Each attachment is rendered as `[Attachments]` in the user message context. The sub-agent sees the file paths and can `read` them if accessible.

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

On boot, `SubAgentRegistry.load()` scans `sessions/subagent/`. All existing sub-agents appear as `idle` in `list_agents()`. A `send()` immediately reloads the full session history from disk and continues the conversation.

## Example interaction

```
User: "create a code-explorer"
LLM → spawn("code-explorer", "research", "session", "explore src/")
→ "Sub-agent 'subagent/code-explorer-a7b3' created."

User: "ask it to analyze core/"
LLM → send("subagent/code-explorer-a7b3", "analyze core/")
→ (sub-agent reuses its full session history)

User: "list my sub-agents"
LLM → list_agents()
→ "subagent/code-explorer-a7b3 | code-explorer | research | 12 messages | idle"

User: "reset code-explorer"
LLM → reset_agent("subagent/code-explorer-a7b3")
→ "Session reset. Workspace preserved."

User: "delete it"
LLM → kill_agent("subagent/code-explorer-a7b3")
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
| `src/tools/list-agents.ts` | `list_agents` tool |
| `src/tools/kill-agent.ts` | `kill_agent` tool |
| `src/tools/reset-agent.ts` | `reset_agent` tool |
| `src/tools/workspace.ts` | `resolveWorkspacePath(input, workspaceDir?)` |
| `src/agent/bridge.ts` | Injects `__workspaceDir` into tool args |
