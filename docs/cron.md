# Cron / Scheduling

## Why

Scheduled tasks run without a user present. The agent executes on a timer and delivers output to a chat. This covers monitoring, reporting, and recurring check-ins.

## Decisions

### Origin is nullable

Jobs created via chat capture `origin` automatically. Jobs created manually (editing `~/.my-claw/cron/jobs.json`) have `origin: null`. This avoids inventing a fake `platform: "cli"` type and keeps the type system clean. When `origin` is null, `deliver` must be an explicit target (`telegram:chatId` or `matrix:roomId`).

### `deliver` is independent from `origin`

`origin` tracks where the job was created. `deliver` decides where output goes. They often match (`deliver: "origin"`) but separating them allows a job created in one chat to deliver elsewhere, and allows manual jobs with no origin to still have a delivery target.

### At-most-once execution

`nextRunAt` is advanced before the job runs. If the process crashes mid-execution, the job will not re-fire on restart. This prevents duplicate deliveries and runaway jobs. One-shot jobs are excluded from pre-advancement to allow retry.

### Tool restriction (`agentType: "cron"`)

Cron jobs get a filtered toolset. Excluded: `cron` (no recursive scheduling), `spawn/send/list_agents/kill_agent/reset_agent` (no sub-agents — they need user approval), `manage_skills` (no skill mutations), `memory` (would corrupt user representations without a user present).

### `[SILENT]` marker

The agent can suppress delivery by starting its response with `[SILENT]`. Output is still saved to `~/.my-claw/cron/output/` for audit. This avoids spam when a scheduled check finds nothing actionable.

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

### No file locking

Hermes uses `fcntl.flock` for cross-process tick isolation. MyClaw has one process. File locking is unnecessary.

### No pre-run scripts, no `context_from`

These Hermes features enable conditional execution and job chaining. Deferred to v2. The 95% use case is a simple prompt on a timer.

### `cron-parser` for expressions

Standard cron expressions (`0 9 * * 1`) are parsed by `cron-parser`. Custom syntax for intervals (`every 30m`) and one-shots (`2h`, ISO timestamps) is parsed manually. This covers all scheduling needs without exposing raw cron syntax to users who do not know it.

## Storage

- `~/.my-claw/cron/jobs.json` — atomic JSON writes
- `~/.my-claw/cron/output/{jobId}/{timestamp}.md` — execution history

## Security

Prompts are normalised with `normalizeUntrusted()` at creation and update time. Sub-agents cannot call the `cron` tool. See `docs/untrusted-content.md`.
