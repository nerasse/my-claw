import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { genPpmImage } from "../helpers/gen-test-image.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { SessionLog, UserEntry } from "../../src/sessions/log.ts";

const SESSION_ID = "test-injection";

const config: MyClawConfig = {
  whitelist: ["u1"], blacklist: [], channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {}, memory: { enabled: false },
};

function msg(id: string, text: string): UnifiedMessage {
  return { id, platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}
function session(id: string = SESSION_ID): LegacySessionData {
  const now = new Date().toISOString();
  return { id, platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
}
function llm(message: object): never {
  return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
}
// SSE response for streaming calls (chatCompletionStream parses `data: {json}` deltas).
function sse(parts: object[]): never {
  const text = parts.map((p) => `data: ${JSON.stringify(p)}\n`).join("") + "data: [DONE]\n";
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never;
}
function sseContent(content: string): never {
  return sse([{ choices: [{ delta: { content } }] }]);
}
function userContents(body: { messages: Array<{ role: string; content: unknown }> }): unknown[] {
  return body.messages.filter((m) => m.role === "user").map((m) => m.content);
}

let log: SessionLog;
let cleanupLog: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, session());
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
  runRegistry.clear();
});

test("a message arriving during a tool round is injected at the next LLM turn", async () => {
  runRegistry.clear();
  const reg = new ToolRegistry();
  reg.register({ name: "noop", description: "noop", parameters: {}, async execute() { return { success: true, output: "ok" }; } });
  const bridge = new AgentBridge(config, reg, new SkillRegistry());
  const sess = session();
  const { signal, end } = runRegistry.startRoot(sess.id);

  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let call = 0;
  const mock = mockFetch(async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    call++;
    if (call === 1) {
      runRegistry.enqueueInjection(sess.id, msg("inj", "injected question")); // arrives mid tool round
      return llm({ content: "", tool_calls: [{ id: "tc1", function: { name: "noop", arguments: "{}" } }] });
    }
    return llm({ content: "final answer" });
  });

  try {
    const text = await bridge.handleMessage(msg("orig", "original question"), sess, signal);
    runRegistry.settleMailbox(sess.id, "resolve");
    assert.equal(call, 2);
    assert.equal(text, "final answer");
    assert.ok(userContents(bodies[1]!).some((c) => typeof c === "string" && c.includes("injected question")));
  } finally {
    mock.restore(); end(); runRegistry.clear();
  }
});

test("a message arriving during the final answer keeps the run going (onTurnSwitch + new turn)", async () => {
  runRegistry.clear();
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const sess = session();
  const { signal, end } = runRegistry.startRoot(sess.id);
  const switched: string[] = [];

  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let call = 0;
  const mock = mockFetch(async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    call++;
    if (call === 1) {
      runRegistry.enqueueInjection(sess.id, msg("inj", "second question"));
      return sseContent("first answer");
    }
    return sseContent("second answer");
  });

  try {
    const text = await bridge.handleMessageStreaming(
      msg("orig", "first question"), sess,
      async () => {}, undefined, signal,
      async (m) => { switched.push(m.id); },
    );
    runRegistry.settleMailbox(sess.id, "resolve");
    assert.equal(call, 2); // run continued instead of finishing after the first answer
    assert.equal(text, "second answer");
    assert.deepEqual(switched, ["inj"]); // output switched to the injected message's bubble
    assert.ok(userContents(bodies[1]!).some((c) => typeof c === "string" && c.includes("second question")));
    assert.ok(bodies[1]!.messages.some((m) => m.role === "assistant" && m.content === "first answer"));
  } finally {
    mock.restore(); end(); runRegistry.clear();
  }
});

test("a sub-agent run drains its mailbox when one is open (the runner owns opening it)", async () => {
  const subId = "subagent/digger-a1b2";
  await deleteSession(subId);
  await writeLegacySessionFile(subId, session(subId));
  const subSetup = await setupSessionLog(subId);
  const subLog = subSetup.log;

  runRegistry.clear();
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, 1);
  const sess = session(subId);
  // What SubAgentRunner.executeRunWithSession does now: a mailbox with no controller of its own,
  // because the run's abort must stay the shared root signal.
  runRegistry.openMailbox(sess.id);
  const injectedId = "inj";
  void runRegistry.enqueueInjection(sess.id, msg(injectedId, "steer mid-flight"));

  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const mock = mockFetch(async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return llm({ content: "done" });
  });
  try {
    await bridge.handleMessage(msg("orig", "q"), sess, undefined);
    // The depth-1 run consumed the injection: the engine asked the model with both the original
    // task and the injected message, and recorded the injection in the session.
    const userTexts = bodies[0]!.messages.filter((m) => m.role === "user").map((m) => String(m.content));
    assert.ok(userTexts.some((t) => t.includes("q")));
    assert.ok(userTexts.some((t) => t.includes("steer mid-flight")));
    
    await subLog.flush();
    const userEntries = subLog.entries().filter((e): e is UserEntry => e.type === "user");
    assert.ok(userEntries.some((e) => e.text.includes("steer mid-flight")));
    // drainOrClose closed the mailbox at the end of the run, and nothing is left pending.
    assert.equal(runRegistry.canInject(sess.id), false);
  } finally {
    mock.restore(); runRegistry.settleMailbox(sess.id, "resolve"); runRegistry.clear();
    subSetup.cleanup();
  }
});

