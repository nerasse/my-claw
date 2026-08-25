import { test, expect, beforeEach, afterEach } from "bun:test";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline, TtsPipeline } from "../../src/voice/index.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { SessionLog, UserEntry, PhaseEntry } from "../../src/sessions/log.ts";

const SESSION_ID = "test-budget";

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

function createSession(): LegacySessionData {
  return {
    id: SESSION_ID,
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

let log: SessionLog;
let cleanupLog: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, createSession());
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
});

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

    // Check log for the summary prompt injected by handleMaxIterations
    await log.flush();
    const entries = log.entries();
    const userEntries = entries.filter((e): e is UserEntry => e.type === "user");
    const summaryEntry = userEntries[userEntries.length - 1];
    expect(summaryEntry?.text).toContain("maximum number of tool-calling iterations");
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
  const registry = new ToolRegistry();
  registry.register({
    name: "demo",
    description: "demo tool",
    parameters: {},
    async execute() {
      return { success: true, output: "ok" };
    },
  });

  const config = configWithBudget(10);
  config.cron = { enabled: true, maxIterations: 1 };
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

    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: "tc1", function: { name: "demo", arguments: "{}" } }],
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
        choices: [{ message: { content: "Cron summary." } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const response = await bridge.handleMessage(cronMessage, session);
    expect(response).toBe("Cron summary.");
    expect(callCount).toBe(2);
  } finally {
    fetchMock.restore();
  }
});

test("AgentBridge returns plain response before budget is exhausted", async () => {
  const registry = new ToolRegistry();
  const config = configWithBudget(5);
  const voiceManager = new VoiceManager(config);
  const bridge = new AgentBridge(
    config,
    registry,
    new SkillRegistry(),
    voiceManager,
    new SttPipeline(voiceManager),
  );

  const session = createSession();

  const fetchMock = mockFetch(async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "plain response" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const response = await bridge.handleMessage(createMessage(), session);
    expect(response).toBe("plain response");
    
    // Check log for the assistant response
    await log.flush();
    const entries = log.entries();
    const phaseEntries = entries.filter((e): e is PhaseEntry => e.type === "phase");
    expect(phaseEntries.length).toBe(1);
  } finally {
    fetchMock.restore();
  }
});
