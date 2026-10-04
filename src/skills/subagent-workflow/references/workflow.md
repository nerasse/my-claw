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
- `model`: a tag the tool names (`tag:Cheap`, `tag:Smart`...) or a model id (`provider/model`); the
  configured sub-agent model otherwise. A wrong id is refused with the closest known ids.

## send(id, message, attachments?)

- Continues the conversation with its full history.
- `attachments: [{path, type}]` passes images, videos, audio or documents.
- A send to an agent that is already running waits for it.

## agents(action, id?)

- `agents(action="list")` lists only what this conversation can reach, with status (`running` or
  `idle`) and visibility. An agent private to another conversation, or scoped to another
  workspace, is absent and cannot be driven.
- `agents(action="kill", id)` deletes the agent and its history for good. Its workspace directory
  is not touched.
- `agents(action="reset", id)` archives the history and starts fresh, keeping name, type and
  workspace directory.

## Example

```
spawn("code-explorer", "research", "session", "Map the codebase architecture")
send("subagent/code-explorer-a7b3", "Now analyze src/agent/ in detail")
send("subagent/code-explorer-a7b3", "What does this diagram show?", [{path: "/tmp/scan.png", type: "image"}])
agents(action="reset", id="subagent/code-explorer-a7b3")
agents(action="kill", id="subagent/code-explorer-a7b3")
```