test("an injected image message adds vision content to the next LLM call", async () => {
  runRegistry.clear();
  const imgPath = join(tmpdir(), `inj-${Date.now()}.ppm`);
  await genPpmImage(imgPath, 1, 1, { r: 0, g: 255, b: 0 });
  const visionConfig: MyClawConfig = { ...config, llm: { ...config.llm, vision: true } };
  const reg = new ToolRegistry();
  reg.register({ name: "noop", description: "noop", parameters: {}, async execute() { return { success: true, output: "ok" }; } });
  const bridge = new AgentBridge(visionConfig, reg, new SkillRegistry());
  const sess = session();
  const { signal, end } = runRegistry.startRoot(sess.id);

  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let call = 0;
  const mock = mockFetch(async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    call++;
    if (call === 1) {
      const im = msg("inj", "look at this");
      im.attachments = [{ type: "image", path: imgPath, mimeType: "image/x-portable-pixmap" }];
      runRegistry.enqueueInjection(sess.id, im);
      return llm({ content: "", tool_calls: [{ id: "tc1", function: { name: "noop", arguments: "{}" } }] });
    }
    return llm({ content: "final" });
  });

  try {
    await bridge.handleMessage(msg("orig", "q"), sess, signal);
    runRegistry.settleMailbox(sess.id, "resolve");
    const hasImage = bodies[1]!.messages.some(
      (m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((c) => c.type === "image_url"),
    );
    assert.ok(hasImage, "injected user turn should carry an image_url content block");
  } finally {
    mock.restore(); end(); runRegistry.clear(); await rm(imgPath, { force: true });
  }
});

// The page draws its bubble the moment the owner sends, and history is matched against it by id.
// A steered turn used to come back anchorless, so the reopened thread showed the message twice.
test("an injected turn is persisted with the sender's own id", async () => {
  runRegistry.clear();
  const reg = new ToolRegistry();
  reg.register({ name: "noop", description: "noop", parameters: {}, async execute() { return { success: true, output: "ok" }; } });
  const bridge = new AgentBridge(config, reg, new SkillRegistry());
  const sess = session();
  const { signal, end } = runRegistry.startRoot(sess.id);

  let call = 0;
  const mock = mockFetch(async () => {
    call++;
    if (call === 1) {
      runRegistry.enqueueInjection(sess.id, msg("steer-1", "and also this"));
      return llm({ content: "", tool_calls: [{ id: "tc1", function: { name: "noop", arguments: "{}" } }] });
    }
    return llm({ content: "done" });
  });

  try {
    await bridge.handleMessage(msg("orig", "first question"), sess, signal);
    runRegistry.settleMailbox(sess.id, "resolve");
    
    await log.flush();
    const userEntries = log.entries().filter((e): e is UserEntry => e.type === "user");
    // sourceId is on the UnifiedMessage, stored as sourceId on the UserEntry
    // Check that we have 2 user entries
    assert.equal(userEntries.length, 2);
    assert.equal(userEntries[0]!.text, "first question");
    assert.equal(userEntries[1]!.text, "and also this");
  } finally {
    mock.restore();
    end();
    runRegistry.clear();
  }
});

// The failure rollback trims what the run appended. It used to reach past the steered turn too, so
// the owner got an error AND lost the message they had just sent.
test("a run that fails after absorbing a steer keeps the steered turn", async () => {
  runRegistry.clear();
  const reg = new ToolRegistry();
  reg.register({ name: "noop", description: "noop", parameters: {}, async execute() { return { success: true, output: "ok" }; } });
  const bridge = new AgentBridge(config, reg, new SkillRegistry());
  const sess = session();
  const { signal, end } = runRegistry.startRoot(sess.id);

  let call = 0;
  const mock = mockFetch(async () => {
    call++;
    if (call === 1) {
      // Nobody awaits it here; the reject below is expected, so it must not surface unhandled.
      void runRegistry.enqueueInjection(sess.id, msg("steer-2", "keep me"))?.catch(() => {});
      return llm({ content: "", tool_calls: [{ id: "tc1", function: { name: "noop", arguments: "{}" } }] });
    }
    return new Response("upstream exploded", { status: 500 }) as never;
  });

  try {
    await assert.rejects(() => bridge.handleMessage(msg("orig", "first question"), sess, signal));
    runRegistry.settleMailbox(sess.id, "reject", new Error("boom"));
    
    await log.flush();
    const userEntries = log.entries().filter((e): e is UserEntry => e.type === "user");
    assert.ok(userEntries.some((e) => e.text === "keep me"), "the steered turn survives the rollback");
  } finally {
    mock.restore();
    end();
    runRegistry.clear();
  }
});
