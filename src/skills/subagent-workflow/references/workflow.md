# Driving sub-agents

## spawn(name, type, mode, task, workspaceDir?, visibility?, model?)

- `mode: "run"` answers once and is not meant to be driven again. `mode: "session"` is persistent
  on disk and keeps its history: the answer ends with the id (`subagent/explorer-a7b3`) to reuse.
- `workspaceDir`: an absolute directory the sub-agent's filesystem tools resolve relative paths
  against, instead of your workspace. It is a working directory, not a boundary.
- `visibility`: who can list and drive the agent **later**. `global` (default) any conversation,
  `workspace` only conversations of the workspace you are in, `private` this conversation only.
- `visibility` and `workspaceDir` are unrelated: the first decides who reaches the agent, the
  second where its files live. `workspace` suits a worker that belongs to one project, `global` a
  general assistant, `private` scratch work.
- `model`: one of the models the tool lists; the configured sub-agent model otherwise.

## send(id, message, attachments?)

- Continues the conversation with its full history.
- `attachments: [{path, type}]` passes images, videos, audio or documents.
- A send to an agent that is already running waits for it.

## list_agents()

Lists only what this conversation can reach, with status (`running` or `idle`) and visibility. An
agent private to another conversation, or scoped to another workspace, is absent and cannot be
driven.

## kill_agent(id) and reset_agent(id)

- `kill_agent` deletes the agent and its history for good. Its workspace directory is not touched.
- `reset_agent` archives the history and starts fresh, keeping name, type and workspace directory.

## Example

```
spawn("code-explorer", "research", "session", "Map the codebase architecture")
send("subagent/code-explorer-a7b3", "Now analyze src/agent/ in detail")
send("subagent/code-explorer-a7b3", "What does this diagram show?", [{path: "/tmp/scan.png", type: "image"}])
reset_agent("subagent/code-explorer-a7b3")
kill_agent("subagent/code-explorer-a7b3")
```
