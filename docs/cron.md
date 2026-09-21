# Cron / Scheduling

## Why

Scheduled tasks run without a user present. The agent executes on a timer and delivers output to a chat. This covers monitoring, reporting, and recurring check-ins.

## Decisions

### Origin is nullable

Jobs created via chat capture `origin` automatically. Jobs created manually (editing `~/.my-claw/cron/jobs.json`) have `origin: null`. This avoids inventing a fake `platform: "cli"` type and keeps the type system clean. When `origin` is null, `deliver` must be an explicit target (`my-claw-app:<owner>`, optionally `my-claw-app:<owner>:<threadId>`).

### `deliver` is independent from `origin`

`origin` tracks where the job was created. `deliver` decides where output goes. They often match (`deliver: "origin"`) but separating them allows a job created in one chat to deliver elsewhere, and allows manual jobs with no origin to still have a delivery target.

### At-most-once execution

`nextRunAt` is advanced before the job runs. If the process crashes mid-execution, the job will not re-fire on restart. This prevents duplicate deliveries and runaway jobs. One-shot jobs are excluded from pre-advancement to allow retry.

### Tool restriction (`agentType: "cron"`)

Cron jobs get a filtered toolset. Never granted, whatever a job is configured with: `cron` (no
recursive scheduling), `manage_skills` (no skill mutations), `memory` (would corrupt user
representations without a user present), `conversation_search` (nothing to search), `workspaces`
and `question` (there is nobody to ask). The raw `browser_*` tools stay out too: the browser agent
is reached through `delegate_browser_task`, one task at a time on the one shared Chromium.

### Capability switches (`subagents`, `browser`)

Two families sit behind a per-job switch rather than a hard exclusion, because a job is the
orchestrator's only stand-in when nobody is watching:

- `subagents` — `spawn`, `send`, `list_agents`, `kill_agent`, `reset_agent`. The whole family
together: a job that can start an agent but not list, steer or kill it leaves orphans it cannot
see.
- `browser` — `delegate_browser_task`.

Both are **granted unless the job turned them off** (`false`), so only `false` is stored and an
untouched job keeps a clean shape, exactly like `silent`. A job created before the switches
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

### Sequential execution

Hermes uses a ThreadPoolExecutor for parallel cron jobs. MyClaw runs them sequentially. Rationale: Bun is single-threaded; the overhead of parallelism is not worth the complexity for a single-tenant bot. If a job is slow, it blocks the tick — acceptable for personal use.

### Safety net for heavy jobs

Because a slow job blocks the tick, a runaway job (e.g. an agent stuck in a loop) could stall all
scheduling. Two config knobs cap that without getting in the way of legitimately long work:

- `cron.timeoutMs` — hard wall-clock limit per job; on expiry the run is aborted (`router.stop`) and
  the job is marked failed. Default is deliberately long (30 min) so heavy/voluminous jobs (deep
  research, many sub-agents) can finish; it only kills genuine runaways.
- `cron.maxIterations` — overrides the tool-calling loop budget for cron runs (defaults to the
  orchestrator's 90). Raise it for jobs that legitimately need many steps.

### Fresh session per run

Every run creates a session `cron/<jobId>/<runId>` seeded with the job's model and workspace
key, and deletes it when the run ends. One run never inherits the history of the previous one,
and a change of workspace or model applies to the very next run. The durable record is the job
state (`lastStatus`, `lastError`, `lastRunAt`) and the output store, not the session. A job
whose `workspace` key left `config.workspaces` is paused with a `pausedReason` instead of
running silently in the default workspace. See `docs/multi-workspace.md`.

### No file locking

Hermes uses `fcntl.flock` for cross-process tick isolation. MyClaw has one process. File locking is unnecessary.

One process, but not one moment: a tick runs for as long as its jobs do (up to `cron.timeoutMs`),
and the owner can pause, edit or remove a job through the tool while it runs. So the write at the
end of a tick re-reads the file and merges by id rather than dumping the array it loaded.

The scheduling and run fields (`nextRunAt`, `lastRunAt`, `lastStatus`, `lastError`,
`completedRuns`) always belong to the tick. The lifecycle ones (`state`, `enabled`,
`pausedReason`) only get written when **the tick itself moved them**, which is what
`snapshotLifecycle` is taken for: a job paused while a long tick ran used to come back enabled,
because the tick's copy predated the pause and won. A pause the tick decides -- an unreadable
schedule, a workspace that left the config -- still lands, because that one really did change
under the tick's hand.

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
