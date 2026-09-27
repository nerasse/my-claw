import { join } from "node:path";
import { readFile, mkdir, writeFile, rename, readdir, unlink } from "node:fs/promises";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import type { CronJob, CronJobsFile, CronSchedule, CronOrigin, CronDeliver, CronRunStatus } from "./types.ts";
import { CronExpressionParser } from "cron-parser";

const CRON_DIR = join(MY_CLAW_DIR, "cron");
const JOBS_FILE = join(CRON_DIR, "jobs.json");
const OUTPUT_DIR = join(CRON_DIR, "output");

const EVERY_RE = /^every\s+(\d+)\s*(m|min|mins?|minutes?|h|hr|hrs?|hours?|d|days?)$/i;
const DURATION_RE = /^(\d+)\s*(m|min|mins?|minutes?|h|hr|hrs?|hours?|d|days?)$/i;
const CRON_RE = /^([\d*,/\-]+\s+){4}[\d*,/\-]+$/;

function parseDurationMinutes(value: string, unit: string): number {
  const n = parseInt(value, 10);
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return n * 60;
  if (u.startsWith("d")) return n * 1440;
  return n;
}

export function parseSchedule(input: string): CronSchedule {
  const trimmed = input.trim();

  const everyMatch = EVERY_RE.exec(trimmed);
  if (everyMatch) {
    const minutes = parseDurationMinutes(everyMatch[1]!, everyMatch[2]!);
    return { kind: "interval", minutes, display: trimmed };
  }

  if (CRON_RE.test(trimmed)) {
    CronExpressionParser.parse(trimmed);
    return { kind: "cron", expr: trimmed, display: trimmed };
  }

  if (trimmed.includes("T") || /^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const date = new Date(trimmed);
    if (isNaN(date.getTime())) throw new Error(`Invalid date: ${trimmed}`);
    return { kind: "once", runAt: date.toISOString(), display: `once at ${trimmed}` };
  }

  const durationMatch = DURATION_RE.exec(trimmed);
  if (durationMatch) {
    const minutes = parseDurationMinutes(durationMatch[1]!, durationMatch[2]!);
    const runAt = new Date(Date.now() + minutes * 60_000).toISOString();
    return { kind: "once", runAt, display: `once in ${trimmed}` };
  }

  throw new Error(`Cannot parse schedule: "${trimmed}". Use cron expr, "every Xm/h/d", ISO timestamp, or bare duration.`);
}

/** A job's own limit is capped: a run that needs more than a day is a loop, not a long job. */
export const MAX_JOB_TIMEOUT_MS = 24 * 60 * 60_000;
const MIN_JOB_TIMEOUT_MS = 60_000;

/** `90m`, `3h`, `1d`: a job's own wall-clock limit, in the schedule grammar's units. */
export function parseJobTimeout(input: string): number {
  const match = DURATION_RE.exec(input.trim());
  if (!match) throw new Error(`Cannot parse timeout: "${input}". Use a duration like "45m", "3h" or "1d".`);
  const ms = parseDurationMinutes(match[1]!, match[2]!) * 60_000;
  if (ms < MIN_JOB_TIMEOUT_MS) throw new Error("A job timeout under one minute would stop every run before it started.");
  if (ms > MAX_JOB_TIMEOUT_MS) throw new Error("A job timeout is capped at 24h: a run that needs more is a loop, not a long job.");
  return ms;
}

export function computeNextRun(schedule: CronSchedule, lastRunAt?: string): string | null {
  const now = new Date();

  switch (schedule.kind) {
    case "once":
      if (lastRunAt) return null;
      return schedule.runAt ?? null;

    case "interval": {
      const base = lastRunAt ? new Date(lastRunAt) : now;
      return new Date(base.getTime() + (schedule.minutes ?? 0) * 60_000).toISOString();
    }

    case "cron": {
      const base = lastRunAt ? new Date(lastRunAt) : now;
      const interval = CronExpressionParser.parse(schedule.expr!, { currentDate: base });
      return interval.next().toISOString();
    }
  }
}

