export interface CronSchedule {
  kind: "cron" | "interval" | "once";
  expr?: string;
  minutes?: number;
  runAt?: string;
  display: string;
}

export type CronPlatform = "my-claw-app";

export interface CronOrigin {
  platform: CronPlatform;
  chatId: string;
  threadId?: string;
}

export interface CronDeliveryTarget {
  platform: CronPlatform;
  chatId: string;
  threadId?: string;
}

export type CronDeliver = "origin" | "local" | CronDeliveryTarget;

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  schedule: CronSchedule;
  repeat: number | null;
  completedRuns: number;
  enabled: boolean;
  state: "scheduled" | "paused" | "completed";
  pausedReason?: string;
  origin: CronOrigin | null;
  deliver: CronDeliver;
  model?: string;
  // The job's own effort pin, the sibling of `model`: slotted above agents.cron exactly like it.
  // Only a tag referenced by `model` or a session-level /effort outranks it (docs/agent-model.md).
  effort?: import("../core/config.ts").EffortLevel;
  /** Key of the workspace this job runs in (config.workspaces). Absent = the default
   *  workspace. A key that leaves the config pauses the job: it must never run silently
   *  in the wrong workspace. See docs/multi-workspace.md. */
  workspace?: string;
  /** Per-job scope overrides, in the resolver's own vocabulary (the config shape: absent =
   *  inherited, `["*"]` = all, `[]` = nothing, else names). Slotted above `agents.cron`,
   *  the same way the job's model overrides the cron agent's. */
  skills?: string[];
  mcp?: string[];
  tools?: string[];
  /**
   * The capability switches. Absent means granted: a job created before them keeps what it had
   * (the browser), and the owner asked for sub-agents by default. `false` is stored, `true` never
   * is, so an untouched job keeps a clean shape -- like `silent`. See docs/cron.md.
   */
  subagents?: boolean;
  browser?: boolean;
  /**
   * The conversation archive (`conversation_search`), the one switch that is off by default. The
   * archive is global, so a job can check what another conversation already sent before sending it
   * again. Only `true` is stored. Naming the tool in `tools` grants it too. See docs/cron.md.
   */
  conversations?: true;
  /**
   * Suppresses this job's push notifications, successes and failures alike. Absent = notify,
   * so an existing job keeps the behaviour it had. Distinct from the agent's own SILENT_MARKER,
   * which is a per-run decision ("nothing to report"): this one is the user's standing choice
   * for a job whose every run would otherwise ring.
   */
  silent?: boolean;
  /**
   * This job's own wall-clock limit, above `cron.timeoutMs`. A weekly research that fans out to six
   * sub-agents needs hours; a mail check that takes that long is stuck. One global wall could not
   * say both (2026-09-27: the weekly job was killed at thirty minutes with six sub-agents mid-pass).
   */
  timeoutMs?: number;
  nextRunAt: string | null;
  /** When the last run ended. */
  lastRunAt: string | null;
  /**
   * `interrupted` is a run that did not end on its own: the wall-clock limit, or the server going
   * down under it. Neither is the agent failing, and a job that times out needs a longer limit, not
   * a fix to its prompt. The app wire folds it into `error` (docs/cron.md).
   */
  lastStatus: CronRunStatus | null;
  lastError: string | null;
  /** When the last run started, how long it lasted, and what it ran on once the tag resolved. */
  lastStartedAt?: string;
  lastDurationMs?: number;
  lastModel?: string;
  /**
   * What the last run cost, its sub-agents included. Absent when no call of the run was priced;
   * `lastCostPartial` when only some were, so the figure is a floor and says so.
   */
  lastCostUsd?: number;
  lastCostPartial?: boolean;
  /**
   * Set while a run is in flight and cleared when it ends, so a run the server lost when it went
   * down is recognised at the next boot instead of leaving the job looking fine (docs/cron.md).
   */
  runningSince?: string;
  createdAt: string;
}

export type CronRunStatus = "ok" | "error" | "interrupted";

export interface CronJobsFile {
  jobs: CronJob[];
  updatedAt: string;
}
