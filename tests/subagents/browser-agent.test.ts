/**
 * The browser as a sub-agent. `delegate_browser_task` frames a task and runs the `browser` agent
 * through the same runner and loop as `spawn`: a private one-shot session of the caller, streamed
 * to its own thread, driven by the raw browser tools and nothing else, one run on the shared
 * Chromium at a time. This suite covers what the door adds around that run: the task text, the
 * closed toolbox, the outcome `browser_done` records for the caller, the handoff, a dead sidecar,
 * screenshots, the queue and the cleanup. The run itself is the bridge's, tested with it.
 */

import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { hooks } from "../../src/hooks/index.ts";
import type { HookEventMap } from "../../src/hooks/index.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { loadAllAgents } from "../../src/agents/loader.ts";
import { resolveAgent } from "../../src/agents/resolve.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { BrowserSession, createDelegateBrowserTool, registerBrowserTools } from "../../src/tools/browser/index.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import { loadSession } from "../../src/sessions/store.ts";
import { openSessionLog } from "../../src/sessions/log.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { Tool } from "../../src/tools/types.ts";

const BUILTIN_AGENTS = join(import.meta.dir, "..", "..", "src", "agents", "builtin");

function makeConfig(browser: MyClawConfig["browser"] = { enabled: true }): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: { provider: "x", baseUrl: "https://llm.example.com", model: "test-model" },
    agents: {},
    memory: { enabled: false },
    browser,
  } as unknown as MyClawConfig;
}

let agents: AgentRegistry;
beforeAll(async () => {
  agents = new AgentRegistry(await loadAllAgents({ builtInDir: BUILTIN_AGENTS, customDir: join(tmpdir(), "no-such-agents") }));
});

function message(): UnifiedMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    platform: "my-claw-app",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "browse",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

interface Harness {
  tool: Tool;
  tools: ToolRegistry;
  session: BrowserSession;
  runner: SubAgentRunner;
}

function harness(config: MyClawConfig): Harness {
  const tools = new ToolRegistry();
  for (const n of ["read", "bash", "spawn"]) {
    tools.register({ name: n, description: n, parameters: { type: "object", properties: {} }, execute: async () => ({ success: true, output: "" }) });
  }
  const session = new BrowserSession(config);
  registerBrowserTools(tools, config, session);
  const voice = new VoiceManager(config);
  const runner = new SubAgentRunner(config, tools, new SkillRegistry(), voice, new SttPipeline(voice), agents, session);
  const registry = new SubAgentRegistry();
  return { tool: createDelegateBrowserTool(config, runner, registry, session), tools, session, runner };
}

