/**
 * The cron guarantees the owner ran into on 2026-09-26/27, one test each:
 * writes that were lost, a weekly job killed at thirty minutes with six sub-agents mid-pass, a mail
 * check held up behind it, deliveries that never reached the conversation, and a job list that said
 * nothing about the last run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CronScheduler, wrapUpLeadMs } from "../../src/cron/scheduler.ts";
import {
  cleanupOrphanJobTemps,
  createJob,
  loadJobs,
  mutateJobs,
  parseJobTimeout,
  recoverInterruptedRuns,
  saveJobs,
} from "../../src/cron/store.ts";
import type { CronDeliveryTarget } from "../../src/cron/types.ts";
import { createCronTool, type CronToolContext } from "../../src/tools/cron.ts";
import { cronCapabilityDeny, ToolRegistry } from "../../src/tools/registry.ts";
import { writeFileAtomically } from "../../src/utils/atomic-write.ts";
import { hooks } from "../../src/hooks/index.ts";
import { sessionLogOf } from "../../src/sessions/log-access.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { MY_CLAW_DIR, type MyClawConfig } from "../../src/core/config.ts";
import type { MessageRouter, RouteResult } from "../../src/core/router.ts";
import type { SessionManager } from "../../src/sessions/manager.ts";
import type { ChannelAdapter, UnifiedMessage } from "../../src/channels/types.ts";
import type { Tool } from "../../src/tools/types.ts";

const CRON_DIR = join(MY_CLAW_DIR, "cron");

const owner: UnifiedMessage = {
  id: "m1", platform: "my-claw-app", userId: "neras", chatId: "neras", chatType: "dm",
  text: "", attachments: [], isForwarded: false, raw: null, threadId: "origin-thread",
};

function toolContext(over: Partial<CronToolContext> = {}): CronToolContext {
  return {
    models: () => ["fast-1"],
    defaultModel: () => "fast-1",
    workspaces: () => ["career"],
    skills: () => [],
    mcp: () => [],
    cronTools: () => ["bash", "conversation_search"],
    cronAgentSkills: () => "all",
    cronAgentMcp: () => "all",
    defaultTimeoutMs: () => undefined,
    ...over,
  };
}

/** A router whose runs end when the test says so. */
function controllableRouter(): {
  router: MessageRouter;
  started: string[];
  finish: (sessionId: string, text?: string) => void;
  stopped: string[];
} {
  const pending = new Map<string, (r: RouteResult) => void>();
  const started: string[] = [];
  const stopped: string[] = [];
  const router = {
    routeCron: (_m: UnifiedMessage, sessionId: string) =>
      new Promise<RouteResult>((resolve) => {
        started.push(sessionId);
        pending.set(sessionId, resolve);
      }),
    route: async () => ({ text: "" }),
    setApprovalHandler: () => {},
    stop: (sessionId: string) => {
      stopped.push(sessionId);
      pending.get(sessionId)?.({ text: "" });
      return "stopped";
    },
  } as unknown as MessageRouter;
  return {
    router,
    started,
    stopped,
    finish: (sessionId, text = "done") => pending.get(sessionId)?.({ text }),
  };
}

function sessions(): SessionManager {
  return {
    getOrCreateWithMeta: async (id: string) => ({ id, platform: "cron", chatType: "dm", messages: [] }),
    deleteSession: async () => {},
    listSessions: async () => [],
  } as unknown as SessionManager;
}

function config(over: Partial<MyClawConfig> = {}): MyClawConfig {
  return {
    whitelist: [], blacklist: [], channels: {}, llm: { models: [] }, agents: {},
    cron: { enabled: true }, workspaces: { career: "/tmp/career" }, ...over,
  } as MyClawConfig;
}

const sent: Array<{ chatId: string; text: string; threadId?: string }> = [];
const adapter: ChannelAdapter = {
  platform: "my-claw-app",
  start: async () => {},
  stop: async () => {},
  send: async (chatId, msg) => {
    sent.push({ chatId, text: msg.text, ...(msg.threadId ? { threadId: msg.threadId } : {}) });
  },
  onMessage: () => {},
};

function due<T extends { nextRunAt: string | null }>(job: T): T {
  job.nextRunAt = new Date(Date.now() - 1000).toISOString();
  return job;
}

async function until(check: () => boolean): Promise<void> {
  // Each await yields to the event loop, so the run under test advances between two checks. It is
  // the run's own progress that ends the wait, never a count of turns.
  while (!check()) await new Promise((r) => setImmediate(r));
}

