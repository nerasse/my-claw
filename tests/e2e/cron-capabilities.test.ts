import { describe, test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { CronScheduler } from "../../src/cron/scheduler.ts";
import { createJob, saveJobs, loadJobs } from "../../src/cron/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

/**
 * What a scheduled run is actually handed, read off the request the model receives -- the one
 * place the switches can be checked end to end instead of by reading the filter.
 *
 * The owner, 2026-09-21: "je veux qu'on puisse avoir des sous-agents comme l'orchestrateur pour
 * les cron [et un] paramétrage du cron job pour activer ou non [...] les sous-agents [et] le
 * navigateur". docs/cron.md.
 */
const config: MyClawConfig = {
  whitelist: [], blacklist: [], channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {}, memory: { enabled: false },
};
const SESSION_ID = "cron/job-1/1723200000000";

/** A registry with the names the filters work on: real tools elsewhere, names are what matters. */
function cronRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of [
    "bash",
    "spawn",
    "send",
    "list_agents",
    "kill_agent",
    "reset_agent",
    "delegate_browser_task",
    "notify",
    "question",
    "cron",
    "memory",
    "conversation_search",
    "workspaces",
    "manage_skills",
    "browser_click",
  ]) {
    reg.register({ name, description: name, parameters: {}, async execute() { return { success: true, output: "ok" }; } });
  }
  return reg;
}

function cronMessage(): UnifiedMessage {
  return {
    id: "m1",
    platform: "cron",
    userId: "cron",
    chatId: "cron",
    chatType: "dm",
    text: "do the thing",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

/** `routeCron` runs non-streaming, so the answer is a plain completion. */
function completion(text: string): never {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }) as never;
}

function toolNamesOf(body: { tools?: Array<{ function?: { name?: string } }> }): string[] {
  return (body.tools ?? []).map((t) => t.function?.name ?? "");
}

describe("E2E cron capabilities", () => {
  test("a job that denied both is handed neither family, and the floor stays out too", async () => {
    runRegistry.clear();
    const manager = new SessionManager();
    const router = new MessageRouter(manager, new AgentBridge(config, cronRegistry(), new SkillRegistry()), config);
    const bodies: Array<{ tools?: Array<{ function?: { name?: string } }> }> = [];
    const mock = mockFetch(async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return completion("done");
    });

    try {
      const session = await manager.getOrCreateWithMeta(SESSION_ID, "cron", "dm");
      session.scopeCapabilities = { subagents: false, browser: false };
      await router.routeCron(cronMessage(), SESSION_ID);

      const names = toolNamesOf(bodies[0]!);
      expect(names).toContain("bash");
      expect(names).toContain("notify");
      expect(names).not.toContain("spawn");
      expect(names).not.toContain("send");
      expect(names).not.toContain("list_agents");
      expect(names).not.toContain("delegate_browser_task");
      // What no job ever gets, whatever it is configured with.
      expect(names).not.toContain("question");
      expect(names).not.toContain("cron");
      expect(names).not.toContain("memory");
      expect(names).not.toContain("conversation_search");
      expect(names).not.toContain("workspaces");
      expect(names).not.toContain("manage_skills");
      // The raw browser tools stay out even when the browser is granted: one driver per Chromium.
      expect(names).not.toContain("browser_click");
    } finally {
      mock.restore(); runRegistry.clear();
    }
  });

  test("with nothing denied, a job runs like the orchestrator: sub-agents, the browser, and no raw browser tools", async () => {
    runRegistry.clear();
    const manager = new SessionManager();
    const router = new MessageRouter(manager, new AgentBridge(config, cronRegistry(), new SkillRegistry()), config);
    const bodies: Array<{ tools?: Array<{ function?: { name?: string } }> }> = [];
    const mock = mockFetch(async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return completion("done");
    });

    try {
      // A session the scheduler has not touched: the default is the grant, which is also what a
      // job created before the switches existed gets.
      await manager.getOrCreateWithMeta(SESSION_ID, "cron", "dm");
      await router.routeCron(cronMessage(), SESSION_ID);

      const names = toolNamesOf(bodies[0]!);
      for (const granted of ["spawn", "send", "list_agents", "kill_agent", "reset_agent", "delegate_browser_task"]) {
        expect(names).toContain(granted);
      }
      expect(names).not.toContain("browser_click");
      expect(names).not.toContain("cron");
    } finally {
      mock.restore(); runRegistry.clear();
    }
  });
  test("the switches travel from jobs.json to the model's tool list", async () => {
    runRegistry.clear();
    const manager = new SessionManager();
    const router = new MessageRouter(manager, new AgentBridge(config, cronRegistry(), new SkillRegistry()), config);
    const bodies: Array<{ tools?: Array<{ function?: { name?: string } }> }> = [];
    const mock = mockFetch(async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return completion("done");
    });

    try {
      const denied = createJob({
        name: "No agents", prompt: "do it", schedule: "every 1h", origin: null, deliver: "local",
        subagents: false, browser: false,
      });
      // Due now: computeNextRun put it an hour out.
      denied.nextRunAt = new Date(Date.now() - 1000).toISOString();
      await saveJobs([denied]);

      const scheduler = new CronScheduler(router, manager, config);
      expect(await scheduler.tick()).toBe(1);
      const first = toolNamesOf(bodies[0]!);
      expect(first).not.toContain("spawn");
      expect(first).not.toContain("delegate_browser_task");

      // The same job with the switches untouched: what the owner gets by default.
      const granted = createJob({ name: "Full", prompt: "do it", schedule: "every 1h", origin: null, deliver: "local" });
      granted.nextRunAt = new Date(Date.now() - 1000).toISOString();
      const jobs = await loadJobs();
      await saveJobs([...jobs, granted]);

      expect(await scheduler.tick()).toBe(1);
      const second = toolNamesOf(bodies[1]!);
      expect(second).toContain("spawn");
      expect(second).toContain("delegate_browser_task");
    } finally {
      mock.restore(); runRegistry.clear();
    }
  });
});
