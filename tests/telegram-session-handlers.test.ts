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

test("telegram model submenu navigates without changing the session, then selects", async () => {
  const groupedConfig: MyClawConfig = {
    ...config,
    llm: {
      ...config.llm,
      models: [
        { id: "base-model", label: "Base" },
        { id: "claude-sonnet-5", label: "sonnet", group: "Claude" },
        { id: "claude-opus-4-8", label: "opus", group: "Claude" },
      ],
    },
  };
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(groupedConfig.llm.models ?? []);
  const callbackHandler = createTelegramCallbackHandler({ config: groupedConfig, sessionManager, modelPicker });
  const commandHandler = createTelegramCommandHandler({ config: groupedConfig, sessionManager, modelPicker });

  // Open the Claude submenu: menu re-renders, model unchanged (still default).
  const opened = await callbackHandler({ chatId: "c1", userId: "u1", chatType: "dm", data: "mdlg:0" });
  assert.match(opened?.text ?? "", /Claude/);
  assert.ok(opened?.buttons?.some((b) => b.action === "mdl:2"));
  assert.ok(opened?.buttons?.some((b) => b.action === "mdlb"));
  const afterOpen = await commandHandler("c1", "u1", "dm", "status", "");
  assert.match(String(afterOpen), /base-model/);

  // Back to root: still unchanged.
  const back = await callbackHandler({ chatId: "c1", userId: "u1", chatType: "dm", data: "mdlb" });
  assert.ok(back?.buttons?.some((b) => b.action === "mdlg:0"));

  // Select opus from within the group.
  const selected = await callbackHandler({ chatId: "c1", userId: "u1", chatType: "dm", data: "mdl:2" });
  assert.match(selected?.text ?? "", /opus/);
  const afterSelect = await commandHandler("c1", "u1", "dm", "status", "");
  assert.match(String(afterSelect), /claude-opus-4-8/);
});

test("telegram effort: menu, callback set, and /effort arg persist to session", async () => {
  const effortConfig: MyClawConfig = {
    ...config,
    llm: {
      ...config.llm,
      effort: "high",
      providers: { anthropic: { type: "claude-sdk" } },
      models: [{ id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" }],
    },
  };
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(effortConfig.llm.models ?? [], { enabled: true, levels: ["low", "medium", "high", "xhigh", "max"] });
  const commandHandler = createTelegramCommandHandler({ config: effortConfig, sessionManager, modelPicker });
  const callbackHandler = createTelegramCallbackHandler({ config: effortConfig, sessionManager, modelPicker });

  // /model root shows an effort entry.
  const menu = await commandHandler("c1", "u1", "dm", "model", "");
  assert.ok((menu as { buttons?: { action: string }[] }).buttons?.some((b) => b.action === "effm"));

  // Open effort menu, then set via callback.
  const opened = await callbackHandler({ chatId: "c1", userId: "u1", chatType: "dm", data: "effm" });
  assert.ok(opened?.buttons?.some((b) => b.action === "eff:max"));
  const set = await callbackHandler({ chatId: "c1", userId: "u1", chatType: "dm", data: "eff:max" });
  assert.match(set?.text ?? "", /max/);

  const sessionId = SessionManager.resolveSessionId("telegram", "dm", "c1", "u1");
  assert.equal((await sessionManager.peek(sessionId))?.effortOverride, "max");

  // /effort low via text arg.
  const viaArg = await commandHandler("c1", "u1", "dm", "effort", "low");
  assert.match(String(viaArg), /Effort set to low/);
  assert.equal((await sessionManager.peek(sessionId))?.effortOverride, "low");

  // Unknown level rejected.
  const bad = await commandHandler("c1", "u1", "dm", "effort", "bogus");
  assert.match(String(bad), /Unknown effort/);
});

test("telegram model selection chains into effort and terminal steps close the menu", async () => {
  const effortConfig: MyClawConfig = {
    ...config,
    llm: {
      ...config.llm,
      effort: "high",
      providers: { anthropic: { type: "claude-sdk" } },
      models: [{ id: "claude-sonnet-5", label: "Sonnet", provider: "anthropic" }],
    },
  };
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(effortConfig.llm.models ?? [], { enabled: true, levels: ["low", "high"] });
  const callbackHandler = createTelegramCallbackHandler({ config: effortConfig, sessionManager, modelPicker });

  // Selecting a model chains into the effort keyboard with a keep-current entry.
  const selected = await callbackHandler({ chatId: "c1", userId: "u1", chatType: "dm", data: "mdl:0" });
  assert.match(selected?.text ?? "", /Model changed to Sonnet — now choose reasoning effort/);
  assert.ok(selected?.buttons?.some((b) => b.action === "eff:low"));
  assert.ok(selected?.buttons?.some((b) => b.action === "effk"));

  // keepEffort closes the menu without touching the session's effort.
  const kept = await callbackHandler({ chatId: "c1", userId: "u1", chatType: "dm", data: "effk" });
  assert.equal(kept?.buttons, undefined);
  assert.match(kept?.text ?? "", /effort unchanged \(high\)/);
  const sessionId = SessionManager.resolveSessionId("telegram", "dm", "c1", "u1");
  assert.equal((await sessionManager.peek(sessionId))?.effortOverride, undefined);

  // setEffort closes the menu (no keyboard bounce back to root).
  const set = await callbackHandler({ chatId: "c1", userId: "u1", chatType: "dm", data: "eff:low" });
  assert.equal(set?.buttons, undefined);
  assert.match(set?.text ?? "", /Effort set to low — model: Sonnet/);
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
