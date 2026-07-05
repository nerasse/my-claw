import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "./helpers/mock-fetch.ts";
import { AgentBridge } from "../src/agent/bridge.ts";
import { SubAgentRunner } from "../src/subagents/runner.ts";
import { SubAgentRegistry } from "../src/subagents/registry.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { VoiceManager, SttPipeline, TtsPipeline } from "../src/voice/index.ts";
import type { MyClawConfig } from "../src/core/config.ts";
import type { UnifiedMessage } from "../src/channels/types.ts";
import { deleteSession, loadSession } from "../src/sessions/store.ts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

async function setupDir(): Promise<string> {
  const dir = join("/tmp", `subagent-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeSkill(dir: string, name: string, content: string): Promise<void> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content);
}

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {
    research: {
      llm: { defaultModel: "research-model" },
    },
  },
};

const voiceManager = new VoiceManager(config);
const sttPipeline = new SttPipeline(voiceManager);
const ttsPipeline = new TtsPipeline(voiceManager);

function createMessage(): UnifiedMessage {
  return {
    id: "m1",
    platform: "telegram",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

test("SubAgentRunner spawns research agent one-shot", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline, ttsPipeline);
  const reg = new SubAgentRegistry();

  let callCount = 0;
  const fetchMock = mockFetch(async () => {
    if (callCount++ === 0) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "read", arguments: "{}" } }] } }],
        }),
        { status: 200 },
      ) as never;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "research done" } }] }),
      { status: 200 },
    ) as never;
  });

  try {
    const existing = await reg.listExistingIds();
    const { id, result } = await runner.spawn("test", "research", "run", "explore", undefined, createMessage(), existing, (n, e) => reg.generateId(n, e));
    assert.ok(id.startsWith("subagent/run-"));
    assert.equal(result, "research done");
  } finally {
    fetchMock.restore();
  }
});

test("SubAgentRunner spawns persistent session and sends message", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline, ttsPipeline);
  const reg = new SubAgentRegistry();

  let callCount = 0;
  const fetchMock = mockFetch(async () => {
    if (callCount++ === 0) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "", tool_calls: [{ id: "tc1", function: { name: "read", arguments: "{}" } }] } }],
        }),
        { status: 200 },
      ) as never;
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ack" } }] }),
      { status: 200 },
    ) as never;
  });

  try {
    const existing = await reg.listExistingIds();
    const { id, result } = await runner.spawn("persist", "research", "session", "init", undefined, createMessage(), existing, (n, e) => reg.generateId(n, e));
    assert.ok(id.startsWith("subagent/persist-"));
    assert.equal(result, "ack");

    const session = await loadSession(id);
    assert.ok(session);
    assert.equal(session?.meta?.displayName, "persist");

    const sendResult = await runner.send(id, "second message", undefined, createMessage(), reg);
    assert.equal(sendResult, "ack");

    const session2 = await loadSession(id);
    assert.equal(session2?.messages.length, 4);

    await deleteSession(id);
  } finally {
    fetchMock.restore();
  }
});

test("SubAgentRegistry generates unique IDs", async () => {
  const reg = new SubAgentRegistry();
  const existing = new Set<string>();
  const ids = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const id = reg.generateId("test", existing);
    ids.add(id);
    existing.add(id);
  }
  assert.equal(ids.size, 20);
});

test("SubAgentRunner queues concurrent sends in FIFO order", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline, ttsPipeline);
  const reg = new SubAgentRegistry();

  const executionOrder: string[] = [];
  let callCount = 0;
  const fetchMock = mockFetch(async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
    const userMsgs = body.messages?.filter((m) => m.role === "user") ?? [];
    const userMsg = userMsgs[userMsgs.length - 1];
    const content = userMsg?.content ?? "";
    
    executionOrder.push(content);
    callCount++;
    await new Promise((r) => setTimeout(r, 1));
    
    return new Response(
      JSON.stringify({ choices: [{ message: { content: `reply-${callCount}` } }] }),
      { status: 200 },
    ) as never;
  });

  try {
    const existing = await reg.listExistingIds();
    const { id } = await runner.spawn("queue", "research", "session", "init", undefined, createMessage(), existing, (n, e) => reg.generateId(n, e));

    // Fire two sends almost simultaneously
    const p1 = runner.send(id, "msg1", undefined, createMessage(), reg);
    const p2 = runner.send(id, "msg2", undefined, createMessage(), reg);

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both should succeed (no reject)
    // init = run 1, msg1 = run 2, msg2 = run 3
    assert.equal(r1, "reply-2");
    assert.equal(r2, "reply-3");

    // Messages should execute in FIFO order
    assert.deepEqual(executionOrder, ["init", "msg1", "msg2"]);

    // Both user messages should be in the session
    const session = await loadSession(id);
    const userContents = session?.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content) ?? [];
    assert.ok(userContents.includes("msg1"));
    assert.ok(userContents.includes("msg2"));

    await deleteSession(id);
  } finally {
    fetchMock.restore();
  }
});

test("SubAgentRunner queues three sends in order", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline, ttsPipeline);
  const reg = new SubAgentRegistry();

  const executionOrder: number[] = [];
  let callCount = 0;
  const fetchMock = mockFetch(async () => {
    executionOrder.push(++callCount);
    await new Promise((r) => setTimeout(r, 1));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200 },
    ) as never;
  });

  try {
    const existing = await reg.listExistingIds();
    const { id } = await runner.spawn("triple", "research", "session", "init", undefined, createMessage(), existing, (n, e) => reg.generateId(n, e));

    const results = await Promise.all([
      runner.send(id, "a", undefined, createMessage(), reg),
      runner.send(id, "b", undefined, createMessage(), reg),
      runner.send(id, "c", undefined, createMessage(), reg),
    ]);

    // All succeed
    assert.equal(results[0], "ok");
    assert.equal(results[1], "ok");
    assert.equal(results[2], "ok");

    // Executed in order 1, 2, 3, 4 (init + 3 sends, not interleaved)
    assert.deepEqual(executionOrder, [1, 2, 3, 4]);

    await deleteSession(id);
  } finally {
    fetchMock.restore();
  }
});

test("SubAgentRunner kill and reset", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline, ttsPipeline);
  const reg = new SubAgentRegistry();

  let callCount = 0;
  const fetchMock = mockFetch(async () => {
    callCount++;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200 },
    ) as never;
  });

  try {
    const existing = await reg.listExistingIds();
    const { id } = await runner.spawn("killtest", "research", "session", "init", undefined, createMessage(), existing, (n, e) => reg.generateId(n, e));

    const killResult = await runner.kill(id);
    assert.ok(killResult.includes("deleted"));
    assert.equal(await loadSession(id), null);

    const { id: id2 } = await runner.spawn("resettest", "research", "session", "init", undefined, createMessage(), existing, (n, e) => reg.generateId(n, e));
    const resetResult = await runner.reset(id2);
    assert.ok(resetResult.includes("reset"));
    const session = await loadSession(id2);
    assert.ok(session);
    assert.equal(session?.messages.length, 0);

    await deleteSession(id2);
  } finally {
    fetchMock.restore();
  }
});

test("spawn tool with attachments", async () => {
  const { createSendTool } = await import("../src/tools/send.ts");
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline, ttsPipeline);
  const reg = new SubAgentRegistry();

  let callCount = 0;
  const fetchMock = mockFetch(async (_input, init) => {
    callCount++;
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
    const userMsgs = body.messages?.filter((m) => m.role === "user") ?? [];
    const userMsg = userMsgs[userMsgs.length - 1];
    return new Response(
      JSON.stringify({ choices: [{ message: { content: userMsg?.content ?? "ok" } }] }),
      { status: 200 },
    ) as never;
  });

  try {
    const existing = await reg.listExistingIds();
    const { id } = await runner.spawn("attach", "research", "session", "init", undefined, createMessage(), existing, (n, e) => reg.generateId(n, e));

    const send = createSendTool(runner, reg);
    const result = await send.execute({
      id,
      message: "analyze this",
      attachments: [{ path: "/tmp/test.png", type: "image" }],
      __message: createMessage(),
    });

    assert.ok(result.success);
    assert.ok((result.output ?? "").includes("Attachments"), `Expected output to include "Attachments", got: ${result.output}`);

    await deleteSession(id);
  } finally {
    fetchMock.restore();
  }
});

test("sub-agent with workspaceDir receives same skills as main agent", async () => {
  const { loadAllSkills } = await import("../src/skills/loader.ts");
  const { SkillRegistry } = await import("../src/skills/registry.ts");
  const dir = await setupDir();
  await writeSkill(dir, "shared", "---\nname: shared\ndescription: Shared skill\n---\n\nShared.");

  const skills = await loadAllSkills({ builtInDir: dir, customDir: dir, workspaceDir: dir });
  const skillRegistry = new SkillRegistry(skills);

  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, skillRegistry, voiceManager, sttPipeline, ttsPipeline);

  let capturedSystemPrompt = "";
  const fetchMock = mockFetch(async (_input, init) => {
    const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
    const sysMsg = body.messages?.find((m) => m.role === "system");
    if (sysMsg) capturedSystemPrompt = sysMsg.content;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200 },
    ) as never;
  });

  try {
    const existing = await new SubAgentRegistry().listExistingIds();
    await runner.spawn("skill-test", "research", "run", "test", "/tmp/project", createMessage(), existing, (n, e) => new SubAgentRegistry().generateId(n, e));
    assert.ok(capturedSystemPrompt.includes("Available skills"), "System prompt should contain skills");
    assert.ok(capturedSystemPrompt.includes("shared"), "System prompt should contain shared skill");
  } finally {
    fetchMock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SubAgentRegistry isRunning reflects queue state", async () => {
  const reg = new SubAgentRegistry();
  
  assert.equal(reg.isRunning("subagent/test"), false);
  
  const p = reg.enqueue("subagent/test", async () => {
    assert.equal(reg.isRunning("subagent/test"), true);
    await new Promise((r) => setTimeout(r, 10));
    return "done";
  });
  
  assert.equal(reg.isRunning("subagent/test"), true);
  await p;
  assert.equal(reg.isRunning("subagent/test"), false);
});
