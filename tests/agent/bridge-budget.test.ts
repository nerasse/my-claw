import { test, expect } from "bun:test";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline, TtsPipeline } from "../../src/voice/index.ts";
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
    platform: "my-claw-app",
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
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

function createBridge(registry: ToolRegistry, maxIterations: number) {
  const config = configWithBudget(maxIterations);
  const voiceManager = new VoiceManager(config);
  const sttPipeline = new SttPipeline(voiceManager);
  const ttsPipeline = new TtsPipeline(voiceManager);
  return new AgentBridge(
    config,
    registry,
    new SkillRegistry(),
    voiceManager,
    sttPipeline,
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

test("cron messages use config.cron.maxIterations, not the orchestrator budget", async () => {
  // The cron runaway guard must cap the loop regardless of the (much larger) orchestrator budget.
  const registry = new ToolRegistry();
  registry.register({
    name: "demo",
    description: "demo tool",
    parameters: {},
    async execute() {
      return { success: true, output: "ok" };
    },
  });

  const config = configWithBudget(10); // orchestrator budget = 10
  config.cron = { enabled: true, maxIterations: 1 }; // cron budget = 1
  const voiceManager = new VoiceManager(config);
  const bridge = new AgentBridge(
    config,
    registry,
    new SkillRegistry(),
    voiceManager,
    new SttPipeline(voiceManager),
  );

  const cronMessage: UnifiedMessage = { ...createMessage(), platform: "cron" };
  const session = createSession();

  let callCount = 0;
  const fetchMock = mockFetch(async (_input, init) => {
    callCount++;
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { tools?: unknown[] };
    // Always ask for another tool call; only the budget can stop the loop.
    if (body.tools !== undefined) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "", tool_calls: [{ id: `tc${callCount}`, function: { name: "demo", arguments: "{}" } }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    // Grace/summary call (no tools) once the budget is spent.
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "cron summary" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const response = await bridge.handleMessage(cronMessage, session);
    expect(response).toBe("cron summary");
    // budget 1 -> exactly one tool-calling round (call 1) + one grace call (call 2).
    // Had it used the orchestrator budget of 10, callCount would be 11.
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
