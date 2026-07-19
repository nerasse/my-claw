import { test } from "bun:test";
import assert from "node:assert/strict";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { MessageRouter } from "../../src/core/router.ts";
import { ModelPicker } from "../../src/channels/model-picker.ts";
import { createTelegramCommandHandler } from "../../src/channels/telegram/session-handlers.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { deleteSession } from "../../src/sessions/store.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { mockFetch } from "../../tests/helpers/mock-fetch.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

const config: MyClawConfig = {
  whitelist: ["user-1"],
  blacklist: [],
  channels: {},
  llm: {
    provider: "test",
    baseUrl: "https://example.com",
    model: "default-model",
    models: [
      { id: "default-model", label: "Default" },
      { id: "selected-model", label: "Selected" },
    ],
  },
  agents: {},
};

test("Telegram keeps the selected model across /new for the next routed message", async () => {
  const sessionManager = new SessionManager();
  const commandHandler = createTelegramCommandHandler({
    config,
    sessionManager,
    modelPicker: new ModelPicker(config.llm.models ?? []),
  });
  const sessionId = SessionManager.resolveSessionId("telegram", "dm", "chat-1", "user-1");
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const router = new MessageRouter(sessionManager, bridge);
  let requestedModel = "";
  let requestMessages: Array<{ role?: string; content?: string }> = [];
  const mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      messages?: Array<{ role?: string; content?: string }>;
    };
    requestedModel = body.model ?? "";
    requestMessages = body.messages ?? [];
    if (requestedModel === "default-model") {
      return new Response(
        JSON.stringify({ error: { message: "Insufficient balance" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ) as never;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });

  try {
    await commandHandler("chat-1", "user-1", "dm", "model", "selected");
    const session = await sessionManager.peek(sessionId);
    assert.ok(session);
    session.messages.push({ role: "user", content: "old conversation", timestamp: new Date().toISOString() });
    await sessionManager.persist(sessionId);

    const resetResponse = await commandHandler("chat-1", "user-1", "dm", "new", "");
    assert.equal(resetResponse, "New session started.");

    const routed = await router.route({
      id: "message-1",
      platform: "telegram",
      userId: "user-1",
      chatId: "chat-1",
      chatType: "dm",
      text: "hello after reset",
      attachments: [],
      isForwarded: false,
      raw: {},
    });

    assert.equal(routed?.text, "ok");
    assert.equal(requestedModel, "selected-model");
    const userMessages = requestMessages.filter((message) => message.role === "user");
    assert.equal(userMessages.length, 1);
    assert.match(userMessages[0]?.content ?? "", /hello after reset/);
    assert.doesNotMatch(userMessages[0]?.content ?? "", /old conversation/);
  } finally {
    mock.restore();
    await deleteSession(sessionId);
  }
});
