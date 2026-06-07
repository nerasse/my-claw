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
  return { id: "m1", platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text: "hi", attachments: [], isForwarded: false, raw: {} };
}
function createSession(): SessionData {
  return { id: "telegram/dm/u1", platform: "telegram", chatType: "dm", createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), messages: [] };
}

test("bridge: an empty tool output is encapsulated with a placeholder (never empty)", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "silent",
    description: "returns nothing",
    parameters: {},
    async execute() {
      return { success: true, output: "" };
    },
  });
  const bridge = new AgentBridge(config, registry, new SkillRegistry());

  let call = 0;
  const fetchMock = mockFetch(async () => {
    if (call++ === 0) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "silent", arguments: "{}" } }] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
  });

  try {
    const session = createSession();
    await bridge.handleMessage(createMessage(), session);
    const toolMsg = session.messages.find((m) => m.role === "tool" && m.toolCallId === "tc1") as { content: string } | undefined;
    assert.ok(toolMsg, "tool result recorded");
    assert.ok(toolMsg.content.trim().length > 0, "tool result content is not empty");
    assert.match(toolMsg.content, /empty response/i);
  } finally {
    fetchMock.restore();
  }
});
