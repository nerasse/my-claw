import { test } from "bun:test";
import assert from "node:assert/strict";
import { createMyClawAppCommandHandler } from "../../src/channels/my-claw-app/commands.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import type { ModelPicker } from "../../src/channels/model-picker.ts";
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

function handler() {
  return createMyClawAppCommandHandler({
    config,
    sessionManager: new SessionManager(),
    modelPicker: {} as ModelPicker,
  });
}

test("/stop is recognized as a meta-command (not routed to the agent)", () => {
  assert.equal(isMetaCommand("/stop"), true);
  assert.equal(isMetaCommand("/stop@mybot"), true);
});

test("/stop stops the current session and distinguishes idle", async () => {
  runRegistry.clear();
  const run = handler();
  const sessionId = SessionManager.resolveSessionId("my-claw-app", "dm", "u1", "u1", { threadId: "t1" });
  const { end } = runRegistry.startRoot(sessionId);

  assert.equal(await run("u1", "t1", "stop", ""), "Stopped.");

  // a thread with no active run
  assert.equal(await run("u1", "t2", "stop", ""), "Nothing running.");

  end();
  runRegistry.clear();
});

test("/status shows the live run tree (main + sub-agents)", async () => {
  runRegistry.clear();
  const run = handler();
  const sessionId = SessionManager.resolveSessionId("my-claw-app", "dm", "u1", "u1", { threadId: "t1" });
  const { signal, end } = runRegistry.startRoot(sessionId);
  runRegistry.enter(signal, "main", 0);
  runRegistry.enter(signal, "researcher", 1);

  const output = await run("u1", "t1", "status", "");
  assert.ok(output && typeof output !== "string", "the status answers with the structured report");
  const runs = output.status?.runtime.runs.map((r) => `${r.label}[${r.depth}]`);
  assert.deepEqual(runs, ["main[0]", "researcher[1]"]);
  assert.match(output.text, /running: main, researcher/);

  end();
  runRegistry.clear();
});