function getSchedulePeriodMs(schedule: CronSchedule): number {
  if (schedule.kind === "interval") return (schedule.minutes ?? 60) * 60_000;
  if (schedule.kind === "cron") {
    try {
      const interval = CronExpressionParser.parse(schedule.expr!);
      const next1 = interval.next().getTime();
      const next2 = interval.next().getTime();
      return next2 - next1;
    } catch {
      return 60 * 60_000;
    }
  }
  return 60 * 60_000;
}

const MAX_GRACE_MS = 2 * 60 * 60_000;

export function getDueJobs(jobs: CronJob[]): CronJob[] {
  const now = Date.now();
  return jobs.filter((job) => {
    if (!job.enabled || job.state !== "scheduled" || !job.nextRunAt) return false;
    const dueAt = new Date(job.nextRunAt).getTime();
    if (dueAt > now) return false;

    if (job.schedule.kind !== "once") {
      const overdueMs = now - dueAt;
      const periodMs = getSchedulePeriodMs(job.schedule);
      const graceMs = Math.min(Math.max(periodMs / 2, 120_000), MAX_GRACE_MS);
      if (overdueMs > graceMs) {
        job.nextRunAt = computeNextRun(job.schedule, new Date().toISOString());
        return false;
      }
    }

    return true;
  });
}

export function advanceNextRun(job: CronJob): void {
  if (job.schedule.kind !== "once") {
    job.nextRunAt = computeNextRun(job.schedule, new Date().toISOString());
  }
}

export function markJobRun(job: CronJob, status: CronRunStatus, error?: string): void {
  job.lastRunAt = new Date().toISOString();
  job.lastStatus = status;
  job.lastError = error ?? null;
  job.completedRuns += 1;
  delete job.runningSince;

  if (job.repeat !== null && job.completedRuns >= job.repeat) {
    job.state = "completed";
    job.enabled = false;
    job.nextRunAt = null;
    return;
  }

  if (job.schedule.kind !== "once") {
    job.nextRunAt = computeNextRun(job.schedule, job.lastRunAt);
  } else {
    job.nextRunAt = null;
    if (job.repeat === null || job.completedRuns >= (job.repeat ?? 1)) {
      job.state = "completed";
      job.enabled = false;
    }
  }
}

export function parseDeliver(input: string, origin: CronOrigin | null): CronDeliver {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "origin") {
    if (!origin) throw new Error("Cannot use 'origin' delivery without an origin chat. Specify a target: 'my-claw-app:owner'.");
    return "origin";
  }
  if (trimmed === "local") return "local";

  const parts = trimmed.split(":");
  if (parts.length < 2) throw new Error(`Invalid deliver target: "${input}". Use 'origin', 'local', or 'platform:chatId'.`);

  const platform = parts[0];
  if (platform !== "my-claw-app") {
    throw new Error(`Unknown platform: "${platform}". Use 'my-claw-app'.`);
  }

  const chatId = parts[1]!;
  const threadId = parts[2];
  return { platform, chatId, threadId };
}

export interface CreateJobParams {
  name?: string;
  prompt: string;
  schedule: string;
  origin: CronOrigin | null;
  deliver?: string;
  model?: string;
  /** The job's own effort pin, the sibling of `model`; an empty string means none. */
  effort?: import("../core/config.ts").EffortLevel | "";
  /** Key of the workspace this job runs in (config.workspaces); absent = the default. */
  workspace?: string;
  skills?: string[];
  mcp?: string[];
  tools?: string[];
  /** The job's capability switches; `false` withholds the family, `true` clears the flag back
   *  to granted. Absent on update means "don't touch". */
  subagents?: boolean;
  browser?: boolean;
  /** Suppresses the job's push notifications; delivery and output are untouched. */
  silent?: boolean;
  /** The job's own wall-clock limit, in ms (see parseJobTimeout). */
  timeoutMs?: number;
}

