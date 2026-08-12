# Agent baselines

`base` picks the tool set the agent's `tools` field narrows from. A file can never grant
a tool its baseline does not carry — this is the invariant the whole design rests on.

## general (default)

The full registry minus the sub-agent management surface:

- All filesystem and web tools: `bash`, `read`, `write`, `fetch`, `find`, `grep`, `ls`
- Skill tools: `list_skills`, `read_skill`
- Voice tools: `stt`, `tts`, `voice_mode`
- `web_search` (when configured), `delegate_browser_task`, `conversation_search`
- Dynamic tools: MCP servers in scope, plugin tools

Excluded: `spawn`, `send`, `list_agents`, `kill_agent`, `reset_agent`, `manage_skills`,
`memory`, `cron`, `workspaces`.

A general agent cannot delegate further: there is no `spawn` in its toolset.

## research (read-only)

A fixed allowlist, the safe default for anything that only reads:

`read`, `grep`, `find`, `ls`, `fetch`, `web_search`, `conversation_search`, `list_skills`,
`read_skill` — plus MCP servers explicitly granted by scope.

A research agent has no `bash`, no `write`, no delegation. If the owner needs a
researcher that also runs things, use `base: general` and narrow `tools` explicitly.
