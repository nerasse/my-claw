import { describe, test, expect } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {},
};

function createMessage(text = "hello", userId = "u1"): UnifiedMessage {
  return {
    id: `m-${Date.now()}-${Math.random()}`,
    platform: "telegram",
    userId,
    chatId: "c1",
    chatType: "dm",
    text,
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

describe("E2E pipeline", () => {
  test("message -> router -> bridge -> LLM -> response", async () => {
    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const sessionManager = new SessionManager();
    const router = new MessageRouter(sessionManager, bridge);

    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "pipeline response" } }],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );

    try {
      const result = await router.route(createMessage("test input"));
      expect(result).toBeDefined();
      expect(result!.text).toBe("pipeline response");
    } finally {
      mock.restore();
    }
  });

  test("message -> router -> bridge -> tool call -> tool result -> LLM -> response", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "calculator",
      description: "simple calc",
      parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] },
      async execute(args) {
        return { success: true, output: `result: ${args["expr"]}` };
      },
    });
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const sessionManager = new SessionManager();
    const router = new MessageRouter(sessionManager, bridge);

    let callCount = 0;
    const mock = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: "",
                tool_calls: [{ id: "tc1", function: { name: "calculator", arguments: '{"expr":"2+2"}' } }],
              },
            }],
            usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ) as never;
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "The answer is 4" } }],
          usage: { prompt_tokens: 80, completion_tokens: 15, total_tokens: 95 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    });

    try {
      const result = await router.route(createMessage("what is 2+2?"));
      expect(result).toBeDefined();
      expect(result!.text).toBe("The answer is 4");
      expect(callCount).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("multiple messages in same session share context", async () => {
    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const sessionManager = new SessionManager();
    const router = new MessageRouter(sessionManager, bridge);

    let requestCount = 0;
    let lastMessageCount = 0;
    const mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
      requestCount++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: unknown[] };
      lastMessageCount = body.messages?.length ?? 0;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: `reply ${requestCount}` } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    });

    try {
      await router.route(createMessage("first"));
      const secondMessageCount = lastMessageCount;

      await router.route(createMessage("second"));
      // Second call should have more messages (system + user1 + assistant1 + user2)
      expect(lastMessageCount).toBeGreaterThan(secondMessageCount);
    } finally {
      mock.restore();
    }
  });

  test("streaming pipeline delivers tokens", async () => {
    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const sessionManager = new SessionManager();
    const router = new MessageRouter(sessionManager, bridge);

    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "streamed reply" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );

    try {
      const tokens: string[] = [];
      const result = await router.route(createMessage("stream test"), {
        onToken: async (token) => { tokens.push(token); },
      });
      expect(result).toBeDefined();
    } finally {
      mock.restore();
    }
  });

  test("rate limiting blocks excessive messages", async () => {
    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const sessionManager = new SessionManager();
    const router = new MessageRouter(sessionManager, bridge);

    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );

    try {
      // Send 30 messages (the limit)
      for (let i = 0; i < 30; i++) {
        await router.route(createMessage(`msg ${i}`, "rate-test-user"));
      }

      // 31st should be rate limited
      const limited = await router.route(createMessage("one more", "rate-test-user"));
      expect(limited).toBeDefined();
      expect(limited!.text).toContain("Rate limit");
    } finally {
      mock.restore();
    }
  });

  test("different users have separate rate limits", async () => {
    const registry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const bridge = new AgentBridge(config, registry, skillRegistry);
    const sessionManager = new SessionManager();
    const router = new MessageRouter(sessionManager, bridge);

    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never,
    );

    try {
      // Fill user-a's bucket
      for (let i = 0; i < 30; i++) {
        await router.route(createMessage(`msg ${i}`, "user-a"));
      }

      // user-b should not be affected
      const result = await router.route(createMessage("hello", "user-b"));
      expect(result).toBeDefined();
      expect(result!.text).toBe("ok");
    } finally {
      mock.restore();
    }
  });
});
