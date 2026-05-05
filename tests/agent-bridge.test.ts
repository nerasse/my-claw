import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../src/agent/bridge.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { MyClawConfig } from "../src/config.ts";
import type { UnifiedMessage } from "../src/channels/types.ts";
import type { SessionData } from "../src/sessions/store.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
};

function createMessage(): UnifiedMessage {
  return {
    id: "m1",
    platform: "telegram",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function createSession(): SessionData {
  return {
    id: "telegram/dm/u1",
    platform: "telegram",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
  };
}

test("AgentBridge returns plain LLM response", async () => {
  const registry = new ToolRegistry();
  const bridge = new AgentBridge(config, registry);
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hi back" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );

  try {
    const session = createSession();
    const response = await bridge.handleMessage(createMessage(), session);
    assert.equal(response, "hi back");
    assert.equal(session.messages.length, 2);
  } finally {
    fetchMock.mock.restore();
  }
});

test("AgentBridge executes tool calls and supports model override", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "demo",
    description: "demo tool",
    parameters: {},
    async execute() {
      return { success: true, output: "tool ok" };
    },
  });
  const bridge = new AgentBridge(config, registry);
  const seenModels: string[] = [];
  let callCount = 0;

  const fetchMock = mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    seenModels.push(body.model ?? "");

    if (callCount++ === 0) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "tc1",
                    function: { name: "demo", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }

    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "done" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    const session = createSession();
    session.modelOverride = "override-model";
    const response = await bridge.handleMessage(createMessage(), session);
    assert.equal(response, "done");
    assert.deepEqual(seenModels, ["override-model", "override-model"]);
    assert.equal(session.messages.some((message) => message.role === "tool"), true);
  } finally {
    fetchMock.mock.restore();
  }
});
