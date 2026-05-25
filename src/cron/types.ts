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
  state: "scheduled" | "paused" | "completed" | "error";
  pausedReason?: string;
  origin: CronOrigin | null;
  deliver: CronDeliver;
  model?: string;
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
