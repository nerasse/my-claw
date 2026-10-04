import { describe, test, expect, afterEach } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { BrowserSession, createDelegateBrowserTool, registerBrowserTools } from "../../src/tools/browser/index.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { loadAllAgents } from "../../src/agents/loader.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {},
  memory: { enabled: false },
  browser: { enabled: true },
};

function msg(text: string): UnifiedMessage {
  return {
    id: `m-${Date.now()}-${Math.random()}`,
    platform: "my-claw-app",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text,
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function llmResp(message: object): never {
  return new Response(
    JSON.stringify({ choices: [{ message }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ) as never;
}

// Loose fetch shape for the test mock: the code under test only ever calls the
// usual (input, init) signature and awaits a Response.
type FetchImpl = (input?: string | URL | Request, init?: RequestInit) => Promise<Response>;

// The browser subagent queries the sidecar (session/tabs/cleanup) around its LLM
// loop. Route those to sidecar-shaped responses so the LLM mock only sees LLM calls.
const staged: Array<{ windowId: number }> = [];

function withSidecar(impl: FetchImpl): { restore(): void } {
  const mock = mockFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("127.0.0.1:9223")) {
      if (url.endsWith("/session")) return new Response(JSON.stringify({ sessionId: "s" }), { status: 200 });
      if (url.endsWith("/tabs")) return new Response(JSON.stringify({ tabs: [] }), { status: 200 });
      if (url.endsWith("/list-windows")) {
        return new Response(JSON.stringify({ windows: [{ windowId: 41, tabs: [{ pageId: "t41", url: "https://example.com", title: "Example" }] }] }), { status: 200 });
      }
      if (url.endsWith("/snapshot")) return new Response(JSON.stringify({ raw: 'button "Verify" [__ref="1"]', refs: [1] }), { status: 200 });
      if (url.endsWith("/stage")) {
        staged.push(JSON.parse(String(init?.body ?? "{}")) as { windowId: number });
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return impl(input as never, init as never);
  }) as FetchImpl);
  return {
    restore() {
      mock.restore();
    },
  };
}

function makeRouter(reg: ToolRegistry, cfg?: Partial<MyClawConfig>): MessageRouter {
  const merged = { ...config, ...cfg };
  return new MessageRouter(new SessionManager(), new AgentBridge(merged, reg, new SkillRegistry()), merged);
}

let agents: AgentRegistry;

/**
 * The browser wired the way index.ts wires it: the raw tools in the registry for the browser
 * agent, and the delegate door running that agent through the sub-agent runner.
 */
async function withBrowser(cfg: MyClawConfig): Promise<ToolRegistry> {
  agents ??= new AgentRegistry(await loadAllAgents({
    builtInDir: join(import.meta.dir, "..", "..", "src", "agents", "builtin"),
    customDir: join(tmpdir(), "no-such-agents-dir"),
  }));
  const registry = new ToolRegistry();
  const session = new BrowserSession(cfg);
  registerBrowserTools(registry, cfg, session);
  const voice = new VoiceManager(cfg);
  const runner = new SubAgentRunner(cfg, registry, new SkillRegistry(), voice, new SttPipeline(voice), agents, session);
  registry.register(createDelegateBrowserTool(cfg, runner, new SubAgentRegistry(), session));
  return registry;
}

describe("E2E browser delegation", () => {
  afterEach(() => {
    runRegistry.clear();
  });

  test("delegate_browser_task through router returns response", async () => {
    const registry = await withBrowser(config);
    const router = makeRouter(registry);

    let bridgeCall = 0;
    let subagentCall = 0;
    const mock = withSidecar(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const tools = body.tools as Array<{ function: { name: string } }> | undefined;

      // Subagent calls have "browser_done" in tools. The browser agent is a real sub-agent now:
      // it records its outcome with browser_done, then answers with the summary as its last message.
      if (tools?.some((t) => t.function.name === "browser_done")) {
        subagentCall++;
        const recorded = (body.messages as Array<{ role: string }>).some((m) => m.role === "tool");
        return recorded
          ? llmResp({ content: "Screenshot taken" })
          : llmResp({ content: "", tool_calls: [{ id: "tc_sub", function: { name: "browser_done", arguments: '{"summary":"Screenshot taken"}' } }] });
      }

      bridgeCall++;
      if (bridgeCall === 1) {
        return llmResp({
          content: "",
          tool_calls: [{ id: "tc1", function: { name: "delegate_browser_task", arguments: '{"url":"https://example.com","instructions":"Take a screenshot"}' } }],
        });
      }
      return llmResp({ content: "Here is the screenshot" });
    });

    try {
      const result = await router.route(msg("screenshot example.com"));
      expect(result).toBeDefined();
      expect(result!.text).toBe("Here is the screenshot");
      expect(bridgeCall).toBe(2);
      expect(subagentCall).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("delegate_browser_task returns tool error when browser is disabled", async () => {
    const disabledConfig = { ...config, browser: { enabled: false } };
    const registry = await withBrowser(disabledConfig);
    const router = makeRouter(registry, { browser: { enabled: false } });

    let bridgeCall = 0;
    const mock = withSidecar(async () => {
      bridgeCall++;
      if (bridgeCall === 1) {
        return llmResp({
          content: "",
          tool_calls: [{ id: "tc1", function: { name: "delegate_browser_task", arguments: '{"url":"https://example.com","instructions":"Take a screenshot"}' } }],
        });
      }
      return llmResp({ content: "Browser was disabled" });
    });

    try {
      const result = await router.route(msg("screenshot example.com"));
      expect(result).toBeDefined();
      expect(bridgeCall).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("handoff surfaces the configurable noVNC URL to the main agent", async () => {
    const cfg = { ...config, browser: { enabled: true, novncUrl: "https://vnc.example.com" } };
    const registry = await withBrowser(cfg);
    const router = makeRouter(registry, { browser: cfg.browser });

    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const mock = withSidecar(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
      bodies.push(body);
      const tools = body.tools;
      // Subagent loop: look at window 1, then signal a handoff via browser_done(needs_human=true)
      if (tools?.some((t) => t.function.name === "browser_done")) {
        if (!body.messages.some((m) => m.role === "tool")) {
          return llmResp({ content: "", tool_calls: [{ id: "tc_look", function: { name: "browser_snapshot", arguments: '{"window":1}' } }] });
        }
        return llmResp({ content: "", tool_calls: [{ id: "tc_sub", function: { name: "browser_done", arguments: '{"summary":"hCaptcha is blocking the page","needs_human":true}' } }] });
      }
      // Main agent first call -> delegate; second call -> final answer
      const delegated = bodies.some((b) => b.messages.some((m) => m.role === "tool"));
      if (!delegated) {
        return llmResp({ content: "", tool_calls: [{ id: "tc1", function: { name: "delegate_browser_task", arguments: '{"url":"https://example.com","instructions":"log in"}' } }] });
      }
      return llmResp({ content: "Please take over the browser" });
    });

    try {
      const uniqueMsg: UnifiedMessage = { ...msg("log into example.com"), userId: `handoff-user-${Date.now()}` };
      await router.route(uniqueMsg);
      // The tool result fed back to the main agent must contain the configured noVNC URL
      const toolMessages = bodies.flatMap((b) => b.messages).filter((m) => m.role === "tool");
      const joined = toolMessages.map((m) => String(m.content)).join("\n");
      expect(joined).toContain("https://vnc.example.com");
      expect(joined.toLowerCase()).toContain("take over");
      expect(joined).toContain("hCaptcha is blocking the page");
      // The window the run was in is put on the VNC screen, and the owner is told which one.
      expect(staged).toEqual([{ windowId: 41 }]);
      expect(joined).toContain("Window 1 is on the VNC screen.");
    } finally {
      mock.restore();
    }
  });

  test("delegate surfaces a technical failure (not a fake success) when the subagent fails", async () => {
    // maxSteps=1 + a subagent LLM that never calls browser_done -> the run ends on its last words
    // with no recorded outcome -> delegate must map it to a tool error carrying those words.
    const cfg = { ...config, browser: { enabled: true, maxSteps: 1 } };
    const registry = await withBrowser(cfg);
    const router = makeRouter(registry, { browser: cfg.browser });

    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const mock = withSidecar(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
      bodies.push(body);
      const tools = body.tools;
      // Subagent call (has browser_done): return plain text, no tool calls -> hits max steps
      if (tools?.some((t) => t.function.name === "browser_done")) {
        return llmResp({ content: "still thinking, no action" });
      }
      // Main agent: delegate first, then a final answer once the tool result is back
      const delegated = bodies.some((b) => b.messages.some((m) => m.role === "tool"));
      if (!delegated) {
        return llmResp({ content: "", tool_calls: [{ id: "tc1", function: { name: "delegate_browser_task", arguments: '{"url":"https://example.com","instructions":"do it"}' } }] });
      }
      return llmResp({ content: "The browser task did not complete." });
    });

    try {
      const uniqueMsg: UnifiedMessage = { ...msg("do it"), userId: `fail-user-${Date.now()}` };
      const result = await router.route(uniqueMsg);
      const toolMessages = bodies.flatMap((b) => b.messages).filter((m) => m.role === "tool");
      const joined = toolMessages.map((m) => String(m.content)).join("\n");
      expect(joined).toContain("Error:");
      expect(joined).toContain("still thinking, no action");
      expect(result?.text).toBe("The browser task did not complete.");
    } finally {
      mock.restore();
    }
  });

  test("delegate_browser_task description is visible to the LLM", async () => {
    const registry = await withBrowser(config);
    const router = makeRouter(registry);

    let capturedTools: Array<{ function: { name: string; description: string } }> = [];
    const mock = withSidecar(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedTools = (body.tools ?? []) as Array<{ function: { name: string; description: string } }>;
      return llmResp({ content: "ok" });
    });

    try {
      await router.route(msg("hello"));
      const browserTool = capturedTools.find((t) => t.function.name === "delegate_browser_task");
      expect(browserTool).toBeDefined();
      expect(browserTool!.function.description.toLowerCase()).toContain("screenshot");
    } finally {
      mock.restore();
    }
  });

  test("the browser agent can read its own long results, and gets no general file reader", async () => {
    const registry = await withBrowser(config);
    const names = registry.getForAgent("browser").map((t) => t.name);
    expect(names).toContain("browser_read_output");
    expect(names).not.toContain("read");
  });

  // `url` and `instructions` are no longer schema-required since `kept` moved onto this tool
  // (2026-10-04): a call with `kept` runs no task. The tool refuses a task missing either one
  // (tests/tools/browser-holds.test.ts).
  test("delegate_browser_task offers a task (url, instructions) and the kept windows", async () => {
    const registry = await withBrowser(config);
    const router = makeRouter(registry);

    let capturedTools: Array<{ function: { name: string; parameters: Record<string, unknown> } }> = [];
    const mock = withSidecar(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedTools = (body.tools ?? []) as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
      return llmResp({ content: "ok" });
    });

    try {
      await router.route(msg("hello"));
      const browserTool = capturedTools.find((t) => t.function.name === "delegate_browser_task");
      expect(browserTool).toBeDefined();
      const params = browserTool!.function.parameters as { required?: string[]; properties?: Record<string, unknown> };
      expect(params.properties).toHaveProperty("url");
      expect(params.properties).toHaveProperty("instructions");
      expect(params.properties).toHaveProperty("kept");
      expect(capturedTools.some((t) => t.function.name === "held_browser_windows")).toBe(false);
    } finally {
      mock.restore();
    }
  });

  test("multiple tools including delegate_browser_task are all available", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "calculator",
      description: "simple calc",
      parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] },
      async execute(args) {
        return { success: true, output: String(args["expr"]) };
      },
    });
    registry.register((await withBrowser(config)).get("delegate_browser_task")!);
    const router = makeRouter(registry);

    let capturedToolNames: string[] = [];
    const mock = withSidecar(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const tools = (body.tools ?? []) as Array<{ function: { name: string } }>;
      capturedToolNames = tools.map((t) => t.function.name);
      return llmResp({ content: "ok" });
    });

    try {
      await router.route(msg("hello"));
      expect(capturedToolNames).toContain("calculator");
      expect(capturedToolNames).toContain("delegate_browser_task");
    } finally {
      mock.restore();
    }
  });

  test("tool result with attachments is passed through bridge", async () => {
    const registry = new ToolRegistry();
    const mockAttachment = { type: "image" as const, path: "/tmp/e2e-test.png", mimeType: "image/png" };
    registry.register({
      name: "take_screenshot",
      description: "take a screenshot",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "Screenshot captured.", attachments: [mockAttachment] };
      },
    });
    const router = makeRouter(registry);

    let bridgeCall = 0;
    const mock = withSidecar(async () => {
      bridgeCall++;
      if (bridgeCall === 1) {
        return llmResp({
          content: "",
          tool_calls: [{ id: "tc1", function: { name: "take_screenshot", arguments: "{}" } }],
        });
      }
      return llmResp({ content: "Screenshot taken" });
    });

    try {
      const result = await router.route(msg("take a screenshot"));
      expect(result).toBeDefined();
      expect(result!.text).toBe("Screenshot taken");
      expect(result!.attachments).toBeDefined();
      expect(result!.attachments!.length).toBe(1);
      expect(result!.attachments![0]!.type).toBe("image");
      expect(result!.attachments![0]!.path).toBe("/tmp/e2e-test.png");
    } finally {
      mock.restore();
    }
  });

  test("tool result without attachments produces empty attachments", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "text_only",
      description: "returns text only",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "text result" };
      },
    });
    const router = makeRouter(registry);

    let bridgeCall = 0;
    const mock = withSidecar(async () => {
      bridgeCall++;
      if (bridgeCall === 1) {
        return llmResp({
          content: "",
          tool_calls: [{ id: "tc1", function: { name: "text_only", arguments: "{}" } }],
        });
      }
      return llmResp({ content: "Done" });
    });

    try {
      const result = await router.route(msg("text task"));
      expect(result).toBeDefined();
      expect(result!.text).toBe("Done");
      expect(result!.attachments).toBeDefined();
      expect(result!.attachments!.length).toBe(0);
    } finally {
      mock.restore();
    }
  });

  test("multiple tools returning attachments are all collected", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "shot_a",
      description: "screenshot A",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "A", attachments: [{ type: "image" as const, path: "/tmp/a.png", mimeType: "image/png" }] };
      },
    });
    registry.register({
      name: "shot_b",
      description: "screenshot B",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "B", attachments: [{ type: "image" as const, path: "/tmp/b.png", mimeType: "image/png" }] };
      },
    });
    const router = makeRouter(registry);

    let bridgeCall = 0;
    const mock = withSidecar(async () => {
      bridgeCall++;
      if (bridgeCall === 1) {
        return llmResp({
          content: "",
          tool_calls: [
            { id: "tc1", function: { name: "shot_a", arguments: "{}" } },
            { id: "tc2", function: { name: "shot_b", arguments: "{}" } },
          ],
        });
      }
      return llmResp({ content: "Both screenshots taken" });
    });

    try {
      const result = await router.route(msg("take two screenshots"));
      expect(result).toBeDefined();
      expect(result!.attachments).toBeDefined();
      expect(result!.attachments!.length).toBe(2);
      expect(result!.attachments![0]!.path).toBe("/tmp/a.png");
      expect(result!.attachments![1]!.path).toBe("/tmp/b.png");
    } finally {
      mock.restore();
    }
  });
});
