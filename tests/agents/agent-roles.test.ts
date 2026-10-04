/**
 * A sub-agent's role is its own, whatever channel its root came from -- docs/agent-roles.md.
 *
 * On 2026-09-28 every sub-agent of a cron job ran as the cron role, because the role was read off
 * the message and a sub-agent's message carries its root's platform. A browser task then had no
 * browser tools and `delegate_browser_task` instead, so it delegated to another browser task, which
 * did the same: chains 325 levels deep for six hours. These tests run the real runner and bridge on
 * that exact shape and assert on the tool list the model was sent.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { writeLegacySessionFile } from "../helpers/session-log.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { loadAllAgents } from "../../src/agents/loader.ts";
import { MAX_SUBAGENT_DEPTH, SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { BrowserSession, registerBrowserTools } from "../../src/tools/browser/index.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { agentTypeOf, deleteSession, type SessionData } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SubAgentType } from "../../src/subagents/types.ts";

const BUILTIN_AGENTS = join(import.meta.dir, "..", "..", "src", "agents", "builtin");
const CRON_RUN = "cron/0123456789ab/1790571620919";

const config = {
  whitelist: ["u1"], blacklist: [], channels: {},
  llm: { provider: "x", baseUrl: "https://llm.example.com", model: "test-model" },
  agents: {}, memory: { enabled: false }, browser: { enabled: true },
} as unknown as MyClawConfig;

let agents: AgentRegistry;
beforeAll(async () => {
  agents = new AgentRegistry(await loadAllAgents({ builtInDir: BUILTIN_AGENTS, customDir: join(tmpdir(), "no-such-agents") }));
});
afterEach(() => runRegistry.clear());

/** The message a cron run's sub-agents inherit: platform "cron", like their root's. */
const cronMessage = (): UnifiedMessage => ({
  id: `m-${Math.random().toString(36).slice(2)}`, platform: "cron", userId: "cron", chatId: "cron", chatType: "dm",
  text: "veille", attachments: [], isForwarded: false, raw: {},
});

function runner(): SubAgentRunner {
  const tools = new ToolRegistry();
  // What the cron role holds besides the browser tools: every one of these reaching a browser task
  // or a research agent is the bug.
  for (const name of ["read", "write", "bash", "fetch", "spawn", "send", "delegate_browser_task", "notify", "skills"]) {
    tools.register({ name, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ success: true, output: "" }) });
  }
  const session = new BrowserSession(config);
  registerBrowserTools(tools, config, session);
  const voice = new VoiceManager(config);
  return new SubAgentRunner(config, tools, new SkillRegistry(), voice, new SttPipeline(voice), agents, session);
}

/** The model answers at once; the tools it was offered are what is under test. */
function world(): { toolsSent: string[][]; restore: () => void } {
  const toolsSent: string[][] = [];
  const mock = mockFetch(async (input?: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("127.0.0.1:9223")) {
      const endpoint = url.split("/").pop() ?? "";
      if (endpoint === "list-windows") return new Response(JSON.stringify({ windows: [{ windowId: 10, tabs: [{ pageId: "p0", url: "about:blank", title: "" }] }] })) as never;
      return new Response("{}") as never;
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: Array<{ function: { name: string } }> };
    toolsSent.push((body.tools ?? []).map((t) => t.function.name).sort());
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: {} })) as never;
  });
  return { toolsSent, restore: () => mock.restore() };
}

async function spawnUnder(r: SubAgentRunner, type: SubAgentType, parentSessionId: string): Promise<{ id: string; result: string }> {
  const registry = new SubAgentRegistry();
  return r.spawn({
    displayName: type, type, mode: "run", task: "t", parentMessage: cronMessage(),
    existingIds: await registry.listExistingIds(), generateId: (n, e) => registry.generateId(n, e),
    parentSessionId, visibility: "private",
  });
}

describe("a sub-agent of a cron run has its own role", () => {
  test("a browser task gets the browser tools, and nothing to delegate with", async () => {
    const w = world();
    try {
      await spawnUnder(runner(), "browser", CRON_RUN);
      expect(w.toolsSent.length).toBeGreaterThan(0);
      const tools = w.toolsSent[0]!;
      expect(tools).toContain("browser_navigate");
      expect(tools.every((n) => n.startsWith("browser_") || n === "skills")).toBe(true);
    } finally {
      w.restore();
    }
  });

  test("a research agent stays read-only", async () => {
    const w = world();
    try {
      await spawnUnder(runner(), "research", CRON_RUN);
      const tools = w.toolsSent[0]!;
      for (const name of ["bash", "write", "spawn", "delegate_browser_task", "browser_navigate"]) expect(tools).not.toContain(name);
      expect(tools).toContain("read");
    } finally {
      w.restore();
    }
  });

  test("a general agent may reach the browser, but never spawns or rings the phone", async () => {
    const w = world();
    try {
      await spawnUnder(runner(), "general", CRON_RUN);
      const tools = w.toolsSent[0]!;
      expect(tools).toContain("bash");
      expect(tools).toContain("delegate_browser_task");
      for (const name of ["spawn", "send", "notify", "browser_navigate"]) expect(tools).not.toContain(name);
    } finally {
      w.restore();
    }
  });

  test("a stored session reads as what it is, not as its root's channel", () => {
    const sub = { id: "subagent/x", platform: "cron", chatType: "dm", meta: { type: "browser" } } as unknown as SessionData;
    const run = { id: CRON_RUN, platform: "cron", chatType: "dm" } as unknown as SessionData;
    expect(agentTypeOf(sub)).toBe("browser");
    expect(agentTypeOf(run)).toBe("cron");
  });
});

describe("sub-agents nest at most two deep, whatever the tools say", () => {
  const chain = async (): Promise<{ level1: string; level2: string }> => {
    const level1 = "subagent/volet-a1b2";
    const level2 = "subagent/browser-c3d4";
    const at = new Date().toISOString();
    for (const [id, parent, type] of [[level1, CRON_RUN, "general"], [level2, level1, "browser"]] as const) {
      await deleteSession(id);
      await writeLegacySessionFile(id, {
        id, platform: "cron", chatType: "dm", createdAt: at, lastActiveAt: at, messages: [],
        meta: { displayName: id, type, parentSessionId: parent, visibility: "private", createdAt: at },
      });
    }
    return { level1, level2 };
  };

  test("under a level-2 agent, a spawn is refused before anything runs", async () => {
    const { level2 } = await chain();
    const w = world();
    try {
      const out = await spawnUnder(runner(), "browser", level2);
      expect(MAX_SUBAGENT_DEPTH).toBe(2);
      expect(out.result).toMatch(/^Error: this would start a level-3 sub-agent/);
      expect(out.id).toBe("");
      expect(w.toolsSent).toEqual([]);
    } finally {
      w.restore();
    }
  });

  test("a browser task under a run's sub-agent is level 2, and runs", async () => {
    const { level1 } = await chain();
    const w = world();
    try {
      const out = await spawnUnder(runner(), "browser", level1);
      expect(out.result).not.toMatch(/^Error/);
      expect(w.toolsSent.length).toBeGreaterThan(0);
    } finally {
      w.restore();
    }
  });
});
