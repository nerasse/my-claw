# Cron / Scheduling

## Why

Scheduled tasks run without a user present. The agent executes on a timer and delivers output to a chat. This covers monitoring, reporting, and recurring check-ins.

## Decisions

### Origin is nullable

Jobs created via chat capture `origin` automatically. Jobs created manually (editing `~/.my-claw/cron/jobs.json`) have `origin: null`. This avoids inventing a fake `platform: "cli"` type and keeps the type system clean. When `origin` is null, `deliver` must be an explicit target (`my-claw-app:<owner>`, optionally `my-claw-app:<owner>:<threadId>`).

### `deliver` is independent from `origin`

`origin` tracks where the job was created. `deliver` decides where output goes. They often match (`deliver: "origin"`) but separating them allows a job created in one chat to deliver elsewhere, and allows manual jobs with no origin to still have a delivery target.

`deliver: "thread:<title>"` names a conversation instead: the owner's thread with that title, created
in the job's workspace when there is none, found by title otherwise. Resolved once, when the job is
created or updated, and stored as the thread's id, so renaming the thread later does not break the
job. It is how a family of jobs (every `career` job) lands in one place instead of the chat each was
created from.

### A delivery is written into the conversation

A delivery used to be a frame sent to whichever devices were connected: gone on reload, and never
there at all when the phone was asleep -- which is when a morning job delivers. Measured on
2026-09-27: four mail checks delivered to their thread, none of them in its history. The scheduler
now writes the result into the target conversation first (`journal`, wired in `index.ts`), the way a
sub-agent's handoff note is filed: a quiet `command` entry, shown on every reload. Then the frame
goes out for the devices that are online.

