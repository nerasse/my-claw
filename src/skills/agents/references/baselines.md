# Agent baselines

`base` picks the tool set the agent's `tools` field narrows from. A file can never grant
a tool its baseline does not carry — this is the invariant the whole design rests on.

## general (default)

The full registry minus the sub-agent management surface:

- All filesystem and web tools: `bash`, `read`, `write`, `fetch`, `find`, `grep`, `ls`
- Skill tool: `skills`, read-only (only the orchestrator writes skills)
- Voice tool: `audio` (transcribe, speak, mode)
- `web_search` (when configured), `delegate_browser_task`, `conversation_search`
- Dynamic tools: MCP servers in scope, plugin tools

Excluded: `spawn`, `send`, `agents`, `memory`, `cron`, `workspaces`, and the skill writes.

A general agent cannot delegate further: there is no `spawn` in its toolset.

## research (read-only)

A fixed allowlist, the safe default for anything that only reads:

`read`, `grep`, `find`, `ls`, `fetch`, `web_search`, `conversation_search`, `skills` (read-only) —
plus MCP servers explicitly granted by scope.

A research agent has no `bash`, no `write`, no delegation. If the owner needs a
researcher that also runs things, use `base: general` and narrow `tools` explicitly.
