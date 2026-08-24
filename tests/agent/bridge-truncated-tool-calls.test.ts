import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
  memory: { enabled: false },
};

function createMessage(): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
}
function createSession(): SessionData {
  return { id: "my-claw-app/dm/u1", platform: "my-claw-app", chatType: "dm", createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [] };
}

// A turn cut off on `length` carries tool calls whose JSON arguments stop mid-value. A permissive
// parse "repairs" them into something shorter but valid, and the side effect goes through with a
// truncated payload. The calls must come back as errors instead.
test("bridge: tool calls from a turn cut off by the output limit are refused, not executed", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "write_thing",
    description: "writes",
    parameters: { type: "object", properties: { content: { type: "string" } } },
    async execute() {
      executions++;
      return { success: true, output: "written" };
    },
  });
  const bridge = new AgentBridge(config, registry, new SkillRegistry());

  let call = 0;
  const fetchMock = mockFetch(async () => {
    if (call++ === 0) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "length",
              message: {
                content: "writing it now",
                tool_calls: [{ id: "tc1", function: { name: "write_thing", arguments: '{"content":"half of the fi' } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok, reissuing smaller" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never;
  });

  try {
    const session = createSession();
    await bridge.handleMessage(createMessage(), session);
    assert.equal(executions, 0, "the truncated call never reached the tool");
    const toolMsg = session.messages.find((m) => m.role === "tool" && m.toolCallId === "tc1") as { content: string } | undefined;
    assert.ok(toolMsg, "the model still gets a result for the call it made");
    assert.match(toolMsg.content, /cut off by the output limit/i);
  } finally {
    fetchMock.restore();
  }
});

test("bridge: the same call runs normally when the turn finished cleanly", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: "write_thing",
    description: "writes",
    parameters: { type: "object", properties: { content: { type: "string" } } },
    async execute() {
      executions++;
      return { success: true, output: "written" };
    },
  });
  const bridge = new AgentBridge(config, registry, new SkillRegistry());

  let call = 0;
  const fetchMock = mockFetch(async () => {
    if (call++ === 0) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: { content: "", tool_calls: [{ id: "tc1", function: { name: "write_thing", arguments: '{"content":"all of it"}' } }] },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as never;
  });

  try {
    await bridge.handleMessage(createMessage(), createSession());
    assert.equal(executions, 1);
  } finally {
    fetchMock.restore();
  }
});