export function createJob(params: CreateJobParams): CronJob {
  const schedule = parseSchedule(params.schedule);
  const deliver = parseDeliver(params.deliver ?? "origin", params.origin);
  const repeat = schedule.kind === "once" ? 1 : null;

  return {
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    name: params.name ?? params.prompt.slice(0, 50).trim(),
    prompt: params.prompt,
    schedule,
    repeat,
    completedRuns: 0,
    enabled: true,
    state: "scheduled",
    origin: params.origin,
    deliver,
    model: params.model,
    effort: params.effort || undefined,
    workspace: params.workspace,
    ...(params.skills ? { skills: params.skills } : {}),
    ...(params.mcp ? { mcp: params.mcp } : {}),
    ...(params.tools ? { tools: params.tools } : {}),
    // Absent rather than true: granted is the default, and an untouched job keeps a clean shape.
    ...(params.subagents === false ? { subagents: false } : {}),
    ...(params.browser === false ? { browser: false } : {}),
    // Absent rather than false: notifying is the default, and an untouched job keeps a clean shape.
    ...(params.silent ? { silent: true } : {}),
    ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    nextRunAt: computeNextRun(schedule),
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: new Date().toISOString(),
  };
}

export interface UpdateJobParams {
  name?: string;
  prompt?: string;
  model?: string;
  /** The job's own effort pin; an empty string clears it, exactly like `workspace`. */
  effort?: import("../core/config.ts").EffortLevel | "";
  enabled?: boolean;
  deliver?: string;
  schedule?: string;
  workspace?: string;
  skills?: string[];
  mcp?: string[];
  tools?: string[];
  /** The job's capability switches; absent means "don't touch", like `silent`. */
  subagents?: boolean;
  browser?: boolean;
  /** Suppresses the job's push notifications; delivery and output are untouched. */
  silent?: boolean;
  /** The job's own limit in ms; 0 clears it back to cron.timeoutMs. */
  timeoutMs?: number;
}

export function updateJob(jobs: CronJob[], jobId: string, updates: UpdateJobParams): CronJob | null {
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return null;

  if (updates.name !== undefined) job.name = updates.name;
  if (updates.prompt !== undefined) job.prompt = updates.prompt;
  if (updates.model !== undefined) job.model = updates.model;
  if (updates.effort !== undefined) job.effort = updates.effort || undefined;
  if (updates.enabled !== undefined) {
    job.enabled = updates.enabled;
    job.state = updates.enabled ? "scheduled" : "paused";
    // Re-arming a job that completed leaves nextRunAt at null (markJobRun clears it), which
    // getDueJobs would read as "never due" forever. Same re-arm the resume path does.
    if (updates.enabled && job.nextRunAt === null) {
      job.nextRunAt = computeNextRun(job.schedule, job.lastRunAt ?? undefined);
    }
  }
  if (updates.deliver !== undefined) {
    job.deliver = parseDeliver(updates.deliver, job.origin);
  }
  if (updates.workspace !== undefined) job.workspace = updates.workspace || undefined;
  if (updates.skills !== undefined) job.skills = updates.skills;
  if (updates.mcp !== undefined) job.mcp = updates.mcp;
  if (updates.tools !== undefined) job.tools = updates.tools;
  // Inverted versus `silent`, and it is on purpose: granted is the default here, so granting is
  // what leaves no trace. `false` is the only value ever stored.
  if (updates.subagents !== undefined) job.subagents = updates.subagents === false ? false : undefined;
  if (updates.browser !== undefined) job.browser = updates.browser === false ? false : undefined;
  if (updates.silent !== undefined) job.silent = updates.silent || undefined;
  if (updates.timeoutMs !== undefined) {
    if (updates.timeoutMs > 0) job.timeoutMs = updates.timeoutMs;
    else delete job.timeoutMs;
  }
  if (updates.schedule !== undefined) {
    job.schedule = parseSchedule(updates.schedule);
    job.nextRunAt = computeNextRun(job.schedule, job.lastRunAt ?? undefined);
  }

  return job;
}

