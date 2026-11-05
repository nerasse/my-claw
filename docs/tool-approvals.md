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
- asking also sets `channels["my-claw-app"].approvals: true` (through `enableToolApprovals`, idempotent).
  With approvals off, a listed tool is refused instead of asked (`adapter.ts`, `confirmTool`), and
  the switch the owner just turned on would read as "never run it". Turning the last one off leaves
  approvals on: with an empty list it asks nothing. The same helper backs Settings → Nodes → "Ask
  before running", which is a switch of the same kind (docs/remote-nodes.md).

## Who the prompt reaches

A prompt is a question to the owner, so it names the conversation the human is looking at, never the
session that raised it. A tool of a sub-agent -- every tool of a node whose record asks -- carries
the **parent's** thread (`SubAgentRunner` builds its message from the parent's), and the runner hands
the injected approval handler to each sub-agent bridge it builds: without that handler the manager
answers `deny` on sight, and the run reports "denied by approval policy" with nothing ever shown.

`adapter.ts` emits `approval:requested` once the sheet is on the owner's windows; the entry point
publishes a push for it, skipping a device already foreground on that thread. The tap opens the
conversation holding the sheet.