beforeEach(async () => {
  hooks.clear();
  sent.length = 0;
  await mkdir(CRON_DIR, { recursive: true });
  await saveJobs([]);
});

afterEach(() => {
  runRegistry.clear();
});

describe("jobs.json writes are never lost", () => {
  test("twelve creates in one tool block keep twelve jobs", async () => {
    const tool = createCronTool({ tick: async () => 0, runningOf: () => undefined } as unknown as CronScheduler, toolContext());
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        tool.execute({ action: "create", name: `job ${i}`, prompt: "p", schedule: "every 1h", deliver: "local" }),
      ),
    );
    expect(results.every((r) => r.success)).toBe(true);
    // Each call used to load, change and write its own copy: all twelve answered OK and one survived.
    expect((await loadJobs()).map((j) => j.name).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `job ${i}`).sort());
  });

  test("a create and an update side by side both land", async () => {
    await saveJobs([createJob({ name: "old", prompt: "p", schedule: "every 1h", origin: null, deliver: "local" })]);
    const [existing] = await loadJobs();
    const tool = createCronTool({ tick: async () => 0, runningOf: () => undefined } as unknown as CronScheduler, toolContext());
    await Promise.all([
      tool.execute({ action: "create", name: "new", prompt: "p", schedule: "every 1h", deliver: "local" }),
      tool.execute({ action: "update", job_id: existing!.id, name: "renamed" }),
    ]);
    expect((await loadJobs()).map((j) => j.name).sort()).toEqual(["new", "renamed"]);
  });

  test("a change that throws writes nothing, and the next writer still gets its turn", async () => {
    await expect(mutateJobs(() => {
      throw new Error("refused");
    })).rejects.toThrow("refused");
    await mutateJobs((jobs) => {
      jobs.push(createJob({ name: "after", prompt: "p", schedule: "every 1h", origin: null, deliver: "local" }));
    });
    expect((await loadJobs()).map((j) => j.name)).toEqual(["after"]);
  });

  test("the temporary files of a dead writer are removed, a live writer's are kept", async () => {
    let dead = 4_000_000;
    for (;;) {
      try {
        process.kill(dead, 0);
        dead--;
      } catch {
        break;
      }
    }
    await writeFile(join(CRON_DIR, `jobs.json.${dead}.abc123.tmp`), "{}");
    await writeFile(join(CRON_DIR, `jobs.json.${process.pid}.def456.tmp`), "{}");
    expect(await cleanupOrphanJobTemps()).toBe(1);
    const left = (await readdir(CRON_DIR)).filter((n) => n.endsWith(".tmp"));
    expect(left).toEqual([`jobs.json.${process.pid}.def456.tmp`]);
  });

  test("an atomic write that fails leaves no temporary behind", async () => {
    const dir = join(MY_CLAW_DIR, "atomic-fail");
    await mkdir(join(dir, "target"), { recursive: true });
    // Renaming a file over a directory fails: the write is refused, and must not leave its tmp.
    await expect(writeFileAtomically(join(dir, "target"), "x")).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("runs", () => {
  test("a job never runs twice at once: its next occurrence skips while it runs", async () => {
    const ctl = controllableRouter();
    const scheduler = new CronScheduler(ctl.router, sessions(), config(), () => ({}));
    scheduler.adapters.set("my-claw-app", adapter);
    await saveJobs([due(createJob({ name: "long", prompt: "p", schedule: "every 1m", origin: null, deliver: "local" }))]);

    const first = scheduler.tick();
    await until(() => ctl.started.length === 1);
    await mutateJobs((jobs) => {
      due(jobs[0]!);
    });
    expect(await scheduler.tick()).toBe(0);
    expect(ctl.started).toHaveLength(1);

    ctl.finish(ctl.started[0]!);
    expect(await first).toBe(1);
  });

  test("trigger refuses a job that is already running", async () => {
    const ctl = controllableRouter();
    const scheduler = new CronScheduler(ctl.router, sessions(), config(), () => ({}));
    await saveJobs([due(createJob({ name: "long", prompt: "p", schedule: "every 1h", origin: null, deliver: "local" }))]);
    const [job] = await loadJobs();
    const first = scheduler.tick();
    await until(() => ctl.started.length === 1);

    const tool = createCronTool(scheduler, toolContext());
    const result = await tool.execute({ action: "trigger", job_id: job!.id });
    expect(result.success).toBe(false);
    expect(result.output).toContain("already running");

    ctl.finish(ctl.started[0]!);
    await first;
  });

  test("a long job does not hold another one up", async () => {
    const ctl = controllableRouter();
    const scheduler = new CronScheduler(ctl.router, sessions(), config(), () => ({}));
    const research = due(createJob({ name: "research", prompt: "p", schedule: "every 1h", origin: null, deliver: "local" }));
    const mail = createJob({ name: "mail", prompt: "p", schedule: "every 1h", origin: null, deliver: "local" });
    await saveJobs([research, mail]);

    const long = scheduler.tick();
    await until(() => ctl.started.length === 1);
    await mutateJobs((jobs) => {
      due(jobs.find((j) => j.name === "mail")!);
    });
    const mailTick = scheduler.tick();
    await until(() => ctl.started.length === 2);
    ctl.finish(ctl.started[1]!);
    // The mail check completed while the research is still running. It used to wait behind it.
    expect(await mailTick).toBe(1);
    expect((await loadJobs()).find((j) => j.name === "research")!.runningSince).toBeDefined();

    ctl.finish(ctl.started[0]!);
    await long;
  });

  test("two jobs of one workspace running together are each told about the other", async () => {
    const prompts: string[] = [];
    const ctl = controllableRouter();
    const route = ctl.router.routeCron.bind(ctl.router);
    ctl.router.routeCron = (m: UnifiedMessage, sessionId: string) => {
      prompts.push(m.text);
      return route(m, sessionId);
    };
    const scheduler = new CronScheduler(ctl.router, sessions(), config(), () => ({}));
    const a = due(createJob({ name: "research", prompt: "p", schedule: "every 1h", origin: null, deliver: "local", workspace: "career" }));
    const b = createJob({ name: "mail", prompt: "p", schedule: "every 1h", origin: null, deliver: "local", workspace: "career" });
    await saveJobs([a, b]);
    const first = scheduler.tick();
    await until(() => ctl.started.length === 1);
    await mutateJobs((jobs) => {
      due(jobs.find((j) => j.name === "mail")!);
    });
    const second = scheduler.tick();
    await until(() => ctl.started.length === 2);
    expect(prompts[0]).not.toContain("Running in this workspace");
    expect(prompts[1]).toContain("Running in this workspace at the same time: research");
    ctl.finish(ctl.started[0]!);
    ctl.finish(ctl.started[1]!);
    await Promise.all([first, second]);
  });

  test("a pause typed while a run is going survives the run's end", async () => {
    const ctl = controllableRouter();
    const scheduler = new CronScheduler(ctl.router, sessions(), config(), () => ({}));
    await saveJobs([due(createJob({ name: "long", prompt: "p", schedule: "every 1h", origin: null, deliver: "local" }))]);
    const [job] = await loadJobs();
    const run = scheduler.tick();
    await until(() => ctl.started.length === 1);

    const tool = createCronTool(scheduler, toolContext());
    await tool.execute({ action: "pause", job_id: job!.id, reason: "on hold" });
    ctl.finish(ctl.started[0]!);
    await run;

    const after = (await loadJobs())[0]!;
    expect(after.enabled).toBe(false);
    expect(after.pausedReason).toBe("on hold");
    expect(after.lastStatus).toBe("ok");
  });

  test("the run leaves its start, duration, model and cost on the job", async () => {
    const ctl = controllableRouter();
    const scheduler = new CronScheduler(ctl.router, sessions(), config(), () => ({ model: "deepseek-v4.1-flash", costUsd: 0.12, costPartial: true }));
    await saveJobs([due(createJob({ name: "j", prompt: "p", schedule: "every 1h", origin: null, deliver: "local" }))]);
    const run = scheduler.tick();
    await until(() => ctl.started.length === 1);
    ctl.finish(ctl.started[0]!);
    await run;
    const after = (await loadJobs())[0]!;
    expect(after.lastStartedAt).toBeDefined();
    expect(after.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(after.lastModel).toBe("deepseek-v4.1-flash");
    expect(after.lastCostUsd).toBe(0.12);
    expect(after.lastCostPartial).toBe(true);
    expect(after.runningSince).toBeUndefined();
  });

  test("a run the server lost is reported at the next boot", async () => {
    const job = createJob({ name: "j", prompt: "p", schedule: "every 1h", origin: null, deliver: "local" });
    job.runningSince = new Date(Date.now() - 5 * 60_000).toISOString();
    job.lastStatus = "ok";
    await saveJobs([job]);
    expect(await recoverInterruptedRuns()).toEqual([job.id]);
    const after = (await loadJobs())[0]!;
    expect(after.lastStatus).toBe("interrupted");
    expect(after.lastError).toContain("server stopped");
    expect(after.runningSince).toBeUndefined();
    expect(after.lastDurationMs).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
  });
});

describe("the time limit", () => {
  test("the run and its sub-agents are told to wrap up before the wall, then stopped at it", async () => {
    const ctl = controllableRouter();
    const scheduler = new CronScheduler(ctl.router, sessions(), config(), () => ({}));
    const job = due(createJob({ name: "weekly", prompt: "p", schedule: "every 1h", origin: null, deliver: "local", timeoutMs: 400 }));
    await saveJobs([job]);

    const run = scheduler.tick();
    await until(() => ctl.started.length === 1);
    const sessionId = ctl.started[0]!;
    runRegistry.openMailbox(sessionId);
    runRegistry.openMailbox("subagent/child");
    runRegistry.openMailbox("subagent/grandchild");
    hooks.emit("subagent:spawn", { id: "subagent/child", displayName: "c", type: "research", mode: "run", parentSessionId: sessionId, action: "spawn" });
    hooks.emit("subagent:spawn", { id: "subagent/grandchild", displayName: "g", type: "research", mode: "run", parentSessionId: "subagent/child", action: "spawn" });

    await until(() => runRegistry.peekInjections(sessionId).length > 0);
    expect(runRegistry.peekInjections(sessionId)[0]!.text).toContain("time limit");
    expect(runRegistry.peekInjections("subagent/child")[0]!.text).toContain("answer now with what you have");
    expect(runRegistry.peekInjections("subagent/grandchild")).toHaveLength(1);
    expect(ctl.stopped).toHaveLength(0);

    await run;
    expect(ctl.stopped).toEqual([sessionId]);
    const after = (await loadJobs())[0]!;
    expect(after.lastStatus).toBe("interrupted");
    expect(after.lastError).toContain("the job's timeout");
  });

  test("the lead is a tenth of the limit, between one and ten minutes, never more than half", () => {
    expect(wrapUpLeadMs(30 * 60_000)).toBe(3 * 60_000);
    expect(wrapUpLeadMs(4 * 60 * 60_000)).toBe(10 * 60_000);
    expect(wrapUpLeadMs(5 * 60_000)).toBe(60_000);
    expect(wrapUpLeadMs(90_000)).toBe(45_000);
  });

  test("a job's own timeout parses, is capped, and clears back to the default", async () => {
    expect(parseJobTimeout("3h")).toBe(3 * 60 * 60_000);
    expect(parseJobTimeout("45m")).toBe(45 * 60_000);
    expect(() => parseJobTimeout("2d")).toThrow("capped");
    expect(() => parseJobTimeout("soon")).toThrow("Cannot parse");

    const tool = createCronTool({ tick: async () => 0, runningOf: () => undefined } as unknown as CronScheduler, toolContext());
    const created = await tool.execute({ action: "create", name: "w", prompt: "p", schedule: "0 18 * * 0", deliver: "local", timeout: "3h" });
    expect(created.output).toContain("timeout: 3 h (job)");
    const [job] = await loadJobs();
    const cleared = await tool.execute({ action: "update", job_id: job!.id, timeout: "none" });
    // No wall by default any more: a long run is announced, the owner stops it.
    expect(cleared.output).toContain("timeout: none");
    expect((await loadJobs())[0]!.timeoutMs).toBeUndefined();
  });
});

describe("a long run is announced, not stopped", () => {
  test("alerts at the alert time and again at every interval, and the run is never stopped", async () => {
    const ctl = controllableRouter();
    const scheduler = new CronScheduler(ctl.router, sessions(), config({ cron: { enabled: true, alertAfter: 40, alertEvery: 40 } }), () => ({}));
    const alerts: number[] = [];
    hooks.on("cron:job:long", ({ runningMs }) => { alerts.push(runningMs); });
    const prompts: string[] = [];
    const route = ctl.router.routeCron.bind(ctl.router);
    ctl.router.routeCron = (m: UnifiedMessage, id: string) => {
      prompts.push(m.text);
      return route(m, id);
    };
    await saveJobs([due(createJob({ name: "weekly", prompt: "p", schedule: "every 1h", origin: null, deliver: "local" }))]);
    const run = scheduler.tick();
    await until(() => alerts.length >= 2);
    expect(ctl.stopped).toEqual([]);
    expect(prompts[0]).not.toContain("Time limit");
    ctl.finish(ctl.started[0]!);
    expect(await run).toBe(1);
  });

  test("the alert says what the run is doing: its sub-agents at work, how deep, what it cost", async () => {
    const ctl = controllableRouter();
    const scheduler = new CronScheduler(ctl.router, sessions(), config({ cron: { enabled: true, alertAfter: 60, alertEvery: 10_000 } }), () => ({ costUsd: 1.8 }));
    const alerts: Array<{ working: number; depth: number; costUsd?: number }> = [];
    const onLong = ({ working, depth, costUsd }: { working: number; depth: number; costUsd?: number }): void => { alerts.push({ working, depth, ...(costUsd !== undefined ? { costUsd } : {}) }); };
    hooks.on("cron:job:long", onLong);
    try {
      await saveJobs([due(createJob({ name: "weekly", prompt: "p", schedule: "every 1h", origin: null, deliver: "local" }))]);
      const run = scheduler.tick();
      await until(() => ctl.started.length === 1);
      const root = ctl.started[0]!;
      // Two volets, and a browser task under one of them.
      for (const [id, parent] of [["subagent/a", root], ["subagent/b", root], ["subagent/a-browser", "subagent/a"]] as const) {
        hooks.emit("subagent:spawn", { id, displayName: id, type: "general", mode: "run", parentSessionId: parent, action: "spawn" });
      }
      await until(() => alerts.length >= 1);
      expect(alerts[0]).toEqual({ working: 3, depth: 2, costUsd: 1.8 });
      ctl.finish(root);
      await run;
    } finally {
      hooks.off("cron:job:long", onLong);
    }
  });

  test("a run stopped from the app is interrupted, not a failure", async () => {
    const ctl = controllableRouter();
    const scheduler = new CronScheduler(ctl.router, sessions(), config(), () => ({}));
    await saveJobs([due(createJob({ name: "veille", prompt: "p", schedule: "every 1h", origin: null, deliver: "local" }))]);
    const run = scheduler.tick();
    await until(() => ctl.started.length === 1);
    const root = ctl.started[0]!;
    // What the run leaves behind when its Stop reaches it, as the bridge writes it.
    const log = await sessionLogOf(root);
    log.append({ type: "user", prompt: true, text: "p" });
    log.append({ type: "run_start", prompt: false });
    log.append({ type: "run_end", prompt: false, reason: "aborted" });
    await log.flush();
    ctl.finish(root, "");
    await run;
    const after = (await loadJobs())[0]!;
    // It used to read "error: Agent returned empty response".
    expect(after.lastStatus).toBe("interrupted");
    expect(after.lastError).toContain("Stopped before it finished");
  });

  test("a job's own alert time is set, shown, and cleared back", async () => {
    const tool = createCronTool({ tick: async () => 0, runningOf: () => undefined } as unknown as CronScheduler, toolContext({ defaultAlertAfterMs: () => 60 * 60_000 }));
    const created = await tool.execute({ action: "create", name: "w", prompt: "p", schedule: "0 18 * * 0", deliver: "local", alert: "3h" });
    expect(created.output).toContain("alert: 3 h (job)");
    expect(created.output).toContain("timeout: none");
    const [job] = await loadJobs();
    expect(job!.alertAfterMs).toBe(3 * 60 * 60_000);
    const cleared = await tool.execute({ action: "update", job_id: job!.id, alert: "inherit" });
    expect(cleared.output).toContain("alert: 1 h |");
    expect((await loadJobs())[0]!.alertAfterMs).toBeUndefined();
  });
});

describe("delivery", () => {
  test("a delivered result is written into the conversation before the frame goes out", async () => {
    const order: string[] = [];
    const journal: Array<{ target: CronDeliveryTarget; text: string }> = [];
    const offline: ChannelAdapter = { ...adapter, send: async () => { order.push("frame"); } };
    const ctl = controllableRouter();
    const scheduler = new CronScheduler(ctl.router, sessions(), config(), () => ({}));
    scheduler.adapters.set("my-claw-app", offline);
    scheduler.journal = async (target, text) => {
      order.push("journal");
      journal.push({ target, text });
    };
    await saveJobs([due(createJob({ name: "mail", prompt: "p", schedule: "every 1h", origin: { platform: "my-claw-app", chatId: "neras", threadId: "t1" }, deliver: "origin" }))]);
    const run = scheduler.tick();
    await until(() => ctl.started.length === 1);
    ctl.finish(ctl.started[0]!, "Courrier : 1 nouveau");
    await run;
    expect(order).toEqual(["journal", "frame"]);
    expect(journal[0]!.target.threadId).toBe("t1");
    expect(journal[0]!.text).toContain("[Cron: mail]");
    expect(journal[0]!.text).toContain("Courrier : 1 nouveau");
  });

  test("deliver thread:<title> resolves to the owner's conversation of that name", async () => {
    const asked: Array<{ owner: string; title: string; workspace?: string }> = [];
    const tool = createCronTool(
      { tick: async () => 0, runningOf: () => undefined } as unknown as CronScheduler,
      toolContext({
        ensureThread: async (o, title, workspace) => {
          asked.push({ owner: o, title, ...(workspace ? { workspace } : {}) });
          return "thread-crons";
        },
      }),
    );
    const result = await tool.execute({
      action: "create", name: "mail", prompt: "p", schedule: "every 1h",
      deliver: "thread:Crons career", workspace: "career", __message: owner,
    });
    expect(result.success).toBe(true);
    expect(asked).toEqual([{ owner: "neras", title: "Crons career", workspace: "career" }]);
    expect((await loadJobs())[0]!.deliver).toEqual({ platform: "my-claw-app", chatId: "neras", threadId: "thread-crons" });
    expect(result.output).toContain("deliver: my-claw-app:neras:thread-crons");
  });
});

describe("what create and list show", () => {
  let tool: Tool;
  beforeEach(() => {
    tool = createCronTool({ tick: async () => 0, runningOf: () => undefined } as unknown as CronScheduler, toolContext());
  });

  test("create answers with every setting the run will use", async () => {
    const result = await tool.execute({
      action: "create", name: "veille", prompt: "p", schedule: "0 7 * * 1-5", deliver: "local",
      model: "tag:Cheap", workspace: "career", skills: "career-routine", browser: false,
    });
    for (const expected of ["model: tag:Cheap", "workspace: career", "deliver: local", "skills: career-routine", "browser: off", "conversations: off", "last run: never", "next:"]) {
      expect(result.output).toContain(expected);
    }
  });

  test("list shows the last run: when, status, duration, model, cost, and why it failed", async () => {
    const job = createJob({ name: "weekly", prompt: "p", schedule: "0 18 * * 0", origin: null, deliver: "local" });
    Object.assign(job, {
      lastStartedAt: "2026-09-27T16:00:20.000Z",
      lastRunAt: "2026-09-27T16:30:42.000Z",
      lastStatus: "interrupted",
      lastError: "Timed out after 30 min (cron.timeoutMs)",
      lastDurationMs: 30 * 60_000,
      lastModel: "deepseek-v4.1-flash",
      lastCostUsd: 0.4,
    });
    await saveJobs([job]);
    const out = (await tool.execute({ action: "list" })).output;
    expect(out).toContain("last run:");
    expect(out).toContain("interrupted · 30 min · deepseek-v4.1-flash · $0.40 -- Timed out after 30 min");
  });
});

describe("conversation_search is a switch a job turns on", () => {
  test("in the cron baseline, withheld unless the job asks for it", () => {
    const registry = new ToolRegistry();
    for (const name of ["bash", "conversation_search", "memory", "cron"]) {
      registry.register({ name, description: "", parameters: {}, execute: async () => ({ success: true, output: "" }) });
    }
    const names = registry.getForAgent("cron").map((t) => t.name);
    expect(names).toContain("conversation_search");
    expect(names).not.toContain("memory");
    expect(names).not.toContain("cron");

    expect(cronCapabilityDeny(undefined)).toContain("conversation_search");
    expect(cronCapabilityDeny({ conversations: true })).not.toContain("conversation_search");
    expect(cronCapabilityDeny(undefined, ["bash", "conversation_search"])).not.toContain("conversation_search");
  });

  test("the tool turns it on and off, and says so", async () => {
    const tool = createCronTool({ tick: async () => 0, runningOf: () => undefined } as unknown as CronScheduler, toolContext());
    const created = await tool.execute({ action: "create", name: "relances", prompt: "p", schedule: "every 1h", deliver: "local", conversations: true });
    expect(created.output).toContain("conversations: on");
    const [job] = await loadJobs();
    expect(job!.conversations).toBe(true);
    const off = await tool.execute({ action: "update", job_id: job!.id, conversations: false });
    expect(off.output).toContain("conversations: off");
    expect((await loadJobs())[0]!.conversations).toBeUndefined();
  });
});