export function removeJob(jobs: CronJob[], jobId: string): boolean {
  const idx = jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return false;
  jobs.splice(idx, 1);
  return true;
}

/** A read. The file is only ever replaced by rename, so a read sees a whole version, never half. */
export async function loadJobs(): Promise<CronJob[]> {
  try {
    const raw = await readFile(JOBS_FILE, "utf-8");
    const data = JSON.parse(raw) as CronJobsFile;
    return data.jobs ?? [];
  } catch {
    return [];
  }
}

async function writeJobs(jobs: CronJob[]): Promise<void> {
  const data: CronJobsFile = { jobs, updatedAt: new Date().toISOString() };
  await writeJsonFileAtomically(JOBS_FILE, data, true);
}

/**
 * Every write of jobs.json, one after another.
 *
 * The atomic write protects a file from being half written; it does nothing for two writers that
 * each loaded the file, changed their copy and wrote it back -- the second write erases the first,
 * and both callers were told it worked. Two `cron` calls in one tool block did exactly that on
 * 2026-09-26: a create and an update lost, no error anywhere. Every writer is in this process (the
 * tool, the app's job editor, the scheduler), so a queue is the whole lock: no file lock would add
 * anything a second process could honour.
 */
let jobsQueue: Promise<unknown> = Promise.resolve();

function serialised<T>(work: () => Promise<T>): Promise<T> {
  const turn = jobsQueue.then(work, work);
  jobsQueue = turn.catch(() => undefined);
  return turn;
}

/**
 * Load, change, write, with nothing in between: the one way to modify jobs.json. `change` must not
 * call back into this module's writers -- it would wait for its own turn forever. Throwing from it
 * writes nothing.
 */
export function mutateJobs<T>(change: (jobs: CronJob[]) => T | Promise<T>): Promise<T> {
  return serialised(async () => {
    const jobs = await loadJobs();
    const result = await change(jobs);
    await writeJobs(jobs);
    return result;
  });
}

/** Replaces the whole list, in turn with every other writer. */
export function saveJobs(jobs: CronJob[]): Promise<void> {
  return serialised(() => writeJobs(jobs));
}

const ORPHAN_TMP_RE = /^jobs\.json\.(\d+)\.[a-z0-9]+\.tmp$/;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The temporary files of writes a dead process never finished. The name carries the writer's pid,
 * so only files whose writer is gone are touched: a write still in flight, here or in a dev server
 * sharing the directory, keeps its file.
 */
export async function cleanupOrphanJobTemps(): Promise<number> {
  let names: string[];
  try {
    names = await readdir(CRON_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = ORPHAN_TMP_RE.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processAlive(pid)) continue;
    try {
      await unlink(join(CRON_DIR, name));
      removed++;
    } catch {
      // Gone already, or not ours to remove: either way nothing is left to do.
    }
  }
  return removed;
}

/**
 * A run that was in flight when the server went down never wrote its end. At boot its job still
 * says `runningSince`, and nothing else would ever tell the owner the run was lost: the job looked
 * fine until its next run. Called once, before the first tick.
 */
export async function recoverInterruptedRuns(now: Date = new Date()): Promise<string[]> {
  return mutateJobs((jobs) => {
    const recovered: string[] = [];
    for (const job of jobs) {
      if (!job.runningSince) continue;
      job.lastStartedAt = job.runningSince;
      job.lastRunAt = now.toISOString();
      job.lastDurationMs = Math.max(0, now.getTime() - new Date(job.runningSince).getTime());
      job.lastStatus = "interrupted";
      job.lastError = "The server stopped during this run; its result was lost.";
      delete job.runningSince;
      recovered.push(job.id);
    }
    return recovered;
  });
}

export async function saveJobOutput(jobId: string, output: string): Promise<void> {
  const dir = join(OUTPUT_DIR, jobId);
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${ts}.md`);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, output);
  await rename(tmp, path);
}
