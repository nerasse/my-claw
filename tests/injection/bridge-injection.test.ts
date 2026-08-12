import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { genPpmImage } from "../helpers/gen-test-image.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

const config: MyClawConfig = {
  whitelist: ["u1"], blacklist: [], channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model" },
  agents: {}, memory: { enabled: false },
};

function msg(id: string, text: string): UnifiedMessage {
  return { id, platform: "telegram", userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}
function session(id: string): SessionData {
  const now = new Date().toISOString();
  return { id, platform: "telegram", chatType: "dm", createdAt: now, lastActiveAt: now, messages: [] };
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

test("a message arriving during a tool round is injected at the next LLM turn", async () => {
  runRegistry.clear();
  const reg = new ToolRegistry();
  reg.register({ name: "noop", description: "noop", parameters: {}, async execute() { return { success: true, output: "ok" }; } });
  const bridge = new AgentBridge(config, reg, new SkillRegistry());
  const sess = session("telegram/dm/u1");
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
  const sess = session("telegram/dm/u1");
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
  runRegistry.clear();
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry(), undefined, undefined, 1);
  const sess = session("subagent/digger-a1b2");
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
    assert.ok(sess.messages.some((m) => m.role === "user" && m.content.includes("steer mid-flight")));
    // drainOrClose closed the mailbox at the end of the run, and nothing is left pending.
    assert.equal(runRegistry.canInject(sess.id), false);
  } finally {
    mock.restore(); runRegistry.settleMailbox(sess.id, "resolve"); runRegistry.clear();
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
  const sess = session("telegram/dm/u1");
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
