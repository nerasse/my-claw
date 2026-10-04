# Tool approvals: asking before a tool runs

The owner names tools the agent must ask about before each run; the app shows the request and the
answer goes back (`approval.request` / `approval.response`, docs/my-claw-app-channel.md). Every
outcome is journalled (`~/.my-claw/approvals.db`) and listed with the tools.

## Where it is set

Settings → Tools, per tool: "Ask before running" (owner, 2026-10-04: the page used to be a Security
row of its own, an history for a feature the app could not turn on). The switch sends
`tools.confirm {name, confirm}`; `tools.list.result` carries `confirm` per tool.

## What it writes

`setToolConfirm` (`src/core/config-edit.ts`):

- the name goes into, or out of, the top-level `blacklist` (hot: `ToolApprovalManager` holds the
  array the watcher refills in place);
- asking also sets `channels["my-claw-app"].approvals: true`. With approvals off, a listed tool is
  refused instead of asked (`adapter.ts`, `confirmTool`), and the switch the owner just turned on
  would read as "never run it". Turning the last one off leaves approvals on: with an empty list it
  asks nothing.
