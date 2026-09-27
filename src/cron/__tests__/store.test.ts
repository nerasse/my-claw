import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import {
  parseSchedule,
  computeNextRun,
  createJob,
  getDueJobs,
  markJobRun,
  parseDeliver,
  loadJobs,
  saveJobs,
  updateJob,
  removeJob,
} from "../store.ts";
import type { CronJob, CronOrigin } from "../types.ts";

describe("cron store", () => {
  const testDir = join(tmpdir(), `my-claw-cron-test-${Date.now()}`);

  beforeEach(async () => {
    await mkdir(join(testDir, "cron"), { recursive: true });
    // Override MY_CLAW_DIR via module internals is hard; we'll test pure functions
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("parseSchedule", () => {
    test("interval every 30m", () => {
      const s = parseSchedule("every 30m");
      expect(s.kind).toBe("interval");
      expect(s.minutes).toBe(30);
      expect(s.display).toBe("every 30m");
    });

    test("interval every 2h", () => {
      const s = parseSchedule("every 2h");
      expect(s.kind).toBe("interval");
      expect(s.minutes).toBe(120);
    });

    test("interval every 1d", () => {
      const s = parseSchedule("every 1d");
      expect(s.kind).toBe("interval");
      expect(s.minutes).toBe(1440);
    });

    test("cron expression", () => {
      const s = parseSchedule("0 9 * * *");
      expect(s.kind).toBe("cron");
      expect(s.expr).toBe("0 9 * * *");
    });

    test("cron expression monday", () => {
      const s = parseSchedule("0 9 * * 1");
      expect(s.kind).toBe("cron");
      expect(s.expr).toBe("0 9 * * 1");
    });

    test("once ISO timestamp", () => {
      const s = parseSchedule("2026-06-01T14:00:00Z");
      expect(s.kind).toBe("once");
      expect(s.runAt).toBeDefined();
    });

    test("once bare duration 30m", () => {
      const s = parseSchedule("30m");
      expect(s.kind).toBe("once");
      expect(s.display).toBe("once in 30m");
    });

    test("once bare duration 2h", () => {
      const s = parseSchedule("2h");
      expect(s.kind).toBe("once");
      expect(s.display).toBe("once in 2h");
    });

    test("rejects invalid", () => {
      expect(() => parseSchedule("invalid")).toThrow();
    });

    test("rejects every without duration", () => {
      expect(() => parseSchedule("every")).toThrow();
    });
  });

  describe("computeNextRun", () => {
    test("once no lastRunAt returns runAt", () => {
      const s = parseSchedule("30m");
      const next = computeNextRun(s);
      expect(next).toBe(s.runAt!);
    });

    test("once with lastRunAt returns null", () => {
      const s = parseSchedule("30m");
      const next = computeNextRun(s, new Date().toISOString());
      expect(next).toBeNull();
    });

    test("interval no lastRunAt", () => {
      const s = parseSchedule("every 30m");
      const next = computeNextRun(s);
      expect(next).not.toBeNull();
      const diff = new Date(next!).getTime() - Date.now();
      expect(diff).toBeGreaterThan(29 * 60 * 1000);
      expect(diff).toBeLessThan(31 * 60 * 1000);
    });

    test("interval with lastRunAt", () => {
      const s = parseSchedule("every 30m");
      const last = new Date(Date.now() - 60_000).toISOString();
      const next = computeNextRun(s, last);
      const diff = new Date(next!).getTime() - new Date(last).getTime();
      expect(diff).toBe(30 * 60 * 1000);
    });

    test("cron no lastRunAt", () => {
      const s = parseSchedule("0 9 * * *");
      const next = computeNextRun(s);
      expect(next).not.toBeNull();
    });
  });

  describe("createJob", () => {
    test("creates with valid params", () => {
      const job = createJob({
        name: "Test job",
        prompt: "Check logs",
        schedule: "every 30m",
        origin: null,
        deliver: "local",
      });
      expect(job.id).toHaveLength(12);
      expect(job.name).toBe("Test job");
      expect(job.schedule.kind).toBe("interval");
      expect(job.repeat).toBeNull();
      expect(job.enabled).toBe(true);
      expect(job.state).toBe("scheduled");
      expect(job.deliver).toBe("local");
    });

    test("auto-sets repeat=1 for once", () => {
      const job = createJob({
        prompt: "Check logs",
        schedule: "30m",
        origin: null,
        deliver: "local",
      });
      expect(job.repeat).toBe(1);
    });

    test("auto-generates name from prompt", () => {
      const job = createJob({
        prompt: "Check system logs for errors and report them",
        schedule: "every 30m",
        origin: null,
        deliver: "local",
      });
      expect(job.name).toBe("Check system logs for errors and report them");
    });

    test("captures origin", () => {
      const origin: CronOrigin = { platform: "my-claw-app", chatId: "neras" };
      const job = createJob({
        prompt: "Check logs",
        schedule: "every 30m",
        origin,
      });
      expect(job.origin).toEqual(origin);
      expect(job.deliver).toBe("origin");
    });

    test("origin null with deliver=origin throws", () => {
      expect(() =>
        createJob({
          prompt: "Check logs",
          schedule: "every 30m",
          origin: null,
          deliver: "origin",
        })
      ).toThrow();
    });
  });

  describe("getDueJobs", () => {
    test("includes enabled scheduled jobs with past nextRunAt", () => {
      const job: CronJob = {
        id: "abc123",
        name: "Test",
        prompt: "test",
        schedule: { kind: "interval", minutes: 30, display: "every 30m" },
        repeat: null,
        completedRuns: 0,
        enabled: true,
        state: "scheduled",
        origin: null,
        deliver: "local",
        nextRunAt: new Date(Date.now() - 60_000).toISOString(),
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        createdAt: new Date().toISOString(),
      };
      const due = getDueJobs([job]);
      expect(due).toHaveLength(1);
    });

    test("excludes disabled jobs", () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      job.enabled = false;
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      const due = getDueJobs([job]);
      expect(due).toHaveLength(0);
    });

    test("excludes paused jobs", () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      job.state = "paused";
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      const due = getDueJobs([job]);
      expect(due).toHaveLength(0);
    });

    test("excludes future nextRunAt", () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      job.nextRunAt = new Date(Date.now() + 60_000).toISOString();
      const due = getDueJobs([job]);
      expect(due).toHaveLength(0);
    });

    test("fast-forwards stale recurring jobs", () => {
      const job: CronJob = {
        id: "abc123",
        name: "Test",
        prompt: "test",
        schedule: { kind: "interval", minutes: 5, display: "every 5m" },
        repeat: null,
        completedRuns: 0,
        enabled: true,
        state: "scheduled",
        origin: null,
        deliver: "local",
        nextRunAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(), // 4h overdue
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        createdAt: new Date().toISOString(),
      };
      const beforeNext = job.nextRunAt;
      const due = getDueJobs([job]);
      expect(due).toHaveLength(0);
      expect(job.nextRunAt).not.toBe(beforeNext); // fast-forwarded
    });
  });

  describe("markJobRun", () => {
    test("sets lastRunAt, lastStatus, completedRuns", () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      markJobRun(job, "ok");
      expect(job.lastRunAt).not.toBeNull();
      expect(job.lastStatus).toBe("ok");
      expect(job.completedRuns).toBe(1);
    });

    test("completes one-shot after 1 run", () => {
      const job = createJob({ prompt: "test", schedule: "30m", origin: null, deliver: "local" });
      markJobRun(job, "ok");
      expect(job.state).toBe("completed");
      expect(job.enabled).toBe(false);
      expect(job.nextRunAt).toBeNull();
    });

    test("completes repeat=3 after 3 runs", () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      job.repeat = 3;
      markJobRun(job, "ok");
      markJobRun(job, "ok");
      markJobRun(job, "ok");
      expect(job.state).toBe("completed");
      expect(job.completedRuns).toBe(3);
    });

    test("recomputes nextRunAt for recurring", () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      markJobRun(job, "ok");
      expect(job.nextRunAt).not.toBeNull();
      expect(job.state).toBe("scheduled");
    });

    test("sets error on failure", () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      markJobRun(job, "error", "Timeout");
      expect(job.lastStatus).toBe("error");
      expect(job.lastError).toBe("Timeout");
    });
  });

  describe("parseDeliver", () => {
    test("origin", () => {
      const origin: CronOrigin = { platform: "my-claw-app", chatId: "neras" };
      expect(parseDeliver("origin", origin)).toBe("origin");
    });

    test("local", () => {
      expect(parseDeliver("local", null)).toBe("local");
    });

    test("app owner", () => {
      const result = parseDeliver("my-claw-app:neras", null);
      expect(result).toEqual({ platform: "my-claw-app", chatId: "neras", threadId: undefined });
    });

    test("app owner with threadId", () => {
      const result = parseDeliver("my-claw-app:neras:t42", null);
      expect(result).toEqual({ platform: "my-claw-app", chatId: "neras", threadId: "t42" });
    });

    test("a removed platform is rejected, not silently accepted", () => {
      expect(() => parseDeliver("telegram:123", null)).toThrow();
      expect(() => parseDeliver("matrix:!room:server.com", null)).toThrow();
    });

    test("origin without origin throws", () => {
      expect(() => parseDeliver("origin", null)).toThrow();
    });

    test("unknown platform throws", () => {
      expect(() => parseDeliver("unknown:123", null)).toThrow();
    });
  });

  describe("updateJob", () => {
    test("updates name", () => {
      const jobs: CronJob[] = [];
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      jobs.push(job);
      const updated = updateJob(jobs, job.id, { name: "Updated" });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Updated");
    });

    test("updates schedule", () => {
      const jobs: CronJob[] = [];
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      jobs.push(job);
      const updated = updateJob(jobs, job.id, { schedule: "every 1h" });
      expect(updated).not.toBeNull();
      expect(updated!.schedule.minutes).toBe(60);
      expect(updated!.nextRunAt).not.toBeNull();
    });

    test("rejects unknown job_id", () => {
      const jobs: CronJob[] = [];
      const result = updateJob(jobs, "nonexistent", { name: "X" });
      expect(result).toBeNull();
    });
  });

  describe("removeJob", () => {
    test("removes job", () => {
      const jobs: CronJob[] = [];
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      jobs.push(job);
      expect(removeJob(jobs, job.id)).toBe(true);
      expect(jobs).toHaveLength(0);
    });

    test("rejects unknown", () => {
      const jobs: CronJob[] = [];
      expect(removeJob(jobs, "nonexistent")).toBe(false);
    });
  });
});
