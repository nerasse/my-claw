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

/**
 * One stop per cycle (docs/stop.md): while the first stop's abort is still in flight, a second
 * `/stop` must answer nothing at all -- a second "Stopped." is a second bubble for the one stop.
 * The adapter turns the `undefined` into the same silence on the wire: no frame, no journal line.
 */
test("/stop answers nothing while the abort of the same cycle is in flight", async () => {
  runRegistry.clear();
  const run = handler();
  const sessionId = SessionManager.resolveSessionId("my-claw-app", "dm", "u1", "u1", { threadId: "t1" });
  const { end } = runRegistry.startRoot(sessionId);

  assert.equal(await run("u1", "t1", "stop", ""), "Stopped.");
  assert.equal(await run("u1", "t1", "stop", ""), undefined);
  assert.equal(await run("u1", "t1", "stop", ""), undefined);

  // The cycle over, the next /stop finds an idle session -- and says so, once.
  end();
  assert.equal(await run("u1", "t1", "stop", ""), "Nothing running.");
  runRegistry.clear();
});

test("/stop claims through the channel's door when one is wired", async () => {
  // The typed command and the Stop button have to pass the same way: the door is what emits the
  // stop frame and holds it for a reloading window, so a `/stop` that resolved the claim by
  // itself would be the invisible half of the bug again (docs/stop.md).
  runRegistry.clear();
  const claimed: Array<{ sessionId: string; owner: string; threadId: string }> = [];
  const sessionId = SessionManager.resolveSessionId("my-claw-app", "dm", "u1", "u1", { threadId: "t1" });
  const run = createMyClawAppCommandHandler({
    config,
    sessionManager: new SessionManager(),
    modelPicker: {} as ModelPicker,
    stop: (session, owner, threadId) => {
      claimed.push({ sessionId: session, owner, threadId });
      return "stopping";
    },
  });

  // The door's answer is the command's answer, whatever it is: a "stopping" cycle is silent, and
  // the registry -- which has nothing running -- is never consulted behind the door's back.
  assert.equal(await run("u1", "t1", "stop", ""), undefined);
  assert.deepEqual(claimed, [{ sessionId, owner: "u1", threadId: "t1" }]);
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
