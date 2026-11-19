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
import { analyticsDb } from "../src/analytics/usage-db.ts";
import { writeMeta, STORAGE_VERSION } from "../src/sessions/meta.ts";
import { openSessionLog, type PhaseEntry, type UserEntry } from "../src/sessions/log.ts";
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
    const log = await openSessionLog(id);
    const phases = (await log.all()).filter((e): e is PhaseEntry => e.type === "phase");
    const firstRunReply = phases.at(-1);
    assert.equal(firstRunReply?.text, "ack");
    const lengthAfterSpawn = (await log.all()).length;

    const sendResult = await runner.send(id, "second message", undefined, createMessage(), reg, "matrix/room/!caller:test");
    assert.equal(sendResult, "ack");

    const log2 = await openSessionLog(id);
    // History grew (the send turn was appended on top of the persisted first run).
    assert.ok((await log2.all()).length > lengthAfterSpawn);
    const lastPhase = (await log2.all()).filter((e): e is PhaseEntry => e.type === "phase").at(-1);
    assert.equal(lastPhase?.text, "ack");

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

    // Messages should execute in FIFO order. The inbound turn carries the per-turn context block
    // (`turn-context.ts`); the owner's words are its tail.
    const ownerText = (text: string): string => text.replace(/^<context>[\s\S]*?<\/context>\n\n/, "");
    assert.deepEqual(executionOrder.map(ownerText), ["init", "msg1", "msg2"]);

    // Both user messages should be in the log
    const log = await openSessionLog(id);
    const userContents = (await log.all())
      .filter((e): e is UserEntry => e.type === "user")
      .map((e) => e.text);
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
    assert.ok(session, "the sub-agent keeps its identity across a reset");
    // The conversation itself: the reset archives the whole directory, so the log restarts empty.
    assert.equal((await (await openSessionLog(id2)).all()).length, 0);

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
    // The prompt's per-turn block is scaffolding, not words: a model that echoes it back is the
    // failure the bridge now refuses (`protocol-leak.ts`), so this mock answers the body alone.
    const answer = String(userMsg?.content ?? "ok").replace(/^<context>[\s\S]*?<\/context>\s*/, "");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: answer } }] }),
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

/**
 * A one-shot bypassed `registry.enqueue`, and `isRunning` reads exactly that map. So the roster
 * showed a one-shot as "idle" for its entire life -- observed on a run that was 187 iterations deep
 * at the time -- and `send()`, which serialises on the same queue, could race it on the session
 * file. The session path had always enqueued; only the one-shot path did not.
 */
test("a one-shot sub-agent registers as running while it runs", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  let runningDuringExecution: boolean | undefined;
  let spawnedId = "";
  hooks.on("subagent:spawn", (e: { id: string }) => {
    spawnedId = e.id;
  });
  const fetchMock = mockFetch(async () => {
    if (spawnedId) runningDuringExecution = reg.isRunning(spawnedId);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }) as never;
  });
  try {
    const { id } = await runner.spawn({
      displayName: "oneshot", type: "research", mode: "run", task: "t",
      parentMessage: createMessage(), existingIds: await reg.listExistingIds(),
      generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test",
      visibility: "private",
      enqueue: <T,>(i: string, task: () => Promise<T>) => reg.enqueue(i, task),
    });
    assert.equal(runningDuringExecution, true, "seen as running from inside its own run");
    assert.equal(reg.isRunning(id), false, "and released once finished");
  } finally {
    fetchMock.restore();
  }
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


