import { test } from "bun:test";
import assert from "node:assert/strict";
import { createTelegramCommandHandler } from "../../src/channels/telegram/session-handlers.ts";
import { createMatrixCommandHandler } from "../../src/channels/matrix/session-handlers.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { ModelPicker } from "../../src/channels/model-picker.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { isMetaCommand } from "../../src/channels/meta-commands.ts";
import type { MyClawConfig } from "../../src/core/config.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
};

test("/stop is recognized as a meta-command (not routed to the agent)", () => {
  assert.equal(isMetaCommand("/stop"), true);
  assert.equal(isMetaCommand("/stop@mybot"), true);
});

test("telegram /stop stops the current session and distinguishes idle", async () => {
  runRegistry.clear();
  const handler = createTelegramCommandHandler({ config, sessionManager: new SessionManager(), modelPicker: new ModelPicker([]) });
  const sessionId = SessionManager.resolveSessionId("telegram", "dm", "c1", "u1");
  const { end } = runRegistry.startRoot(sessionId);

  assert.equal(await handler("c1", "u1", "dm", "stop", ""), "Stopped.");

  // a session with no active run
  assert.equal(await handler("c1", "u2", "dm", "stop", ""), "Nothing running.");

  end();
  runRegistry.clear();
});

test("matrix /stop stops the current session", async () => {
  runRegistry.clear();
  const handler = createMatrixCommandHandler({ config, sessionManager: new SessionManager(), modelPicker: new ModelPicker([]) });
  const sessionId = SessionManager.resolveSessionId("matrix", "dm", "!room:test", "@u1:test", { roomId: "!room:test" });
  const { end } = runRegistry.startRoot(sessionId);

  assert.equal(await handler("!room:test", "@u1:test", "dm", "stop", "", { roomId: "!room:test" }), "Stopped.");
  end();
  runRegistry.clear();
});

test("/status shows the live run tree (main + sub-agents)", async () => {
  runRegistry.clear();
  const handler = createTelegramCommandHandler({ config, sessionManager: new SessionManager(), modelPicker: new ModelPicker([]) });
  const sessionId = SessionManager.resolveSessionId("telegram", "dm", "c1", "u1");
  const { signal, end } = runRegistry.startRoot(sessionId);
  runRegistry.enter(signal, "main", 0);
  runRegistry.enter(signal, "researcher", 1);

  const status = String(await handler("c1", "u1", "dm", "status", ""));
  assert.match(status, /Active run: main, researcher\[1\]/);

  end();
  runRegistry.clear();
});
