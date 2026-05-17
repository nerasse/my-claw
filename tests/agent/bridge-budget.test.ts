import { test, expect } from "bun:test";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager } from "../../src/voice/index.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

function configWithBudget(maxIterations: number): MyClawConfig {
  return {
    whitelist: ["user1"],
    blacklist: [],
    channels: {},
    llm: {
      defaultProvider: "fireworks",
      defaultModel: "test-model",
      apiKey: "test-key",
      providers: {
        fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY" },
      },
    },
    agents: {
      orchestrator: { maxIterations },
    },
  };
}

function createMessage(): UnifiedMessage {
  return {
    id: "msg-1",
    platform: "telegram",
    userId: "user1",
    chatId: "chat1",
    chatType: "dm",
    text: "do something",
    attachments: [],
    isForwarded: false,
    raw: null,
  };
}

function createSession(): SessionData {
  return {
    id: "session-1",
    platform: "telegram",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

function createBridge(registry: ToolRegistry, maxIterations: number) {
  const config = configWithBudget(maxIterations);
  const voiceManager = new VoiceManager(config);
  return new AgentBridge(
    config,
    registry,
    new SkillRegistry([]),
    voiceManager,
    voiceManager.stt,
    voiceManager.tts,
  );
}

test("AgentBridge requests summary when iteration budget is exhausted", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "demo",
    description: "demo tool",
    parameters: {},
    async execute() {
      return { success: true, output: "ok" };
    },
  });

  const bridge = createBridge(registry, 2);
  const session = createSession();

  let callCount = 0;
  const fetchMock = mockFetch(async (_input, init) => {
    callCount++;
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { tools?: unknown[] };

    if (callCount <= 2) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: `tc${callCount}`, function: { name: "demo", arguments: "{}" } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }

    // Grace call (summary) — must have no tools
    expect(body.tools).toBeUndefined();

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Summary: done with the task." } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const response = await bridge.handleMessage(createMessage(), session);
    expect(response).toBe("Summary: done with the task.");
    expect(callCount).toBe(3);

    // Session should contain the summary prompt injected by handleMaxIterations
    const userMsgs = session.messages.filter((m) => m.role === "user");
    const summaryMsg = userMsgs[userMsgs.length - 1];
    expect(summaryMsg?.content).toContain("maximum number of tool-calling iterations");
  } finally {
    fetchMock.restore();
  }
});

test("AgentBridge stops gracefully after budget with no tools in summary call", async () => {
  const registry = new ToolRegistry();
  const bridge = createBridge(registry, 1);
  const session = createSession();

  let callCount = 0;
  const fetchMock = mockFetch(async (_input, init) => {
    callCount++;
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { tools?: unknown[] };

    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: "tc1", function: { name: "unknown_tool", arguments: "{}" } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }

    expect(body.tools).toBeUndefined();
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const response = await bridge.handleMessage(createMessage(), session);
    expect(response).toBe("I reached the iteration limit and couldn't generate a summary.");
    expect(callCount).toBe(2);
  } finally {
    fetchMock.restore();
  }
});

test("AgentBridge returns plain response before budget is exhausted", async () => {
  const registry = new ToolRegistry();
  const bridge = createBridge(registry, 10);
  const session = createSession();

  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "plain response" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const response = await bridge.handleMessage(createMessage(), session);
    expect(response).toBe("plain response");
    expect(session.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  } finally {
    fetchMock.restore();
  }
});