test("a send driven by a tool call runs the same lifecycle as a spawn", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const PARENT = "my-claw-app/thread/owner/main";

  const fetchMock = mockFetch(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: "ack" } }] }),
    { status: 200 },
  ) as never);

  const events: string[] = [];
  const onSpawn = (ev: { id: string; action: string; toolCallId?: string; mode: string; parentSessionId: string }): void => {
    events.push(`spawn:${ev.action}:${ev.toolCallId ?? "-"}:${ev.mode}:${ev.parentSessionId}`);
  };
  const onComplete = (ev: { parentSessionId: string }): void => { events.push(`complete:${ev.parentSessionId}`); };
  hooks.on("subagent:spawn", onSpawn);
  hooks.on("subagent:complete", onComplete);

  try {
    const existing = await reg.listExistingIds();
    const { id } = await runner.spawn({ displayName: "worker", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: PARENT, visibility: "global" });
    events.length = 0;

    // A stream is only ever resolved after the spawn event, since the app channel creates the
    // sub-agent's streamer while handling it.
    const asked: string[] = [];
    const provider = (subagentId: string): undefined => { asked.push(`${subagentId}:${events.length}`); return undefined; };

    const sent = await runner.send(id, "again", undefined, createMessage(), reg, PARENT, undefined, undefined, "send-call-1", provider);
    assert.equal(sent, "ack");
    assert.deepEqual(events, [`spawn:send:send-call-1:session:${PARENT}`, `complete:${PARENT}`]);
    assert.deepEqual(asked, [`${id}:1`]);

    // A human driving the sub-agent's own thread has no parent card, so it stays silent.
    events.length = 0;
    assert.equal(await runner.send(id, "and again", undefined, createMessage(), reg, PARENT), "ack");
    assert.deepEqual(events, []);

    await deleteSession(id);
  } finally {
    hooks.off("subagent:spawn", onSpawn);
    hooks.off("subagent:complete", onComplete);
    fetchMock.restore();
  }
});

// The page draws its bubble with the id it sent, and history is matched against it by id. A forged
// id deduped correctly inside the session while being invisible to the page, which then showed the
// same message twice.
test("a human send keeps its own message id, a model-driven one does not", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const PARENT = "my-claw-app/thread/owner/main";

  const fetchMock = mockFetch(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    { status: 200 },
  ) as never);

  const from = (id: string): UnifiedMessage => ({ ...createMessage(), id });

  try {
    const existing = await reg.listExistingIds();
    const { id } = await runner.spawn({ displayName: "keeper", type: "research", mode: "session", task: "init", parentMessage: from("spawn-msg"), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: PARENT, visibility: "global" });

    // Human path: no tool call id, so the caller's own id is what lands on the turn.
    await runner.send(id, "human one", undefined, from("bubble-1"), reg, PARENT);
    await runner.send(id, "human two", undefined, from("bubble-2"), reg, PARENT);
    // Model path: the card lives in the parent thread, so the id must not be reused -- two sends in
    // one parent turn share one message id and would otherwise collapse into a single turn.
    await runner.send(id, "model one", undefined, from("parent-turn"), reg, PARENT, undefined, undefined, "call-a");
    await runner.send(id, "model two", undefined, from("parent-turn"), reg, PARENT, undefined, undefined, "call-b");

    // In the log system, each UserEntry has its own unique id. Four sends = four distinct entries.
    const log = await openSessionLog(id);
    const userEntries = (await log.all()).filter((e): e is UserEntry => e.type === "user");
    // The init task + 4 sends = 5 user entries
    assert.equal(userEntries.length, 5);
    // Human-driven sends own the bubbles the app already drew. Model-driven sends stay generated
    // because their visible identity belongs to the parent tool card.
    assert.equal(userEntries[1]!.id, "bubble-1");
    assert.equal(userEntries[2]!.id, "bubble-2");
    // All ids are unique
    const ids = userEntries.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "each send creates a distinct entry");

    await deleteSession(id);
  } finally {
    fetchMock.restore();
  }
});