Since 2026-10-05 the entry is `prompt: true`: the conversation's agent reads it, so asked about the
report afterwards it knows what it said (owner's choice). It reaches the model as a user-role turn
marked as context ("Filed in this conversation, for context... Nothing to answer unless asked"),
the role a compaction summary arrives in, and it opens no run: a run is what `followUp` is for.
Filed while a run is in the middle of a turn, it is given after that turn's tool results
(`messagesOf`), never between a call and its result. Continue looks through it (`endsOnOwnText`,
`orphanCalls`): a report is not the model moving on.

### A delivery is a card, not the owner's bubble

The turn is `role: 'user'` because the prompt needs a turn in that role for the conversation's
agent to have read the report -- and it was *drawn* as one: a full-width bubble on the right, in
the same place and shape as something the owner typed, so a cron report read as the owner talking
to himself (owner, 2026-11-15).

The entry carries `cron: { job, cadence, status? }`, and the display turns it into
`from: { kind: 'cron', label, cadence, status }` -- the same marker a sub-agent's return wears
(`kind: 'return'`), which is what every reader that asks "is this the owner speaking?" already
consults. The app draws `components/CronDelivery.tsx`: the job's name, its cadence, the word for
what happened at the right, one line of preview, and the report one tap away. Folded by default,
because a morning job would otherwise push a screenful between two turns of the conversation.

A field on the existing `command` entry rather than an entry type of its own: the index encodes
types as bytes in a fixed order, so a new one is a file-format bump, and a server rolled back to
the previous release would skip the lines it cannot name -- losing the parent link of everything
filed past it. Deliveries written before the field existed carry only their quiet `cron delivery`
input and keep the plain bubble they have always had.

### The app's job editor sets the same fields

`jobs.save` carries `deliver` (`origin`, `local`, or `{ kind: "thread", title }`, the owner's
conversation of that title, created in the job's workspace if missing: the same lookup as
`deliver: "thread:<title>"`), `alertAfterMs`, `timeoutMs` (0 back to the install's) and
`conversations`. The listing sends the install's defaults beside the job's own, `hasOrigin`, and
`deliverKind` / `deliverThread` for the picker. Logic in `src/channels/my-claw-app/job-fields.ts`.

### Follow-up: the conversation acts on the report (`followUp`)

A delivered report is a note the model never reads: the career jobs found offers and logged mail,
and nothing happened until the owner opened the thread and asked (2026-10-04). With `followUp`, the
report becomes that conversation's next turn instead, so its own agent -- the orchestrator, in the
conversation's workspace, with everything that conversation has -- works on it.

- **One bubble.** The turn is `[Cron: <name>]`, the report, then the instruction, and it replaces the
  note: the run it opens writes it into the log, so nothing else is filed. Pictures the job produced
  still go out in a frame of their own, a turn carrying text only.
- **The same door as a sub-agent's hand-back** (`deliverOwnerTurn`): a conversation at rest opens a
  run, one with a run in flight takes it into that run's mailbox, exactly like a message the owner
  sends while it works. No second notion of a queued turn.
- **The instruction is the job's** (`followUpPrompt`), so a mail check and an offer watch can ask for
  different things. Absent, `DEFAULT_FOLLOW_UP` asks to act on the report in the conversation's
  workspace. The rules of that workspace (its AGENTS.md) still decide what may be done: a turn from a
  job is no more authority than one the owner typed.
- **Never lost.** A channel that refuses the turn (no adapter, no such thread) falls back to the
  note. A `[SILENT]` run hands nothing over, and a job delivering `local` has no conversation to hand
  to.
- **Off by default**, stored only when on (`true`), like `conversations`. The tool takes `follow_up`
  and `follow_up_prompt`, `cron list` prints it, and the app's job editor has the switch and the
  instruction.

### At-most-once execution

`nextRunAt` is advanced before the job runs. If the process crashes mid-execution, the job will not re-fire on restart. This prevents duplicate deliveries and runaway jobs. One-shot jobs are excluded from pre-advancement to allow retry.

### Tool restriction (`agentType: "cron"`)

Cron jobs get a filtered toolset. Never granted, whatever a job is configured with: `cron` (no
recursive scheduling), skill writes (no skill mutations: a job is handed `skills` read-only), `memory` (would corrupt user
representations without a user present), `workspaces` and `question` (there is nobody to ask). The
raw `browser_*` tools stay out too: the browser agent is reached through `delegate_browser_task`.

`conversation_search` used to be on that list, on the ground that a job has "no conversation to
search". That mistook the archive for the job's own history: the archive is global, and a job that
sends follow-ups needs exactly that -- was this one already sent from another conversation, was this
mail already handled. It is now a switch a job turns on (below).

### Capability switches (`subagents`, `browser`)

Two families sit behind a per-job switch rather than a hard exclusion, because a job is the
orchestrator's only stand-in when nobody is watching:

- `subagents` — `spawn`, `send`, `agents` (list, kill, reset). The whole family
together: a job that can start an agent but not list, steer or kill it leaves orphans it cannot
see.
- `browser` — `delegate_browser_task`.

That second family is the whole door: the browser agent is in `NOT_SPAWNABLE`
(`agents/registry.ts`), so `spawn` cannot reach it and turning the switch off really does deny the
browser rather than moving it one step away.

- `conversations` — `conversation_search`. The one switch that is **off** by default: a job that does
not need other conversations should not read them. `true` is the only value stored, and naming the
tool in the job's own `tools` list grants it as well. Security-wise it widens nothing a job could not
already reach (it has `bash` and can read the session files), so the default is about focus, not a
boundary.

`subagents` and `browser` are **granted unless the job turned them off** (`false`), so only `false`
is stored and an untouched job keeps a clean shape, exactly like `silent`. A job created before the switches
existed therefore keeps the browser it already had. The switch travels the same road as the scope
overrides — the scheduler sets `session.scopeCapabilities` from the job before the run, and the
bridge resolves it at the one place a run's tools are built (`getForAgent`) by withholding the
family's names. The job's own `tools` list still intersects whatever the switches leave, and the
`cron` tool takes `subagents`/`browser` arguments (`cron list` reports both per job). Both appear
in the app's job editor as two switches, since a job set up from the phone must be able to reach
them too.

### `[SILENT]` marker

The agent can suppress delivery by starting its response with `[SILENT]`. Output is still saved to `~/.my-claw/cron/output/` for audit. This avoids spam when a scheduled check finds nothing actionable.

### `silent` is a per-job setting, and it is not the marker

`job.silent` suppresses the job's **push notifications**, successes and failures alike. Delivery and
output are untouched: the result still lands where `deliver` says. The `[SILENT]` marker is the
opposite trade — a per-run decision by the agent that there is nothing to say at all, which skips
delivery. Two different questions, so two different switches:

| | notification | delivery |
| --- | --- | --- |
| `job.silent: true` | suppressed | kept |
| `[SILENT]` marker | suppressed | skipped |

Absent means notify, so an existing job keeps the behaviour it had. Failures honour it too: a
silent job that fails stays silent, which is the whole point for a job that runs every ten minutes.
Editable from the app (Jobs editor, Notify/Silent) and carried by the `jobs.save` frame.

### Jobs run side by side, never twice at once

Jobs used to run one after the other inside the tick. A long job held every other one up: on
2026-09-27 a thirty-minute research delayed the evening mail check, and giving the research the
hours it needs would have pushed the check out of its grace window, so it would have been skipped.

The tick now only dispatches: it advances each due job's `nextRunAt` and starts its run, and the run
goes on without holding the next tick. What stays exclusive is a job with itself. A run still going
when the job's next time comes makes that occurrence skip (logged, `nextRunAt` moves on); `trigger`
refuses a job that is running and says since when.

Two jobs of the same workspace can now overlap. Each run is told in its prompt which other job of
its workspace is running, and to re-read a file right before changing it with a targeted edit:
neither can see the other's edits coming, and that is what keeps one from writing over the other.

### A long run is announced, not stopped

The weekly research of 2026-09-27 died at the thirty-minute wall with six sub-agents mid-pass,
nothing written. A longer wall only moves that loss, and the reason for a wall at all -- a long job
held every other one up -- went away when jobs started running side by side. So by default there is
**no wall**: a run still going is announced, and the owner decides.

- `cron.alertAfter` (default `1h`) — the first push, "Still running after 3 h · 4 sub-agents
  working, 2 levels deep · $1.80. Open it to follow it or stop it." What the run is doing, not only
  how long, so a normal long job reads as one (docs/agent-roles.md). Its tap opens the run itself,
  where its Stop is.
- `cron.alertEvery` (default `1h`) — again at every interval while it goes: 3 h, 4 h, 5 h...
- A job's own `alert` (`cron create/update ... alert: "3h"`, stored as `alertAfterMs`) — above
  `cron.alertAfter`.
- Sent whatever `silent` says: a job that runs that long is the one the owner has to decide about.

A wall is still there for whoever wants one: `cron.timeoutMs` for the install, a job's own `timeout`
(at most 24 h). When one is set, the run is told first: at a tenth of its limit before the wall
(between one and ten minutes, never more than half the limit), the scheduler injects a wrap-up
message into the run **and into every live sub-agent under it**, through the same mailbox the owner
steers a run with. The sub-agents are the ones that matter: a parent waiting on them only reads its
mailbox once they return. The prompt states the limit, so the run plans to write down what matters
early. A run that hits the wall anyway is `interrupted`, not `error`, and so is a run the server lost
when it stopped (`runningSince` still set at boot).

A run stopped from the app is `interrupted` too, read off its own log. A run stopped or interrupted
can be picked back up from its thread with Continue (docs/continue.md).

A cron run's sub-agents have their own roles, not the cron role, and nest at most two deep: the run's
sub-agents, then the browser tasks they delegate (docs/agent-roles.md). The cost shown for a run is
its whole tree's.

- `cron.maxIterations` — overrides the tool-calling loop budget for cron runs.

### Every write of jobs.json is one load-change-write, in turn

The atomic write protects the file from being half written. It did nothing for two writers that
each loaded the file, changed their copy and wrote it back: the second write erased the first, and
both callers were told it worked. Two `cron` calls in one tool block did exactly that on 2026-09-26
(a create and an update lost, no error anywhere).

Every writer -- the tool, the app's job editor, the scheduler -- goes through `mutateJobs`, which
loads, applies the change and writes with nothing in between, one writer after the other. They all
live in one process, so an in-process queue is the whole lock; a file lock would add nothing a second
process could honour. A change that throws writes nothing.

The scheduler writes only what it owns, and only for the job it ran: the start mark before the run,
the run fields after it (`nextRunAt`, `lastRunAt`, `lastStatus`, `lastError`, `completedRuns`, and the
last run's start, duration, model and cost). Each write re-reads the file, so a pause or an edit the
owner typed while the run went on is still there after it.

A write that fails removes its temporary file (`atomic-write.ts`), and the temporaries of a writer
that died mid-write (`jobs.json.<pid>.<rand>.tmp`, the pid in the name) are removed at the first tick
when that pid is gone.

### What `cron list`, `create` and `update` show

Each job reads back as every setting its run will use -- model, effort, workspace, delivery, alert
time, time limit (`none` by default), scopes, switches, notifications -- then the run in flight if there is one, then the last run:
when it started, its status (`ok`, `error`, `interrupted`), how long it lasted, the model it ran on
once its tag resolved, and what it cost with its sub-agents (from the analytics the calls already
wrote; `>=` when only some calls were priced), with the error when there was one. `create` and
`update` answer with the same block, so a setting is checked without opening jobs.json. The app's
job list carries the same fields, additively; `interrupted` is folded into `error` in the field older
builds read.

### No pre-run scripts, no `context_from`

These Hermes features enable conditional execution and job chaining. Deferred to v2. The 95% use case is a simple prompt on a timer.

### `cron-parser` for expressions

Standard cron expressions (`0 9 * * 1`) are parsed by `cron-parser`. Custom syntax for intervals (`every 30m`) and one-shots (`2h`, ISO timestamps) is parsed manually. This covers all scheduling needs without exposing raw cron syntax to users who do not know it.

### Per-job scope overrides

A job can carry its own `skills`/`mcp`/`tools` lists, slotted above `agents.cron` at run time
exactly like its `model` override: the job's own choices win, an absent field inherits the cron
agent. The scope is stored in the config shape (absent = inherit, `["*"]` = all, `[]` = nothing,
else names) and reaches the run through the session, so no config section is written per job. The
`cron` tool sets it with `skills`/`mcp`/`tools` arguments (`inherit`, `all`/`*`, `none`, or
comma-separated names) and `cron list` reports it per job; a name that matches no live catalog is
flagged `removed: ...` instead of being refused — the job is the truth. `tools` is intersected
with the cron baseline, so a name outside it is dropped at run time.

## Storage

- `~/.my-claw/cron/jobs.json` — atomic JSON writes
- `~/.my-claw/cron/output/{jobId}/{timestamp}.md` — execution history

## Security

Prompts are normalised with `normalizeUntrusted()` at creation and update time. Sub-agents cannot call the `cron` tool. See `docs/untrusted-content.md`.
