import test from "node:test";
import assert from "node:assert/strict";
import {
  createMatrixActionHandler,
  createMatrixCommandHandler,
} from "../src/channels/matrix-session-handlers.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { ModelPicker } from "../src/channels/model-picker.ts";
import type { MyClawConfig } from "../src/config.ts";

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
