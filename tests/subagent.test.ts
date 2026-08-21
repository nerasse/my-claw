import { hooks } from "../src/hooks/index.ts";
import { getSessionModelUsage } from "../src/analytics/usage-db.ts";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mockFetch } from "./helpers/mock-fetch.ts";
import { AgentBridge } from "../src/agent/bridge.ts";
import { SubAgentRunner } from "../src/subagents/runner.ts";
import { SubAgentRegistry } from "../src/subagents/registry.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../src/voice/index.ts";
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

function createMessage(): UnifiedMessage {
  return {
    id: "m1",
    platform: "my-claw-app",
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
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
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
    const { id, result } = await runner.spawn({ displayName: "test", type: "research", mode: "run", task: "explore", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global" });
    assert.ok(id.startsWith("subagent/run-"));
    assert.equal(result, "research done");
  } finally {
    fetchMock.restore();
  }
});

test("SubAgentRunner spawns persistent session and sends message", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
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
    const { id, result } = await runner.spawn({ displayName: "persist", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global" });
    assert.ok(id.startsWith("subagent/persist-"));
    assert.equal(result, "ack");

    const session = await loadSession(id);
    assert.ok(session);
    assert.equal(session?.meta?.displayName, "persist");
    // The first run's reply must be persisted (a session sub-agent remembers its own answer).
    const firstRunReply = session?.messages.filter((m) => m.role === "assistant").at(-1);
    assert.equal(firstRunReply?.content, "ack");
    const lengthAfterSpawn = session!.messages.length;

    const sendResult = await runner.send(id, "second message", undefined, createMessage(), reg, "matrix/room/!caller:test");
    assert.equal(sendResult, "ack");

    const session2 = await loadSession(id);
    // History grew (the send turn was appended on top of the persisted first run).
    assert.ok((session2?.messages.length ?? 0) > lengthAfterSpawn);
    assert.equal(session2?.messages.at(-1)?.content, "ack");

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
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
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
    const { id } = await runner.spawn({ displayName: "queue", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global" });

    // Fire two sends almost simultaneously
    const p1 = runner.send(id, "msg1", undefined, createMessage(), reg, "matrix/room/!caller:test");
    const p2 = runner.send(id, "msg2", undefined, createMessage(), reg, "matrix/room/!caller:test");

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
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
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
    const { id } = await runner.spawn({ displayName: "triple", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global" });

    const results = await Promise.all([
      runner.send(id, "a", undefined, createMessage(), reg, "matrix/room/!caller:test"),
      runner.send(id, "b", undefined, createMessage(), reg, "matrix/room/!caller:test"),
      runner.send(id, "c", undefined, createMessage(), reg, "matrix/room/!caller:test"),
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
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
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
    const { id } = await runner.spawn({ displayName: "killtest", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global" });

    const killResult = await runner.kill(id, "matrix/room/!caller:test");
    assert.ok(killResult.includes("deleted"));
    assert.equal(await loadSession(id), null);

    const { id: id2 } = await runner.spawn({ displayName: "resettest", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global" });
    const resetResult = await runner.reset(id2, "matrix/room/!caller:test");
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
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
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
    const { id } = await runner.spawn({ displayName: "attach", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global" });

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
  const runner = new SubAgentRunner(config, registry, skillRegistry, voiceManager, sttPipeline);

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
    await runner.spawn({ displayName: "skill-test", type: "research", mode: "run", task: "test", workspaceDir: "/tmp/project", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => new SubAgentRegistry().generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global" });
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

test("a global sub-agent is reachable from another conversation, a private one is not", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const fetchMock = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }) as never);
  const CREATOR = "matrix/room/!creator:test";
  const OTHER = "telegram/dm/424242";

  try {
    const shared = await runner.spawn({ displayName: "shared", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: await reg.listExistingIds(), generateId: (n, e) => reg.generateId(n, e), parentSessionId: CREATOR, visibility: "global" });
    const secret = await runner.spawn({ displayName: "secret", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: await reg.listExistingIds(), generateId: (n, e) => reg.generateId(n, e), parentSessionId: CREATOR, visibility: "private" });

    // Sharing is the default and the point: another chat can list and drive a global agent.
    const fromOther = await runner.list(reg, OTHER);
    assert.ok(fromOther.some((a) => a.id === shared.id));
    assert.ok(!fromOther.some((a) => a.id === secret.id));

    const fromCreator = await runner.list(reg, CREATOR);
    assert.ok(fromCreator.some((a) => a.id === secret.id));

    assert.equal(await runner.send(shared.id, "hi", undefined, createMessage(), reg, OTHER), "ok");
    // A private agent must not even confirm it exists to a chat that does not own it.
    assert.ok((await runner.send(secret.id, "hi", undefined, createMessage(), reg, OTHER)).startsWith("Error:"));
    assert.ok((await runner.kill(secret.id, OTHER)).startsWith("Error:"));
    assert.ok((await runner.reset(secret.id, OTHER)).startsWith("Error:"));

    // The owner still controls it.
    assert.ok(!(await runner.kill(secret.id, CREATOR)).startsWith("Error:"));
  } finally {
    fetchMock.restore();
  }
});

test("a one-shot sub-agent is never listed, and its calls are billed to the caller", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const CALLER = "matrix/room/!oneshot-caller:test";
  // Observed from inside the run: the session is deleted when it ends, so afterwards there would
  // be nothing to look at either way.
  let visibleMidRun: string[] = [];
  const fetchMock = mockFetch(async () => {
    visibleMidRun = (await runner.list(reg, "telegram/dm/777")).map((a) => a.id);
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 }) as never;
  });
  try {
    const { id } = await runner.spawn({ displayName: "ephemeral", type: "research", mode: "run", task: "look", parentMessage: createMessage(), existingIds: await reg.listExistingIds(), generateId: (n, e) => reg.generateId(n, e), parentSessionId: CALLER, visibility: "global" });
    assert.ok(id.startsWith("subagent/run-"));
    assert.ok(!visibleMidRun.includes(id));

    // The reason one-shots get metadata at all: without it their tokens land nowhere.
    const rows = getSessionModelUsage(CALLER, "delegated");
    assert.ok(rows.length > 0, "the one-shot's calls should be billed to the session that asked");
    assert.ok(rows.some((r) => r.calls > 0));
  } finally {
    fetchMock.restore();
  }
});

test("kill refuses an id that is not a sub-agent", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  // deleteSession takes any id, so without validation this would delete a conversation.
  const result = await runner.kill("matrix/room/!victim:test", "matrix/room/!victim:test");
  assert.ok(result.startsWith("Error:"));
});

test("driving a shared sub-agent moves the bill to the chat that drove it", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const CREATOR = "matrix/room/!bill-creator:test";
  const DRIVER = "telegram/dm/555111";
  const fetchMock = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }) as never);
  try {
    const { id } = await runner.spawn({ displayName: "shared-bill", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: await reg.listExistingIds(), generateId: (n, e) => reg.generateId(n, e), parentSessionId: CREATOR, visibility: "global" });
    const afterSpawn = getSessionModelUsage(CREATOR, "delegated").reduce((s, r) => s + r.calls, 0);
    assert.ok(afterSpawn > 0, "the spawn run belongs to the creator");

    await runner.send(id, "do more", undefined, createMessage(), reg, DRIVER);

    // Parentage is creation-time, but a bill is not: whoever asked for this run pays for it.
    const driverCalls = getSessionModelUsage(DRIVER, "delegated").reduce((s, r) => s + r.calls, 0);
    assert.ok(driverCalls > 0, "the send run should be billed to the driver, not the creator");
    // And the creator is not charged twice for work it did not request.
    assert.equal(getSessionModelUsage(CREATOR, "delegated").reduce((s, r) => s + r.calls, 0), afterSpawn);
  } finally {
    fetchMock.restore();
  }
});

test("a sub-agent runs in its agent's configured workspace, skills included", async () => {
  const sofa = await setupDir();
  const pinned: MyClawConfig = {
    ...config,
    workspaces: { sofa },
    agents: { research: { workspace: "sofa" } },
  };
  const runner = new SubAgentRunner(pinned, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const fetchMock = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }) as never);

  try {
    const { id } = await runner.spawn({
      displayName: "pinned", type: "research", mode: "session", task: "init",
      parentMessage: createMessage(), existingIds: await reg.listExistingIds(),
      generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global",
    });
    const session = await loadSession(id);
    // The directory alone is not enough: without the key the sub-agent would run in SOFA while
    // being handed the default workspace's skills.
    assert.equal(session?.meta?.workspaceDir, sofa);
    assert.equal(session?.workspace, "sofa");
    await deleteSession(id);
  } finally {
    fetchMock.restore();
    await rm(sofa, { recursive: true, force: true });
  }
});

test("a sub-agent inherits the parent run's workspace when its agent pins none", async () => {
  const sofa = await setupDir();
  const inherited: MyClawConfig = { ...config, workspaces: { sofa }, agents: {} };
  const runner = new SubAgentRunner(inherited, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const fetchMock = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }) as never);

  try {
    const { id } = await runner.spawn({
      displayName: "inherit", type: "research", mode: "session", task: "init",
      parentWorkspaceDir: sofa,
      parentMessage: createMessage(), existingIds: await reg.listExistingIds(),
      generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global",
    });
    const session = await loadSession(id);
    assert.equal(session?.workspace, "sofa");
    await deleteSession(id);
  } finally {
    fetchMock.restore();
    await rm(sofa, { recursive: true, force: true });
  }
});

test("an explicit workspaceDir may narrow inside the agent's workspace, never escape it", async () => {
  const sofa = await setupDir();
  const elsewhere = await setupDir();
  const pinned: MyClawConfig = {
    ...config,
    workspaces: { sofa },
    agents: { research: { workspace: "sofa" } },
  };
  const runner = new SubAgentRunner(pinned, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();

  const escaping = await runner.spawn({
    displayName: "escape", type: "research", mode: "session", task: "init",
    workspaceDir: elsewhere,
    parentMessage: createMessage(), existingIds: await reg.listExistingIds(),
    generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global",
  });
  assert.match(escaping.result, /must be within the agent's workspace/);

  await rm(sofa, { recursive: true, force: true });
  await rm(elsewhere, { recursive: true, force: true });
});

test("one-shot spawn emits subagent:spawn and subagent:complete with the parent session", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();

  const events: Array<{ type: string; id: string; parentSessionId: string }> = [];
  const onSpawn = (ev: { id: string; parentSessionId: string }): void => { events.push({ type: "spawn", id: ev.id, parentSessionId: ev.parentSessionId }); };
  const onComplete = (ev: { id: string; parentSessionId: string }): void => { events.push({ type: "complete", id: ev.id, parentSessionId: ev.parentSessionId }); };
  hooks.on("subagent:spawn", onSpawn);
  hooks.on("subagent:complete", onComplete);

  const fetchMock = mockFetch(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: "done" } }] }),
    { status: 200 },
  ) as never);

  try {
    await runner.spawn({
      displayName: "hooktest", type: "research", mode: "run", task: "probe",
      parentMessage: createMessage(), existingIds: await reg.listExistingIds(),
      generateId: (n, e) => reg.generateId(n, e), parentSessionId: "my-claw-app/thread/u1/t1", visibility: "global",
    });

    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, "spawn");
    assert.equal(events[1]!.type, "complete");
    assert.ok(events[0]!.id.startsWith("subagent/run-"));
    assert.equal(events[0]!.id, events[1]!.id);
    assert.equal(events[0]!.parentSessionId, "my-claw-app/thread/u1/t1");
  } finally {
    hooks.off("subagent:spawn", onSpawn);
    hooks.off("subagent:complete", onComplete);
    fetchMock.restore();
  }
});