function llmResponse(payload: object): Response {
  return new Response(JSON.stringify({ choices: [{ message: payload }], usage: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function json(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

interface LlmCall {
  tools: string[];
  messages: Array<{ role: string; content: unknown }>;
}

/**
 * A fake world: the sidecar answers every endpoint with a plausible shape and records the calls;
 * the model is a script, one answer per browser-agent turn.
 */
function world(script: Array<(call: LlmCall) => object>, opts: { navigateError?: string } = {}) {
  const sidecar: string[] = [];
  const llm: LlmCall[] = [];
  let turn = 0;
  const mock = mockFetch(async (input?: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("127.0.0.1:9223")) {
      const endpoint = url.split("/").pop() ?? "";
      sidecar.push(endpoint);
      if (endpoint === "session") return json({ sessionId: "sc-1" });
      if (endpoint === "tabs") return json({ tabs: [{ url: "https://open.example.com", title: "Already open" }] });
      if (endpoint === "navigate") {
        if (opts.navigateError) return json({ error: opts.navigateError }, 500);
        return json({ pageId: "p1", url: "https://example.com", snapshot: { raw: "page", refs: [1] } });
      }
      if (endpoint === "screenshot") return json({ type: "image", path: "/tmp/shot.png", mimeType: "image/png" });
      return json({});
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: Array<{ function: { name: string } }>; messages: LlmCall["messages"] };
    const call: LlmCall = { tools: (body.tools ?? []).map((t) => t.function.name), messages: body.messages };
    llm.push(call);
    const step = script[Math.min(turn, script.length - 1)]!;
    turn += 1;
    return llmResponse(step(call));
  });
  return {
    sidecar,
    llm,
    restore: () => {
      mock.restore();
    },
  };
}

const toolCall = (name: string, args: object, id = `tc-${Math.random().toString(36).slice(2)}`) => ({
  content: "",
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

afterEach(() => {
  runRegistry.clear();
});

describe("the browser agent's toolbox", () => {
  test("registerBrowserTools gives the browser agent the raw tools and nobody else", () => {
    const { tools } = harness(makeConfig({ enabled: true, allowEval: true, allowCdp: true }));
    const browser = tools.getForAgent("browser").map((t) => t.name).sort();
    expect(browser).toContain("browser_navigate");
    expect(browser).toContain("browser_done");
    expect(browser).toContain("browser_eval");
    expect(browser).not.toContain("bash");
    expect(browser).not.toContain("spawn");
    for (const agent of ["main", "general", "research", "cron"]) {
      const names = tools.getForAgent(agent).map((t) => t.name);
      expect(names.some((n) => n.startsWith("browser_"))).toBe(false);
    }
  });

  test("the browser agent resolves on its own base: closed set, no skills, no MCP, the low-level tools gated by config", () => {
    const off = resolveAgent(makeConfig({ enabled: true }), agents, "browser");
    expect(off.base).toBe("browser");
    expect(off.skills).toEqual([]);
    expect(off.mcp).toEqual([]);
    expect([...(off.deny ?? [])].sort()).toEqual(["browser_cdp", "browser_eval"]);
    // The file's budget is the default; `browser.maxSteps` keeps meaning the budget of one task.
    expect(off.maxIterations).toBe(60);
    const on = resolveAgent(makeConfig({ enabled: true, allowEval: true, allowCdp: true, maxSteps: 7 }), agents, "browser");
    expect(on.deny).toBeUndefined();
    expect(on.maxIterations).toBe(7);
  });

  test("only the browser agent may claim the browser base", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agents-"));
    await writeFile(join(dir, "shopper.md"), "---\ndescription: buys things\nbase: browser\n---\nShop.\n");
    const registry = new AgentRegistry(await loadAllAgents({ builtInDir: BUILTIN_AGENTS, customDir: dir }));
    expect(registry.get("shopper")?.meta.base).toBe("general");
    expect(registry.get("browser")?.meta.base).toBe("browser");
    // Still not in the spawn catalog: the delegate is its door.
    expect(registry.list().some((a) => a.name === "browser")).toBe(false);
  });
});

describe("delegate_browser_task runs the browser agent as a sub-agent", () => {
  test("a task becomes a private one-shot of the caller, run on the browser tools alone, and answers with what browser_done recorded", async () => {
    const config = makeConfig({ enabled: true });
    const { tool } = harness(config);
    const spawned: HookEventMap["subagent:spawn"][] = [];
    const onSpawn = (ev: HookEventMap["subagent:spawn"]): void => { spawned.push(ev); };
    hooks.on("subagent:spawn", onSpawn);
    const w = world([
      () => toolCall("browser_navigate", { url: "https://example.com" }),
      () => toolCall("browser_screenshot", {}),
      () => toolCall("browser_done", { summary: "The page shows the price: 42 EUR." }),
      () => ({ content: "The page shows the price: 42 EUR." }),
    ]);
    try {
      const result = await tool.execute({
        url: "https://example.com",
        instructions: "Read the price",
        __message: message(),
        __sessionId: "my-claw-app/thread/u1/t1",
        __toolCallId: "call-7",
        __workspaceDir: await mkdtemp(join(tmpdir(), "browser-ws-")),
      });
      expect(result.success).toBe(true);
      expect(result.output).toBe("The page shows the price: 42 EUR.");
      // The screenshot travels to the caller's reply, as it always did.
      expect(result.attachments?.map((a) => a.path)).toEqual(["/tmp/shot.png"]);

      // A real sub-agent: announced with the delegate's own tool call id, so the card in the
      // parent thread becomes the door; private to the caller; typed browser.
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.type).toBe("browser");
      expect(spawned[0]!.parentSessionId).toBe("my-claw-app/thread/u1/t1");
      expect(spawned[0]!.toolCallId).toBe("call-7");
      const session = await loadSession(spawned[0]!.id);
      expect(session?.meta?.visibility).toBe("private");
      expect(session?.meta?.type).toBe("browser");
      const log = await openSessionLog(spawned[0]!.id);
      const first = log.path()[0];
      expect(first?.type).toBe("user");
      const task = first && "text" in first ? String(first.text) : "";
      expect(task).toContain("Task: Read the price");
      expect(task).toContain("Start URL: https://example.com");
      expect(task).toContain("Open browser tabs");
      expect(task).toContain("https://open.example.com");

      // The model only ever saw the browser toolbox.
      expect(w.llm.length).toBe(4);
      for (const call of w.llm) {
        expect(call.tools).toContain("browser_done");
        expect(call.tools.every((n) => n.startsWith("browser_"))).toBe(true);
      }
      // And the browser was left clean for the next run.
      expect(w.sidecar[w.sidecar.length - 1]).toBe("cleanup");
    } finally {
      hooks.off("subagent:spawn", onSpawn);
      w.restore();
    }
  });

  test("a handoff reaches the caller with the live browser address", async () => {
    const { tool } = harness(makeConfig({ enabled: true, novncUrl: "https://vnc.example.com/vnc.html" }));
    const w = world([
      () => toolCall("browser_done", { summary: "hCaptcha is blocking the page", needs_human: true }),
      () => ({ content: "Blocked by a captcha." }),
    ]);
    try {
      const result = await tool.execute({ url: "https://example.com", instructions: "log in", __message: message(), __sessionId: "s1" });
      expect(result.success).toBe(false);
      expect(result.output).toContain("a human must take over");
      expect(result.output).toContain("hCaptcha is blocking the page");
      expect(result.output).toContain("https://vnc.example.com/vnc.html");
      expect(result.output).toContain("vnc.example.com:5900");
    } finally {
      w.restore();
    }
  });

  test("a dead sidecar is a technical failure, never a handoff, and ends the run", async () => {
    const { tool } = harness(makeConfig({ enabled: true }));
    const w = world(
      [
        () => toolCall("browser_navigate", { url: "https://example.com" }),
        () => ({ content: "The browser is down, I stopped." }),
      ],
      { navigateError: "connect ECONNREFUSED 127.0.0.1:9223" },
    );
    try {
      const result = await tool.execute({ url: "https://example.com", instructions: "go", __message: message(), __sessionId: "s1" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Browser infrastructure is unavailable");
      expect(result.error).toContain("ECONNREFUSED");
      expect(result.output).not.toContain("take over");
      // The model was told to stop, not to climb the ladder.
      const toolReply = w.llm[1]!.messages.find((m) => m.role === "tool");
      expect(String(toolReply?.content)).toContain("Stop here");
    } finally {
      w.restore();
    }
  });

  test("a run that ends without browser_done is a failure carrying its last words, not a completed task", async () => {
    const { tool } = harness(makeConfig({ enabled: true, maxSteps: 1 }));
    const w = world([() => ({ content: "I looked around but could not find it." })]);
    try {
      const result = await tool.execute({ url: "https://example.com", instructions: "find it", __message: message(), __sessionId: "s1" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("I looked around but could not find it.");
    } finally {
      w.restore();
    }
  });

  test("a disabled browser refuses before anything runs", async () => {
    const { tool } = harness(makeConfig({ enabled: false }));
    const w = world([]);
    try {
      const result = await tool.execute({ url: "https://example.com", instructions: "go", __message: message(), __sessionId: "s1" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("disabled");
      expect(w.llm).toHaveLength(0);
    } finally {
      w.restore();
    }
  });

  test("a stop reaches the run and surfaces as the abort it is", async () => {
    const { tool } = harness(makeConfig({ enabled: true }));
    const controller = new AbortController();
    controller.abort();
    const w = world([() => toolCall("browser_navigate", { url: "https://example.com" })]);
    try {
      await expect(
        tool.execute({ url: "https://example.com", instructions: "go", __message: message(), __sessionId: "s1", __signal: controller.signal }),
      ).rejects.toBeInstanceOf(AbortedError);
    } finally {
      w.restore();
    }
  });

  test("two tasks take the one browser in turn, each cleaning up before the next opens", async () => {
    const { tool } = harness(makeConfig({ enabled: true }));
    const w = world([
      (call) => (call.messages.some((m) => m.role === "tool") ? toolCall("browser_done", { summary: "done" }) : toolCall("browser_navigate", { url: "https://example.com" })),
    ]);
    try {
      const [a, b] = await Promise.all([
        tool.execute({ url: "https://a.example.com", instructions: "a", __message: message(), __sessionId: "s1" }),
        tool.execute({ url: "https://b.example.com", instructions: "b", __message: message(), __sessionId: "s1" }),
      ]);
      expect(a!.success).toBe(true);
      expect(b!.success).toBe(true);
      // Sidecar sessions never overlap: the second `session` opens after the first `cleanup`.
      const firstCleanup = w.sidecar.indexOf("cleanup");
      const sessions = w.sidecar.map((e, i) => (e === "session" ? i : -1)).filter((i) => i >= 0);
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      expect(sessions[sessions.length - 1]!).toBeGreaterThan(firstCleanup);
    } finally {
      w.restore();
    }
  });
});
