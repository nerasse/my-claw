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
  asks nothing. A remote node does not depend on that flag: a machine asks before every call from
  its pairing on, and its prompts are raised whether approvals are on or not (docs/remote-nodes.md).

## Who the prompt reaches

A prompt is a question to the owner, so it names the conversation the human is looking at, never the
session that raised it. A tool of a sub-agent -- by default every tool of a node -- carries
the **parent's** thread (`SubAgentRunner` builds its message from the parent's), and the runner hands
the injected approval handler to each sub-agent bridge it builds: without that handler the manager
answers `deny` on sight, and the run reports "denied by approval policy" with nothing ever shown.

`adapter.ts` emits `approval:requested` once the sheet is on the owner's windows; the entry point
publishes a push for it, skipping a device already foreground on that thread. The tap opens the
conversation holding the sheet.

## The page

The app's drawer has one entry for every prompt of the install (`Approvals`), three tabs:

- **Waiting**: every pending prompt, grouped by machine (`this machine`, then each node), with
  machine and tool filters, how long it has been waiting, and the four decisions inline. The
  sheet still exists for the prompt you are looking at; the page is for the ones you are not.
- **History**: the journal, unchanged.
- **Always allowed**: the standing grants, with a `withdraw` per row. A node's own page in Settings
  ("Allowed for good") shows the same list narrowed to that machine.

The drawer badges the entry with the pending count, so a queue is visible without opening it.

## Standing grants ("always allow this exact call")

A fourth decision, offered on every prompt: `allow-always`. It writes one entry into
`tools.alwaysAllow` (`src/core/config-edit.ts`, `setApprovalGrant`):

```json
"tools": { "alwaysAllow": [ { "tool": "bash", "origin": "local", "args": "{\"command\":\"df -h\"}" } ] }
```

- `args` is the **canonical** JSON of the call's own arguments (keys sorted at every depth), so a
  model that writes the same object in another order still matches.
- `origin` is `local` or a node id. A grant given on this machine never runs on a node, and two
  nodes never share one: the owner approved a call on a machine, not a shape of call everywhere.
  Revoking a node drops its grants (`clearApprovalGrantsForOrigin`), because a permission that
  names a machine which no longer exists is not a permission; the journal keeps the record.
- `ToolApprovalManager.decide` reads it live, after the session cache and before the prompt, and
  journals the automatic pass as `allow-always` with `auto: true`.
- Withdrawing one takes effect on the next call: the grant is only ever read, never cached.

## The agent asking (`approval` tool)

The orchestrator has one tool, `approval`, with three actions:

- `request { what, tool?, command?, args? }`: asks the owner on purpose and **waits with no
  timer**. That is the one place a prompt does not expire: the run chose to wait, so a timeout
  would be the machine answering "no" for him. Stop cancels it, and a typed message cancels it
  the way a question is. Returns `approved`, `approved-always`, `denied` or a cancel.
- `list`: everything still waiting, across conversations and machines, for the orchestrator to
  tell a blocked sub-agent from a hung one.
- `grants { origin? }`: what already runs without asking, per machine. It answers the question a
  planner actually has before it starts: on this node, does every call open a prompt, and which
  exact calls go straight through. Read-only by design -- a model that could write a grant would
  make the gate decorative.

A machine's line carries both halves of that answer, because either one asks: what the global
`blacklist` names (it catches a node's tool of the same name), and a node's own "ask before
running" flag, which asks for every call. A node that is no longer paired has no grants left --
revocation drops them -- so the `inert` case only shows for a grant written by hand into a config
whose node was already gone.

The output repeats the one rule a reader must not have to rediscover: a grant matches the call's
canonical arguments key for key, so the same command with one extra argument asks again. Arguments
longer than 300 characters are cut on the line and say where the full call lives.

`origin` takes `local`, a node's id or its display name, case-insensitively: the name is what the
owner says and what the sheet shows. An unknown one is an error listing the known machines, never
an empty answer that reads like "nothing allowed here".

Automatic gates keep their two-minute timeout: a run nobody answers must not hold a session
forever. The tool is main-only (not a sub-agent, not cron) and never answers on the owner's
behalf.

The sheet itself comes from the app adapter: it installs the tool's surface when it starts and
drops it when it stops, the same way it does for `question`. The channel's `approvals` flag is
not consulted on this path. It governs the blacklist gate ("a listed tool is refused instead of
asked"); an explicit ask opens no gate, the agent chose to wait, so the sheet is the answer.
With no device connected the tool says so and returns an error -- nothing was asked, and that is
not a refusal.

The skill `approvals` teaches when to ask, what a grant covers, and that one yes per decision is
enough.
