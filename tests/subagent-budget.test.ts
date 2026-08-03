import { test, expect } from "bun:test";
import { SubAgentRunner } from "../src/subagents/runner.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../src/voice/index.ts";
import { mockFetch } from "./helpers/mock-fetch.ts";
import type { MyClawConfig } from "../src/core/config.ts";
import type { UnifiedMessage } from "../src/channels/types.ts";

const baseConfig: MyClawConfig = {
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
    general: { maxIterations: 5 },
    research: { maxIterations: 5 },
  },
};

function createParentMessage(): UnifiedMessage {
  return {
    id: "msg-1",
    platform: "telegram",
    userId: "user1",
    chatId: "chat1",
    chatType: "dm",
    text: "parent task",
    attachments: [],
    isForwarded: false,
    raw: null,
  };
}

function createRunner() {
  const voiceManager = new VoiceManager(baseConfig);
  const sttPipeline = new SttPipeline(voiceManager);
  return new SubAgentRunner(
    baseConfig,
    new ToolRegistry(),
    new SkillRegistry(),
    voiceManager,
    sttPipeline,
  );
}

test("SubAgentRunner uses isolated iteration budget from config", async () => {
  const runner = createRunner();
  let callCount = 0;

  const fetchMock = mockFetch(async (_input, init) => {
    callCount++;
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { tools?: unknown[] };

    if (callCount <= 5) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: `tc${callCount}`, function: { name: "bash", arguments: "{}" } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }

    // Grace call (no tools allowed)
    expect(body.tools).toBeUndefined();
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: `Sub-agent summary after ${callCount} calls.` } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const { result } = await runner.spawn({
      displayName: "tester",
      type: "general",
      mode: "run",
      task: "do work",
      parentMessage: createParentMessage(),
      existingIds: new Set(),
      generateId: (n: string, e: Set<string>) => {
        let i = 1;
        while (e.has(`${n}-${i}`)) i++;
        return `${n}-${i}`;
      },
      parentSessionId: "matrix/room/!caller:test",
      visibility: "global",
    });

    expect(result).toBe("Sub-agent summary after 6 calls.");
    expect(callCount).toBe(6); // 5 tool iterations + 1 grace summary
  } finally {
    fetchMock.restore();
  }
});

test("SubAgentRunner budget does not affect parent bridge budget", async () => {
  // This test verifies architectural isolation: the sub-agent creates its own
  // IterationBudget internally and passes it to AgentBridge. The parent would
  // have its own separate budget (tested in bridge-budget.test.ts).
  const runner = createRunner();
  let callCount = 0;

  const fetchMock = mockFetch(async () => {
    callCount++;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: `reply-${callCount}` } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const { result } = await runner.spawn({
      displayName: "tester",
      type: "research",
      mode: "run",
      task: "quick task",
      parentMessage: createParentMessage(),
      existingIds: new Set(),
      generateId: (n: string, e: Set<string>) => {
        let i = 1;
        while (e.has(`${n}-${i}`)) i++;
        return `${n}-${i}`;
      },
      parentSessionId: "matrix/room/!caller:test",
      visibility: "global",
    });

    expect(result).toBe("reply-1");
    expect(callCount).toBe(1);
  } finally {
    fetchMock.restore();
  }
});