// A hand-back needs to know which conversations an agent is working for. `meta.parentSessionId` is
// the creator and `invokedBy` is only ever the last driver, so neither answers it.
test("a sub-agent records every conversation that drove it, creator marked", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const CREATOR = "my-claw-app/thread/owner/main";
  const OTHER = "my-claw-app/thread/owner/side";

  const fetchMock = mockFetch(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    { status: 200 },
  ) as never);

  try {
    const existing = await reg.listExistingIds();
    const { id } = await runner.spawn({ displayName: "shared", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: CREATOR, visibility: "global" });

    await runner.send(id, "from the other one", undefined, createMessage(), reg, OTHER);
    await runner.send(id, "and again", undefined, createMessage(), reg, OTHER);

    const callers = await runner.callersOf(id, CREATOR);
    assert.ok(callers);
    // Newest activity first, so the conversation that just used it is the one offered first.
    assert.equal(callers![0]?.sessionId, OTHER);
    assert.equal(callers![0]?.runs, 2);
    assert.equal(callers![0]?.creator, false);
    const creator = callers!.find((c) => c.sessionId === CREATOR);
    assert.equal(creator?.creator, true);
    assert.equal(creator?.runs, 1);

    await deleteSession(id);
  } finally {
    fetchMock.restore();
  }
});

// Reading the list is authorised exactly like driving the agent: it is also the allow-list a
// hand-back is checked against, so a caller who may not reach the agent must not learn who does.
test("the caller list obeys the visibility rule", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const OWNER = "my-claw-app/thread/owner/main";
  const STRANGER = "my-claw-app/thread/owner/stranger";

  const fetchMock = mockFetch(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    { status: 200 },
  ) as never);

  try {
    const existing = await reg.listExistingIds();
    const secret = await runner.spawn({ displayName: "secret", type: "research", mode: "session", task: "init", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: OWNER, visibility: "private" });

    assert.ok(await runner.callersOf(secret.id, OWNER));
    assert.equal(await runner.callersOf(secret.id, STRANGER), undefined);
    // A missing agent and an unreachable one answer the same way, on purpose.
    assert.equal(await runner.callersOf("subagent/does-not-exist", OWNER), undefined);

    await deleteSession(secret.id);
  } finally {
    fetchMock.restore();
  }
});

/**
 * The filing of a delegated run, stamped at the drive that starts the work: the folder its payer
 * is in at that moment, re-read on every drive so a re-filed conversation moves its future work
 * with it. What the run's calls then record is `usageFolderOf`, whose rule lives in
 * tests/analytics/usage-attribution.test.ts -- this test is the stamp itself.
 */
test("a run is filed as its payer's folder, re-stamped at every drive", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const CREATOR = "matrix/room/!filing-creator:test";
  const DRIVER = "telegram/dm/555222";
  const now = new Date().toISOString();
  const filed = (id: string, folderId: string) =>
    writeMeta(id, {
      id,
      platform: "matrix",
      chatType: "dm",
      createdAt: now,
      lastActiveAt: now,
      storageVersion: STORAGE_VERSION,
      leafId: null,
      folderId,
    });
  await filed(CREATOR, "folder-career");
  await filed(DRIVER, "folder-dev");

  const fetchMock = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }) as never);
  // The stamp is runtime state (like `invokedBy`) and the row is where it has to land: what is
  // asserted is the `folder_id` each run's calls were recorded with.
  const filedFolders = (sessionId: string): string[] =>
    (analyticsDb().prepare("SELECT folder_id FROM api_calls WHERE session_id = ?").all(sessionId) as Array<{ folder_id: string | null }>).map((r) => r.folder_id ?? "(none)");
  try {
    const { id } = await runner.spawn({
      displayName: "filing",
      type: "research",
      mode: "session",
      task: "init",
      parentMessage: createMessage(),
      existingIds: await reg.listExistingIds(),
      generateId: (n, e) => reg.generateId(n, e),
      parentSessionId: CREATOR,
      visibility: "global",
    });
    const spawned = filedFolders(id);
    assert.ok(spawned.length > 0, "the spawn run recorded calls");
    // And the provider that served them, by its key: the implicit provider of a legacy config.
    const keys = analyticsDb().prepare("SELECT DISTINCT provider_key AS key FROM api_calls WHERE session_id = ?").all(id) as Array<{ key: string | null }>;
    assert.deepEqual(keys.map((k) => k.key), ["default"]);
    assert.deepEqual([...new Set(spawned)], ["folder-career"]);

    await runner.send(id, "do more", undefined, createMessage(), reg, DRIVER);
    // The drive re-stamps: this run's calls are filed as the folder the driver was in, not the one
    // the creator was in when the agent was born.
    assert.deepEqual([...new Set(filedFolders(id))], ["folder-career", "folder-dev"]);
  } finally {
    fetchMock.restore();
  }
});

