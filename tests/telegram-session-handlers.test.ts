import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramCallbackHandler,
  createTelegramCommandHandler,
} from "../src/channels/telegram-session-handlers.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { ModelPicker } from "../src/channels/model-picker.ts";
import type { MyClawConfig } from "../src/config.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: {
    provider: "x",
    baseUrl: "https://example.com",
    model: "base-model",
    models: [
      { id: "base-model", label: "Base" },
      { id: "alt-model", label: "Alt" },
    ],
  },
  agents: {},
};

test("telegram session handlers manage model and status", async () => {
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(config.llm.models ?? []);
  const commandHandler = createTelegramCommandHandler({ config, sessionManager, modelPicker });
  const callbackHandler = createTelegramCallbackHandler({ config, sessionManager, modelPicker });

  const modelMenu = await commandHandler("c1", "u1", "dm", "model", "");
  assert.equal(typeof modelMenu, "object");

  const callbackResult = await callbackHandler({ chatId: "c1", userId: "u1", chatType: "dm", data: "mdl:1" });
  assert.match(callbackResult?.text ?? "", /Alt/);

  const status = await commandHandler("c1", "u1", "dm", "status", "");
  assert.match(String(status), /alt-model/);

  const directSwitch = await commandHandler("c1", "u1", "dm", "model", "base");
  assert.match(String(directSwitch), /Model changed/);

  const cleared = await commandHandler("c1", "u1", "dm", "clear", "");
  assert.equal(cleared, "History cleared.");
});

test("telegram /new resets the DM session", async () => {
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(config.llm.models ?? []);
  const commandHandler = createTelegramCommandHandler({ config, sessionManager, modelPicker });

  const sessionId = SessionManager.resolveSessionId("telegram", "dm", "c1", "u1");
  const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", "dm");
  session.messages.push({ role: "user", content: "old", timestamp: new Date().toISOString() });
  await sessionManager.persist(sessionId);

  const response = await commandHandler("c1", "u1", "dm", "new", "");
  assert.equal(response, "New session started.");

  const reset = await sessionManager.peek(sessionId);
  assert.equal(reset?.messages.length, 0);
});

test("telegram /archive purge removes archived sessions", async () => {
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(config.llm.models ?? []);
  const commandHandler = createTelegramCommandHandler({ config, sessionManager, modelPicker });

  const sessionId = SessionManager.resolveSessionId("telegram", "dm", "c1", "u1");
  await sessionManager.getOrCreateWithMeta(sessionId, "telegram", "dm");
  await sessionManager.persist(sessionId);
  await sessionManager.resetSession(sessionId, "telegram", "dm");

  const response = await commandHandler("c1", "u1", "dm", "archive", "all");
  assert.match(String(response), /Archived sessions deleted/);
});
