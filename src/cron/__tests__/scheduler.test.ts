import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { CronScheduler } from "../scheduler.ts";
import { loadJobs, saveJobs, createJob } from "../store.ts";
import { hooks } from "../../hooks/index.ts";
import type { MessageRouter } from "../../core/router.ts";
import type { SessionManager } from "../../sessions/manager.ts";

const makeSession = () => ({
  id: "test",
  platform: "cron",
  chatType: "dm",
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
  messages: [],
});
import type { MyClawConfig } from "../../core/config.ts";
import type { ChannelAdapter } from "../../channels/types.ts";
import type { RouteResult } from "../../core/router.ts";

describe("cron scheduler", () => {
  let router: MessageRouter;
  let sessionManager: SessionManager;
  let config: MyClawConfig;
  let scheduler: CronScheduler;
  let adapterMock: ChannelAdapter;
  const sentMessages: Array<{ chatId: string; text: string }> = [];

  beforeEach(() => {
    hooks.clear();
    sentMessages.length = 0;
    adapterMock = {
      platform: "telegram",
      start: async () => {},
      stop: async () => {},
      send: async (chatId, msg) => {
        sentMessages.push({ chatId, text: msg.text });
      },
      onMessage: () => {},
    };

    router = {
      routeCron: async () => ({ text: "Test response" }),
      route: async () => ({ text: "" }),
      setApprovalHandler: () => {},
      stop: () => {},
    } as unknown as MessageRouter;

    sessionManager = {
      getOrCreateWithMeta: async () => makeSession(),
      getOrCreate: async () => makeSession(),
      deleteSession: async () => {},
      listSessions: async () => [],
    } as unknown as SessionManager;

    config = { whitelist: [], blacklist: [], channels: {}, llm: { models: [] }, agents: {}, cron: { enabled: true } } as MyClawConfig;

    scheduler = new CronScheduler(router, sessionManager, config);
    scheduler.adapters.set("telegram", adapterMock);
  });

  afterEach(() => {
    scheduler.stop();
  });

  describe("tick", () => {
    test("no due jobs returns 0", async () => {
      const result = await scheduler.tick();
      expect(result).toBe(0);
    });

    test("one due job routes and delivers", async () => {
      const job = createJob({
        prompt: "test",
        schedule: "every 30m",
        origin: { platform: "telegram", chatId: "123" },
        deliver: "origin",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job]);

      const result = await scheduler.tick();
      expect(result).toBe(1);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.chatId).toBe("123");
      expect(sentMessages[0]!.text).toContain("Test response");
    });

    test("[SILENT] response skips delivery", async () => {
      router.routeCron = async () => ({ text: "[SILENT] nothing to report" });

      const job = createJob({
        prompt: "test",
        schedule: "every 30m",
        origin: { platform: "telegram", chatId: "123" },
        deliver: "origin",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job]);

      const result = await scheduler.tick();
      expect(result).toBe(1);
      expect(sentMessages).toHaveLength(0);
    });

    test("empty response is error", async () => {
      router.routeCron = async () => ({ text: "   " });

      const job = createJob({
        prompt: "test",
        schedule: "every 30m",
        origin: { platform: "telegram", chatId: "123" },
        deliver: "origin",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job]);

      const result = await scheduler.tick();
      expect(result).toBe(0); // job failed, not counted as executed
    });

    test("job failure marks error", async () => {
      router.routeCron = async () => { throw new Error("LLM error"); };

      const job = createJob({
        prompt: "test",
        schedule: "every 30m",
        origin: { platform: "telegram", chatId: "123" },
        deliver: "origin",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job]);

      const result = await scheduler.tick();
      expect(result).toBe(0);

      const jobs = await loadJobs();
      expect(jobs[0]!.lastStatus).toBe("error");
      expect(jobs[0]!.lastError).toBe("LLM error");
    });

    test("at-most-once: nextRunAt advanced before execution", async () => {
      const job = createJob({
        prompt: "test",
        schedule: "every 30m",
        origin: { platform: "telegram", chatId: "123" },
        deliver: "origin",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      const beforeNextRun = job.nextRunAt;
      await saveJobs([job]);

      await scheduler.tick();

      const jobs = await loadJobs();
      expect(jobs[0]!.nextRunAt).not.toBe(beforeNextRun);
    });

    test("multiple due jobs execute sequentially", async () => {
      let callCount = 0;
      router.routeCron = async () => {
        callCount++;
        return { text: `Response ${callCount}` };
      };

      const job1 = createJob({ prompt: "test1", schedule: "every 30m", origin: { platform: "telegram", chatId: "123" }, deliver: "origin" });
      const job2 = createJob({ prompt: "test2", schedule: "every 30m", origin: { platform: "telegram", chatId: "456" }, deliver: "origin" });
      job1.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      job2.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job1, job2]);

      const result = await scheduler.tick();
      expect(result).toBe(2);
      expect(callCount).toBe(2);
    });

    test("cron.timeoutMs aborts a runaway job and marks it error", async () => {
      // Without the wall-clock guard, a job that never returns would pin the tick forever.
      config.cron = { enabled: true, timeoutMs: 10 };
      scheduler = new CronScheduler(router, sessionManager, config);
      scheduler.adapters.set("telegram", adapterMock);

      const stopCalls: string[] = [];
      router.stop = (sessionId: string) => { stopCalls.push(sessionId); return true; };
      router.routeCron = async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { text: "too late" };
      };

      const job = createJob({
        prompt: "test",
        schedule: "every 30m",
        origin: { platform: "telegram", chatId: "123" },
        deliver: "origin",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job]);

      const result = await scheduler.tick();
      expect(result).toBe(0); // timed-out job is not counted as executed
      // The session id is per-run now; router.stop fired for that run's session.
      expect(stopCalls.some((id) => id.startsWith(`cron/${job.id}/`))).toBe(true);
      expect(sentMessages).toHaveLength(0); // nothing delivered

      const jobs = await loadJobs();
      expect(jobs[0]!.lastStatus).toBe("error");
      expect(jobs[0]!.lastError).toContain("timed out");
    });

    test("guard against concurrent ticks", async () => {
      let routeCount = 0;
      router.routeCron = async () => {
        routeCount++;
        await new Promise((r) => setTimeout(r, 50));
        return { text: "ok" };
      };

      const job = createJob({
        prompt: "test",
        schedule: "every 30m",
        origin: { platform: "telegram", chatId: "123" },
        deliver: "origin",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job]);

      // Start two ticks simultaneously
      const [r1, r2] = await Promise.all([scheduler.tick(), scheduler.tick()]);
      expect(r1 + r2).toBe(1); // Only one should execute
    });
  });

  test("a job whose workspace key left the config pauses instead of running elsewhere", async () => {
    let routed = 0;
    router.routeCron = async () => {
      routed++;
      return { text: "never" };
    };

    const job = createJob({
      prompt: "test",
      schedule: "every 30m",
      origin: { platform: "telegram", chatId: "123" },
      deliver: "origin",
      workspace: "sofa",
    });
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await saveJobs([job]);

    config.workspaces = {}; // the key is gone
    const result = await scheduler.tick();

    expect(result).toBe(0);
    expect(routed).toBe(0);
    const [after] = await loadJobs();
    expect(after!.state).toBe("paused");
    expect(after!.enabled).toBe(false);
    expect(after!.pausedReason).toContain("sofa");
    expect(after!.lastStatus).toBeNull(); // not a run failure: a refusal to run
  });

  test("a job in a configured workspace runs with the workspace on its session", async () => {
    const job = createJob({
      prompt: "test",
      schedule: "every 30m",
      origin: { platform: "telegram", chatId: "123" },
      deliver: "origin",
      workspace: "sofa",
    });
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await saveJobs([job]);
    config.workspaces = { sofa: "/tmp/sofa" };

    const sessions: Array<{ sessionId: string; platform: string; workspace?: string }> = [];
    sessionManager.getOrCreateWithMeta = async (sessionId: string, platform: string, _chatType: string, workspace?: string) => {
      const session = makeSession();
      sessions.push({ sessionId, platform, workspace });
      return session;
    };

    const result = await scheduler.tick();
    expect(result).toBe(1);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.workspace).toBe("sofa");
    expect(sessions[0]!.sessionId.startsWith(`cron/${job.id}/`)).toBe(true);
    // The synthetic message's platform, not a hardcoded channel: a cron session says "cron".
    expect(sessions[0]!.platform).toBe("cron");
  });

  test("a failed run keeps its session: the app can reopen it to see what went wrong", async () => {
    router.routeCron = async () => {
      throw new Error("boom");
    };
    const deleted: string[] = [];
    sessionManager.deleteSession = async (sessionId: string) => {
      deleted.push(sessionId);
    };
    const id = "0123456789ab";
    sessionManager.listSessions = async () => [`cron/${id}/1700000000000`, `cron/${id}/1700000000001`];

    const job = createJob({
      prompt: "test",
      schedule: "every 30m",
      origin: { platform: "telegram", chatId: "123" },
      deliver: "origin",
    });
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await saveJobs([job]);

    const result = await scheduler.tick();
    expect(result).toBe(0);
    // The run's own session survives (the retention below keeps the newest runs), and the
    // prune only drops what exceeds the per-job cap.
    expect(deleted.length).toBe(0);
    const [after] = await loadJobs();
    expect(after!.lastStatus).toBe("error");
  });

  test("run sessions are pruned per job beyond the retention cap", async () => {
    const deleted: string[] = [];
    sessionManager.deleteSession = async (sessionId: string) => {
      deleted.push(sessionId);
    };
    const id = "0123456789ab";
    sessionManager.listSessions = async () =>
      Array.from({ length: 30 }, (_, i) => `cron/${id}/${1700000000000 - i}`);

    const job = createJob({
      prompt: "test",
      schedule: "every 30m",
      origin: { platform: "telegram", chatId: "123" },
      deliver: "origin",
    });
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await saveJobs([job]);

    await scheduler.tick();
    // 30 listed, cap 25: the 5 oldest go, the newest 25 stay.
    expect(deleted.length).toBe(5);
    expect(deleted[0]!).toBe(`cron/${id}/${1700000000000 - 25}`);
    expect(deleted[deleted.length - 1]!).toBe(`cron/${id}/${1700000000000 - 29}`);
  });

  describe("deliverResult", () => {
    test("origin uses job.origin adapter", async () => {
      const job = createJob({
        prompt: "test",
        schedule: "every 30m",
        origin: { platform: "telegram", chatId: "123" },
        deliver: "origin",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job]);

      await scheduler.tick();
      expect(sentMessages[0]!.chatId).toBe("123");
    });

    test("local no delivery", async () => {
      const job = createJob({
        prompt: "test",
        schedule: "every 30m",
        origin: null,
        deliver: "local",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job]);

      await scheduler.tick();
      expect(sentMessages).toHaveLength(0);
    });

    test("explicit target", async () => {
      const job = createJob({
        prompt: "test",
        schedule: "every 30m",
        origin: null,
        deliver: "telegram:456",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job]);

      await scheduler.tick();
      expect(sentMessages[0]!.chatId).toBe("456");
    });

    test("missing adapter logs error gracefully", async () => {
      scheduler.adapters.delete("telegram");
      const job = createJob({
        prompt: "test",
        schedule: "every 30m",
        origin: { platform: "telegram", chatId: "123" },
        deliver: "origin",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job]);

      const result = await scheduler.tick();
      expect(result).toBe(1);
      expect(sentMessages).toHaveLength(0);

      const jobs = await loadJobs();
      expect(jobs[0]!.lastStatus).toBe("ok");
    });
  });

  describe("buildCronPrompt", () => {
    test("contains cron header and prompt", async () => {
      const job = createJob({
        prompt: "Check the logs",
        schedule: "every 30m",
        origin: null,
        deliver: "local",
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await saveJobs([job]);

      let capturedPrompt = "";
      router.routeCron = async (msg) => {
        capturedPrompt = msg.text;
        return { text: "ok" };
      };

      await scheduler.tick();
      expect(capturedPrompt).toContain("scheduled task");
      expect(capturedPrompt).toContain("[SILENT]");
      expect(capturedPrompt).toContain("Check the logs");
    });
  });

  describe("start/stop", () => {
    test("starts interval", () => {
      scheduler.start(1000);
      expect(scheduler["tickTimer"]).not.toBeNull();
    });

    test("stops interval", () => {
      scheduler.start(1000);
      scheduler.stop();
      expect(scheduler["tickTimer"]).toBeNull();
    });

    test("respects config.cron.enabled=false", () => {
      config.cron = { enabled: false };
      scheduler = new CronScheduler(router, sessionManager, config);
      scheduler.start();
      expect(scheduler["tickTimer"]).toBeNull();
    });
  });
});
