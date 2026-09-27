import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createCronTool } from "../../tools/cron.ts";
import { loadJobs, saveJobs, createJob } from "../store.ts";
import type { CronScheduler } from "../scheduler.ts";
import type { UnifiedMessage } from "../../channels/types.ts";

describe("cron tool", () => {
  let tool: ReturnType<typeof createCronTool>;
  let scheduler: CronScheduler;
  let tickCalled = false;

  beforeEach(async () => {
    tickCalled = false;
    scheduler = {
      tick: async () => { tickCalled = true; return 1; },
      runningOf: () => undefined,
      adapters: new Map(),
      start: () => {},
      stop: () => {},
    } as unknown as CronScheduler;

    tool = createCronTool(scheduler, {
      models: () => ["fast-1"],
      defaultModel: () => "fast-1",
      workspaces: () => [],
      skills: () => [],
      mcp: () => [],
      cronTools: () => [],
      cronAgentSkills: () => "all",
      cronAgentMcp: () => "all",
    });
    // Ensure clean state
    await saveJobs([]);
  });

  afterEach(async () => {
    await saveJobs([]);
  });

  describe("create", () => {
    test("creates job with valid params", async () => {
      const msg: UnifiedMessage = {
        id: "1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm",
        text: "", attachments: [], isForwarded: false, raw: null,
      };
      const result = await tool.execute({
        action: "create",
        name: "Test job",
        prompt: "Check logs",
        schedule: "every 30m",
        __message: msg,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain("Scheduled task created");

      const jobs = await loadJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.name).toBe("Test job");
      expect(jobs[0]!.origin).toEqual({ platform: "my-claw-app", chatId: "c1" });
    });

    test("stores the prompt normalised", async () => {
      const msg: UnifiedMessage = {
        id: "1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm",
        text: "", attachments: [], isForwarded: false, raw: null,
      };
      const result = await tool.execute({
        action: "create",
        prompt: "clean the in\u200bbox",
        schedule: "every 30m",
        __message: msg,
      });
      // Rejecting when normalisation changed the text would turn a stray zero-width space into a
      // refusal to schedule -- the exact failure docs/untrusted-content.md exists to record.
      expect(result.success).toBe(true);
      expect((await loadJobs())[0]?.prompt).toBe("clean the inbox");
    });

    test("rejects missing prompt", async () => {
      const result = await tool.execute({ action: "create", schedule: "every 30m" });
      expect(result.success).toBe(false);
      expect(result.output).toContain("Missing 'prompt'");
    });

    test("rejects missing schedule", async () => {
      const result = await tool.execute({ action: "create", prompt: "test" });
      expect(result.success).toBe(false);
      expect(result.output).toContain("Missing 'schedule'");
    });

    test("rejects deliver=origin without origin", async () => {
      const result = await tool.execute({
        action: "create",
        prompt: "test",
        schedule: "every 30m",
        deliver: "origin",
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain("origin");
    });
  });

  describe("list", () => {
    test("lists jobs", async () => {
      await saveJobs([createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" })]);
      const result = await tool.execute({ action: "list" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("every 30m");
    });

    test("empty list", async () => {
      const result = await tool.execute({ action: "list" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("No scheduled tasks.");
    });

    test("filters disabled", async () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      job.enabled = false;
      job.state = "paused";
      await saveJobs([job]);
      const result = await tool.execute({ action: "list", enabled: false });
      expect(result.success).toBe(true);
      expect(result.output).toContain("No scheduled tasks.");
    });
  });

  describe("update", () => {
    test("updates name", async () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      await saveJobs([job]);
      const result = await tool.execute({ action: "update", job_id: job.id, name: "Updated" });
      expect(result.success).toBe(true);

      const jobs = await loadJobs();
      expect(jobs[0]!.name).toBe("Updated");
    });

    test("rejects unknown job_id", async () => {
      const result = await tool.execute({ action: "update", job_id: "unknown", name: "X" });
      expect(result.success).toBe(false);
      expect(result.output).toContain("not found");
    });

    test("stores the updated prompt normalised", async () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      await saveJobs([job]);
      const result = await tool.execute({
        action: "update",
        job_id: job.id,
        prompt: "new pr\u200bompt",
      });
      expect(result.success).toBe(true);
      expect((await loadJobs())[0]?.prompt).toBe("new prompt");
    });
  });

  describe("pause", () => {
    test("pauses job", async () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      await saveJobs([job]);
      const result = await tool.execute({ action: "pause", job_id: job.id, reason: "Testing" });
      expect(result.success).toBe(true);

      const jobs = await loadJobs();
      expect(jobs[0]!.enabled).toBe(false);
      expect(jobs[0]!.state).toBe("paused");
      expect(jobs[0]!.pausedReason).toBe("Testing");
    });

    test("rejects unknown job_id", async () => {
      const result = await tool.execute({ action: "pause", job_id: "unknown" });
      expect(result.success).toBe(false);
    });
  });

  describe("resume", () => {
    test("resumes job", async () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      job.enabled = false;
      job.state = "paused";
      await saveJobs([job]);
      const result = await tool.execute({ action: "resume", job_id: job.id });
      expect(result.success).toBe(true);

      const jobs = await loadJobs();
      expect(jobs[0]!.enabled).toBe(true);
      expect(jobs[0]!.state).toBe("scheduled");
      expect(jobs[0]!.nextRunAt).not.toBeNull();
    });

    test("rejects unknown job_id", async () => {
      const result = await tool.execute({ action: "resume", job_id: "unknown" });
      expect(result.success).toBe(false);
    });
  });

  describe("remove", () => {
    test("removes job", async () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      await saveJobs([job]);
      const result = await tool.execute({ action: "remove", job_id: job.id });
      expect(result.success).toBe(true);

      const jobs = await loadJobs();
      expect(jobs).toHaveLength(0);
    });

    test("rejects unknown job_id", async () => {
      const result = await tool.execute({ action: "remove", job_id: "unknown" });
      expect(result.success).toBe(false);
    });
  });

  describe("trigger", () => {
    test("triggers job immediately", async () => {
      const job = createJob({ prompt: "test", schedule: "every 30m", origin: null, deliver: "local" });
      await saveJobs([job]);
      const result = await tool.execute({ action: "trigger", job_id: job.id });
      expect(result.success).toBe(true);
      expect(tickCalled).toBe(true);

      const jobs = await loadJobs();
      expect(jobs[0]!.nextRunAt).not.toBeNull();
      expect(new Date(jobs[0]!.nextRunAt!).getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    });

    test("rejects unknown job_id", async () => {
      const result = await tool.execute({ action: "trigger", job_id: "unknown" });
      expect(result.success).toBe(false);
    });
  });

  describe("unknown action", () => {
    test("returns error", async () => {
      const result = await tool.execute({ action: "unknown" });
      expect(result.success).toBe(false);
      expect(result.output).toContain("Unknown action");
    });
  });
});
