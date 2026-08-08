export interface CronSchedule {
  kind: "cron" | "interval" | "once";
  expr?: string;
  minutes?: number;
  runAt?: string;
  display: string;
}

export interface CronOrigin {
  platform: "telegram" | "matrix";
  chatId: string;
  threadId?: string;
}

export interface CronDeliveryTarget {
  platform: "telegram" | "matrix";
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
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
  createdAt: string;
}

export interface CronJobsFile {
  jobs: CronJob[];
  updatedAt: string;
}
