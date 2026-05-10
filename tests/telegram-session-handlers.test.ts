import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createTelegramCallbackHandler,
  createTelegramCommandHandler,
} from "../src/channels/telegram/session-handlers.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { ModelPicker } from "../src/channels/model-picker.ts";
import type { MyClawConfig } from "../src/core/config.ts";

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

test("telegram session handlers honor DM per-chat session scope", async () => {
  const scopedConfig: MyClawConfig = {
    ...config,
    channels: {
      telegram: {
        token: "test-token",
        dm: {
          sessionScope: "per-chat",
        },
      },
    },
  };
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(scopedConfig.llm.models ?? []);
  const commandHandler = createTelegramCommandHandler({
    config: scopedConfig,
    sessionManager,
    modelPicker,
  });
  const callbackHandler = createTelegramCallbackHandler({
    config: scopedConfig,
    sessionManager,
    modelPicker,
  });

  await commandHandler("c1", "u1", "dm", "model", "alt");

  const statusAfterCommand = await commandHandler("c1", "u1", "dm", "status", "");
  assert.match(String(statusAfterCommand), /Session: telegram\/dm-chat\/c1/);
  assert.match(String(statusAfterCommand), /alt-model/);

  const actionResult = await callbackHandler({
    chatId: "c1",
    userId: "u1",
    chatType: "dm",
    data: "mdl:0",
  });
  assert.match(actionResult?.text ?? "", /Base/);

  const statusAfterAction = await commandHandler("c1", "u1", "dm", "status", "");
  assert.match(String(statusAfterAction), /Session: telegram\/dm-chat\/c1/);
  assert.match(String(statusAfterAction), /base-model/);
});

test("telegram thread commands target only the thread session", async () => {
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(config.llm.models ?? []);
  const commandHandler = createTelegramCommandHandler({ config, sessionManager, modelPicker });

  const roomSessionId = SessionManager.resolveSessionId("telegram", "group", "c1", "u1");
  const threadSessionId = SessionManager.resolveSessionId("telegram", "group", "c1", "u1", {
    threadId: "777",
  });

  const roomSession = await sessionManager.getOrCreateWithMeta(roomSessionId, "telegram", "group");
  roomSession.messages.push({ role: "user", content: "room", timestamp: new Date().toISOString() });
  const threadSession = await sessionManager.getOrCreateWithMeta(threadSessionId, "telegram", "group");
  threadSession.messages.push({ role: "user", content: "thread", timestamp: new Date().toISOString() });

  const response = await commandHandler("c1", "u1", "group", "new", "", { threadId: "777" });
  assert.equal(response, "New session started.");

  const roomAfter = await sessionManager.peek(roomSessionId);
  const threadAfter = await sessionManager.peek(threadSessionId);
  assert.equal(threadAfter?.messages.length, 0);
  assert.equal(roomAfter?.messages.length, 1);
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
