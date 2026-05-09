import test from "node:test";
import assert from "node:assert/strict";
import {
  createMatrixApprovalHandler,
  createMatrixActionHandler,
  createMatrixCommandHandler,
} from "../src/channels/matrix/session-handlers.ts";
import { editPendingActionMessage } from "../src/channels/matrix/actions.ts";
import { getMatrixHelpText } from "../src/channels/matrix/commands.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { ModelPicker } from "../src/channels/model-picker.ts";
import type { MyClawConfig } from "../src/core/config.ts";

const config: MyClawConfig = {
  whitelist: ["@u1:example.org"],
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

test("matrix session handlers manage model and status", async () => {
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(config.llm.models ?? []);
  const commandHandler = createMatrixCommandHandler({ config, sessionManager, modelPicker });
  const actionHandler = createMatrixActionHandler({ config, sessionManager, modelPicker });

  const modelMessage = await commandHandler("!room:test", "@u1:example.org", "dm", "model", "");
  assert.equal(typeof modelMessage, "object");
  assert.match(String((modelMessage as { text?: string }).text ?? ""), /Current model/);
  assert.match(String((modelMessage as { text?: string }).text ?? ""), /Reply with a number\/name/i);

  const switched = await commandHandler("!room:test", "@u1:example.org", "dm", "model", "2");
  assert.match(String(switched), /Model changed to Alt/);

  const actionResult = await actionHandler({
    chatId: "!room:test",
    userId: "@u1:example.org",
    chatType: "dm",
    data: "mdl:0",
    messageId: "$menu",
  });
  assert.match(actionResult?.text ?? "", /Model changed to Base/);

  const status = await commandHandler("!room:test", "@u1:example.org", "dm", "status", "");
  assert.match(String(status), /base-model/);

  const cleared = await commandHandler("!room:test", "@u1:example.org", "dm", "clear", "");
  assert.equal(cleared, "History cleared.");
});

test("matrix help text includes command discoverability tips", () => {
  const help = getMatrixHelpText();
  assert.match(help, /Matrix commands:/);
  assert.match(help, /Reply with a menu number/i);
  assert.match(help, /replies work for every numbered option/i);
  assert.match(help, /Use `\/model` with no args/i);
  assert.match(help, /Use `\/models` to browse/i);
  assert.match(help, /Use `\/commands` to list commands explicitly/i);
});

test("matrix model menu copy explains replies beyond ten options", async () => {
  const bigConfig: MyClawConfig = {
    ...config,
    llm: {
      ...config.llm,
      models: Array.from({ length: 12 }, (_, index) => ({
        id: `model-${index + 1}`,
        label: `Model ${index + 1}`,
      })),
      model: "model-1",
    },
  };
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(bigConfig.llm.models ?? []);
  const commandHandler = createMatrixCommandHandler({ config: bigConfig, sessionManager, modelPicker });

  const modelMessage = await commandHandler("!room:test", "@u1:example.org", "dm", "model", "");
  assert.equal(typeof modelMessage, "object");
  assert.match(
    String((modelMessage as { text?: string }).text ?? ""),
    /Reply with a number\/name for any option, react to this message for the first 10/i,
  );
});

test("matrix session handlers list models and improve unknown-model guidance", async () => {
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(config.llm.models ?? []);
  const commandHandler = createMatrixCommandHandler({ config, sessionManager, modelPicker });

  const models = await commandHandler("!room:test", "@u1:example.org", "dm", "models", "");
  assert.match(String(models), /Available models:/);
  assert.match(String(models), /1\. Base/);
  assert.match(String(models), /2\. Alt/);

  const invalid = await commandHandler("!room:test", "@u1:example.org", "dm", "model", "missing-model");
  assert.match(String(invalid), /Unknown model: missing-model/);
  assert.match(String(invalid), /Use `\/models` to browse configured models/i);
});

test("matrix session handlers honor DM per-room session scope", async () => {
  const scopedConfig: MyClawConfig = {
    ...config,
    channels: {
      matrix: {
        homeserver: "https://example.com",
        accessToken: "token",
        dm: {
          sessionScope: "per-room",
        },
      },
    },
  };
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(scopedConfig.llm.models ?? []);
  const commandHandler = createMatrixCommandHandler({
    config: scopedConfig,
    sessionManager,
    modelPicker,
  });
  const actionHandler = createMatrixActionHandler({
    config: scopedConfig,
    sessionManager,
    modelPicker,
  });

  await commandHandler("!dm-room:test", "@u1:example.org", "dm", "model", "2", { roomId: "!dm-room:test" });

  const statusAfterCommand = await commandHandler("!dm-room:test", "@u1:example.org", "dm", "status", "", {
    roomId: "!dm-room:test",
  });
  assert.match(String(statusAfterCommand), /Session: matrix\/dm-room\/!dm-room:test/);
  assert.match(String(statusAfterCommand), /alt-model/);

  const actionResult = await actionHandler({
    chatId: "!dm-room:test",
    userId: "@u1:example.org",
    chatType: "dm",
    data: "mdl:0",
    messageId: "$menu",
  });
  assert.match(actionResult?.text ?? "", /Model changed to Base/);

  const statusAfterAction = await commandHandler("!dm-room:test", "@u1:example.org", "dm", "status", "", {
    roomId: "!dm-room:test",
  });
  assert.match(String(statusAfterAction), /Session: matrix\/dm-room\/!dm-room:test/);
  assert.match(String(statusAfterAction), /base-model/);
});

test("matrix /new resets the targeted session", async () => {
  const scopedConfig: MyClawConfig = {
    ...config,
    channels: {
      matrix: {
        homeserver: "https://example.com",
        accessToken: "token",
        dm: {
          sessionScope: "per-room",
        },
      },
    },
  };
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(scopedConfig.llm.models ?? []);
  const commandHandler = createMatrixCommandHandler({
    config: scopedConfig,
    sessionManager,
    modelPicker,
  });

  const sessionId = SessionManager.resolveSessionId("matrix", "dm", "!dm-room:test", "@u1:example.org", {
    roomId: "!dm-room:test",
    sessionScope: "per-room",
  });
  const session = await sessionManager.getOrCreateWithMeta(sessionId, "matrix", "dm");
  session.messages.push({ role: "user", content: "old", timestamp: new Date().toISOString() });
  await sessionManager.persist(sessionId);

  const response = await commandHandler("!dm-room:test", "@u1:example.org", "dm", "new", "", {
    roomId: "!dm-room:test",
  });

  assert.equal(response, "New session started.");
  const reset = await sessionManager.peek(sessionId);
  assert.equal(reset?.messages.length, 0);
});

test("matrix /new in thread only resets the thread session", async () => {
  const scopedConfig: MyClawConfig = {
    ...config,
    channels: {
      matrix: {
        homeserver: "https://example.com",
        accessToken: "token",
        dm: {
          sessionScope: "per-room",
        },
      },
    },
  };
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(scopedConfig.llm.models ?? []);
  const commandHandler = createMatrixCommandHandler({
    config: scopedConfig,
    sessionManager,
    modelPicker,
  });

  const roomSessionId = SessionManager.resolveSessionId("matrix", "dm", "!dm-room:test", "@u1:example.org", {
    roomId: "!dm-room:test",
    sessionScope: "per-room",
  });
  const threadSessionId = SessionManager.resolveSessionId("matrix", "dm", "!dm-room:test", "@u1:example.org", {
    roomId: "!dm-room:test",
    threadId: "$thread",
    sessionScope: "per-room",
  });

  const roomSession = await sessionManager.getOrCreateWithMeta(roomSessionId, "matrix", "dm");
  roomSession.messages.push({ role: "user", content: "room", timestamp: new Date().toISOString() });
  const threadSession = await sessionManager.getOrCreateWithMeta(threadSessionId, "matrix", "dm");
  threadSession.messages.push({ role: "user", content: "thread", timestamp: new Date().toISOString() });

  const response = await commandHandler("!dm-room:test", "@u1:example.org", "dm", "new", "", {
    roomId: "!dm-room:test",
    threadId: "$thread",
  });

  assert.equal(response, "New session started.");
  const roomAfter = await sessionManager.peek(roomSessionId);
  const threadAfter = await sessionManager.peek(threadSessionId);
  assert.equal(threadAfter?.messages.length, 0);
  assert.equal(roomAfter?.messages.length, 1);
});

test("matrix /archive purge removes archived sessions", async () => {
  const scopedConfig: MyClawConfig = {
    ...config,
    channels: {
      matrix: {
        homeserver: "https://example.com",
        accessToken: "token",
        dm: {
          sessionScope: "per-room",
        },
      },
    },
  };
  const sessionManager = new SessionManager();
  const modelPicker = new ModelPicker(scopedConfig.llm.models ?? []);
  const commandHandler = createMatrixCommandHandler({
    config: scopedConfig,
    sessionManager,
    modelPicker,
  });

  const sessionId = SessionManager.resolveSessionId("matrix", "dm", "!dm-room:test", "@u1:example.org", {
    roomId: "!dm-room:test",
    sessionScope: "per-room",
  });
  await sessionManager.getOrCreateWithMeta(sessionId, "matrix", "dm");
  await sessionManager.persist(sessionId);
  await sessionManager.resetSession(sessionId, "matrix", "dm");

  const response = await commandHandler("!dm-room:test", "@u1:example.org", "dm", "archive", "all", {
    roomId: "!dm-room:test",
  });

  assert.match(String(response), /Archived sessions deleted/);
});

test("matrix approval handler resolves apr reactions", async () => {
  const approvalHandler = createMatrixApprovalHandler();
  const request = {
    id: "apr-1",
    platform: "matrix" as const,
    chatId: "!room:test",
    userId: "@u1:example.org",
    chatType: "group" as const,
    messageId: "$evt1",
    sessionId: "matrix/group/!room:test",
    toolName: "bash",
    args: { command: "pwd" },
  };
  const pending = approvalHandler.requestApproval(request);

  const response = await approvalHandler.resolveAction({
    chatId: "!room:test",
    userId: "@u1:example.org",
    chatType: "group",
    data: "apr:session:apr-1",
    messageId: "$approval",
  });

  assert.match(response?.text ?? "", /approved for this session/i);
  assert.equal(await pending, "allow-session");
});

test("matrix approval menu explains reply and reaction choices", async () => {
  const approvalHandler = createMatrixApprovalHandler();
  const request = {
    id: "apr-2",
    platform: "matrix" as const,
    chatId: "!room:test",
    userId: "@u1:example.org",
    chatType: "group" as const,
    messageId: "$evt2",
    sessionId: "matrix/group/!room:test",
    toolName: "bash",
    args: { command: "pwd" },
  };
  const pending = approvalHandler.requestApproval(request);

  const response = await approvalHandler.resolveAction({
    chatId: "!room:test",
    userId: "@u1:example.org",
    chatType: "group",
    data: "apr:once:apr-2",
    messageId: "$approval",
  });

  assert.match(response?.text ?? "", /approved once/i);
  assert.equal(await pending, "allow-once");
});

test("matrix approval updates stay as notice edits", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const approvalText = "Tool `bash` approved once.";

  await editPendingActionMessage({
    sendMessage: async (_roomId, content) => {
      sent.push(content);
    },
    roomId: "!room:test",
    eventId: "$evt1",
    text: approvalText,
    notice: true,
  });

  const content = sent[0] ?? {};
  const newContent = content["m.new_content"] as Record<string, unknown>;
  assert.equal(content["msgtype"], "m.notice");
  assert.equal(newContent?.["msgtype"], "m.notice");
});