test("one-shot runs have no concurrency cap: a fourth and a fifth start while three are in flight", async () => {
  // The owner wants the model free to fan out (2026-09-23): the old cap of 3 answered the fourth
  // spawn "run limit reached" while the first three were still waiting on their model.
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();

  let inFlight = 0;
  let arrived: () => void = () => {};
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchMock = mockFetch(async () => {
    inFlight += 1;
    arrived();
    await gate;
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 }) as never;
  });
  const waitInFlight = async (n: number): Promise<void> => {
    while (inFlight < n) await new Promise<void>((resolve) => { arrived = resolve; });
  };
  const spawnOne = async (name: string) => {
    const existing = await reg.listExistingIds();
    return runner.spawn({ displayName: name, type: "research", mode: "run", task: "explore", parentMessage: createMessage(), existingIds: existing, generateId: (n, e) => reg.generateId(n, e), parentSessionId: "matrix/room/!caller:test", visibility: "global" });
  };

  try {
    const first = [spawnOne("fan-a"), spawnOne("fan-b"), spawnOne("fan-c")];
    await waitInFlight(3);
    const late = [spawnOne("fan-d"), spawnOne("fan-e")];
    // A refused spawn answers at once and never reaches the model: settle on whichever comes first
    // so the assertion names the refusal instead of timing out.
    await Promise.race([waitInFlight(5), Promise.all(late).then(() => undefined)]);
    release();
    const results = await Promise.all([...first, ...late]);
    assert.deepEqual(results.map((r) => r.result), ["done", "done", "done", "done", "done"]);
  } finally {
    release();
    fetchMock.restore();
  }
});

/**
 * A spawn may pin its sub-agent's reasoning and its context ceiling, and both have to survive on
 * the session: they are `effortOverride` and `contextOverride`, the two fields a chat's `/effort`
 * and `/cap` write, so the resolver and the window reader apply them with no second precedence.
 */
test("a spawn's effort and ceiling land on the sub-agent's session, and outlive it", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const fetchMock = mockFetch(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: "pinned" } }] }),
    { status: 200 },
  ) as never);

  try {
    const { id } = await runner.spawn({
      displayName: "pinned", type: "research", mode: "session", task: "go",
      parentMessage: createMessage(), existingIds: await reg.listExistingIds(),
      generateId: (n, e) => reg.generateId(n, e), parentSessionId: "my-claw-app/thread/u1/c1",
      visibility: "global",
      pins: { effort: "high", contextCap: 720_000 },
    });
    const stored = await loadSession(id);
    assert.equal(stored?.effortOverride, "high");
    assert.equal(stored?.contextOverride, 720_000);
  } finally {
    fetchMock.restore();
  }
});

/** Omitted, they stay absent: a spawn that says nothing must not overwrite the agent's own scope. */
test("a spawn without pins leaves the sub-agent's own scope alone", async () => {
  const registry = new ToolRegistry();
  const runner = new SubAgentRunner(config, registry, new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const fetchMock = mockFetch(async () => new Response(
    JSON.stringify({ choices: [{ message: { content: "plain" } }] }),
    { status: 200 },
  ) as never);

  try {
    const { id } = await runner.spawn({
      displayName: "plain", type: "research", mode: "session", task: "go",
      parentMessage: createMessage(), existingIds: await reg.listExistingIds(),
      generateId: (n, e) => reg.generateId(n, e), parentSessionId: "my-claw-app/thread/u1/c1",
      visibility: "global",
    });
    const stored = await loadSession(id);
    assert.equal(stored?.effortOverride, undefined);
    assert.equal(stored?.contextOverride, undefined);
  } finally {
    fetchMock.restore();
  }
});
