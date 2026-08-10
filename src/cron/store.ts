import { join } from "node:path";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { MY_CLAW_DIR } from "../core/config.ts";
import { writeJsonFileAtomically } from "../utils/atomic-write.ts";
import { log } from "../utils/logger.ts";
import type { CronJob, CronJobsFile, CronSchedule, CronOrigin, CronDeliver } from "./types.ts";
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

export function markJobRun(job: CronJob, success: boolean, error?: string): void {
  job.lastRunAt = new Date().toISOString();
  job.lastStatus = success ? "ok" : "error";
  job.lastError = error ?? null;
  job.completedRuns += 1;

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
    if (!origin) throw new Error("Cannot use 'origin' delivery without an origin chat. Specify a target: 'telegram:chatId' or 'matrix:roomId'.");
    return "origin";
  }
  if (trimmed === "local") return "local";

  const parts = trimmed.split(":");
  if (parts.length < 2) throw new Error(`Invalid deliver target: "${input}". Use 'origin', 'local', or 'platform:chatId'.`);

  const platform = parts[0] as "telegram" | "matrix";
  if (platform !== "telegram" && platform !== "matrix") {
    throw new Error(`Unknown platform: "${platform}". Use 'telegram' or 'matrix'.`);
  }

  if (platform === "matrix") {
    const chatId = parts.slice(1).join(":");
    return { platform, chatId };
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
  /** Suppresses the job's push notifications; delivery and output are untouched. */
  silent?: boolean;
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
    // Absent rather than false: notifying is the default, and an untouched job keeps a clean shape.
    ...(params.silent ? { silent: true } : {}),
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
  /** Suppresses the job's push notifications; delivery and output are untouched. */
  silent?: boolean;
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
  if (updates.silent !== undefined) job.silent = updates.silent || undefined;
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

export async function loadJobs(): Promise<CronJob[]> {
  try {
    const raw = await readFile(JOBS_FILE, "utf-8");
    const data = JSON.parse(raw) as CronJobsFile;
    return data.jobs ?? [];
  } catch {
    return [];
  }
}

export async function saveJobs(jobs: CronJob[]): Promise<void> {
  const data: CronJobsFile = { jobs, updatedAt: new Date().toISOString() };
  await writeJsonFileAtomically(JOBS_FILE, data, true);
}

/**
 * A tick can run for a long time (jobs up to cron.timeoutMs). Writing the whole in-memory array
 * back at the end would clobber any create/update/pause/remove the agent or user performed via the
 * cron tool meanwhile. Instead, re-load the current file and merge ONLY the scheduling/run fields
 * by id, so concurrent structural edits survive. Jobs removed concurrently are left removed.
 */
export async function persistJobRunUpdates(updated: CronJob[]): Promise<void> {
  const current = await loadJobs();
  const byId = new Map(current.map((j) => [j.id, j]));
  let changed = false;
  for (const job of updated) {
    const target = byId.get(job.id);
    if (!target) continue;
    target.nextRunAt = job.nextRunAt;
    target.lastRunAt = job.lastRunAt;
    target.lastStatus = job.lastStatus;
    target.lastError = job.lastError;
    target.completedRuns = job.completedRuns;
    target.state = job.state;
    target.enabled = job.enabled;
    target.pausedReason = job.pausedReason;
    changed = true;
  }
  if (changed) await saveJobs(current);
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
