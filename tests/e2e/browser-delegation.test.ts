import { describe, test, expect, afterEach } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { createDelegateBrowserTool } from "../../src/tools/browser.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {},
  memory: { enabled: false },
  browser: { enabled: true, cdpUrl: "http://127.0.0.1:9222" },
};

function msg(text: string): UnifiedMessage {
  return {
    id: `m-${Date.now()}-${Math.random()}`,
    platform: "telegram",
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

function makeRouter(reg: ToolRegistry, cfg?: Partial<MyClawConfig>): MessageRouter {
  const merged = { ...config, ...cfg };
  return new MessageRouter(new SessionManager(), new AgentBridge(merged, reg, new SkillRegistry()), merged);
}

describe("E2E browser delegation", () => {
  afterEach(() => {
    runRegistry.clear();
  });

  test("delegate_browser_task through router returns response", async () => {
    const registry = new ToolRegistry();
    registry.register(createDelegateBrowserTool(config));
    const router = makeRouter(registry);

    let bridgeCall = 0;
    let subagentCall = 0;
    const mock = mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const tools = body.tools as Array<{ function: { name: string } }> | undefined;

      // Subagent calls have "browser_done" in tools
      if (tools?.some((t) => t.function.name === "browser_done")) {
        subagentCall++;
        return llmResp({ content: "", tool_calls: [{ id: "tc_sub", function: { name: "browser_done", arguments: '{"summary":"Screenshot taken"}' } }] });
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
      expect(subagentCall).toBe(1);
    } finally {
      mock.restore();
    }
  });

  test("delegate_browser_task returns tool error when browser is disabled", async () => {
    const disabledConfig = { ...config, browser: { enabled: false } };
    const registry = new ToolRegistry();
    registry.register(createDelegateBrowserTool(disabledConfig));
    const router = makeRouter(registry, { browser: { enabled: false } });

    let bridgeCall = 0;
    const mock = mockFetch(async () => {
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

  test("delegate_browser_task description is visible to the LLM", async () => {
    const registry = new ToolRegistry();
    registry.register(createDelegateBrowserTool(config));
    const router = makeRouter(registry);

    let capturedTools: Array<{ function: { name: string; description: string } }> = [];
    const mock = mockFetch(async (_url, init) => {
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

  test("delegate_browser_task has url and instructions as required params", async () => {
    const registry = new ToolRegistry();
    registry.register(createDelegateBrowserTool(config));
    const router = makeRouter(registry);

    let capturedTools: Array<{ function: { name: string; parameters: Record<string, unknown> } }> = [];
    const mock = mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedTools = (body.tools ?? []) as Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
      return llmResp({ content: "ok" });
    });

    try {
      await router.route(msg("hello"));
      const browserTool = capturedTools.find((t) => t.function.name === "delegate_browser_task");
      expect(browserTool).toBeDefined();
      const params = browserTool!.function.parameters as { required?: string[]; properties?: Record<string, unknown> };
      expect(params.required).toContain("url");
      expect(params.required).toContain("instructions");
      expect(params.properties).toHaveProperty("url");
      expect(params.properties).toHaveProperty("instructions");
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
    registry.register(createDelegateBrowserTool(config));
    const router = makeRouter(registry);

    let capturedToolNames: string[] = [];
    const mock = mockFetch(async (_url, init) => {
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
    const mock = mockFetch(async () => {
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
      expect(result!.attachments![0].type).toBe("image");
      expect(result!.attachments![0].path).toBe("/tmp/e2e-test.png");
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
    const mock = mockFetch(async () => {
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
    const mock = mockFetch(async () => {
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
      expect(result!.attachments![0].path).toBe("/tmp/a.png");
      expect(result!.attachments![1].path).toBe("/tmp/b.png");
    } finally {
      mock.restore();
    }
  });
});
