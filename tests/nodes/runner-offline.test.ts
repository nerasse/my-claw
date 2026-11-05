/**
 * A node agent whose machine is away, and the run that happens when it is back.
 *
 * The spawn is the moment to refuse: no session, no log entry, no model call for a machine that
 * cannot answer. When the node is connected, the run's tools are the machine's live manifest --
 * proven here by reading the tools the LLM request actually carried.
 */

import { test, expect, beforeEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import { rm } from "node:fs/promises";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { AgentRegistry } from "../../src/agents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { subagentSessionIdsSync } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { FileAgent } from "../../src/agents/types.ts";
import { attachNodeSocket, handleNodeFrame, resetNodeHub, type NodeSocketData } from "../../src/nodes/hub.ts";
import { mintNode, nodesFilePath, resetNodesStore, setNodeAccess } from "../../src/nodes/store.ts";
import type { NodeFacts } from "../../src/nodes/types.ts";

const config: MyClawConfig = {
  whitelist: ["owner"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: {},
  memory: { enabled: false },
};

const voiceManager = new VoiceManager(config);
const sttPipeline = new SttPipeline(voiceManager);

const FACTS: NodeFacts = {
  os: "linux",
  arch: "x64",
  hostname: "web01",
  user: "neras",
  mode: "user",
  version: "0.1.0",
  tools: [
    { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
  ],
};

function nodeAgent(nodeId: string): FileAgent {
  return {
    name: "node-web01",
    source: "custom",
    path: "/agents/node-web01.md",
    prompt: "You work on web01.",
    meta: { description: "Remote node web01", base: "node", node: nodeId, instructions: [] },
  };
}

function parentMessage(): UnifiedMessage {
  return {
    id: "m1",
    platform: "my-claw-app",
    userId: "owner",
    chatId: "owner",
    chatType: "dm",
    text: "go",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function runnerFor(agent: FileAgent): SubAgentRunner {
  return new SubAgentRunner(
    config,
    new ToolRegistry(),
    new SkillRegistry(),
    voiceManager,
    sttPipeline,
    new AgentRegistry(new Map([[agent.name, agent]])),
  );
}

async function spawnIt(runner: SubAgentRunner) {
  return runner.spawn({
    displayName: "web",
    type: "node-web01",
    mode: "run",
    task: "df -h",
    parentMessage: parentMessage(),
    existingIds: new Set(),
    generateId: () => "subagent/web-abcd",
    parentSessionId: "chat-1",
    visibility: "private",
  });
}

beforeEach(async () => {
  await resetNodesStore();
  await rm(nodesFilePath(), { force: true });
  resetNodeHub();
});

test("a spawn of an offline node answers at once and leaves nothing behind", async () => {
  const minted = await mintNode({ name: "web01", facts: FACTS });
  if (!minted.ok) throw new Error("mint failed");
  const runner = runnerFor(nodeAgent(minted.minted.record.nodeId));
  const before = subagentSessionIdsSync().length;

  const spawned = await spawnIt(runner);
  expect(spawned.id).toBe("");
  expect(spawned.result).toContain("offline");
  expect(subagentSessionIdsSync().length).toBe(before);
});

test("a node agent whose node was revoked says so", async () => {
  const runner = runnerFor(nodeAgent("node-00000000"));
  const spawned = await spawnIt(runner);
  expect(spawned.result).toContain("not paired");
});

test("a connected node runs with its manifest as the tool set", async () => {
  const minted = await mintNode({ name: "web01", facts: FACTS });
  if (!minted.ok) throw new Error("mint failed");
  const nodeId = minted.minted.record.nodeId;

  const ws = {
    data: { node: true as const, nodeId, lastSeen: Date.now() },
    send: () => undefined,
    close: () => undefined,
  } as unknown as ServerWebSocket<NodeSocketData>;
  attachNodeSocket(ws);
  handleNodeFrame(ws, JSON.stringify({ type: "node.hello", protocol: 1, facts: FACTS }));

  const requests: Array<Record<string, unknown>> = [];
  const mock = mockFetch(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "df answered" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });
  try {
    const runner = runnerFor(nodeAgent(nodeId));
    const spawned = await spawnIt(runner);
    expect(spawned.result).toBe("df answered");

    const tools = requests[0]?.["tools"] as Array<{ function: { name: string; description: string } }> | undefined;
    expect(tools?.map((t) => t.function.name).sort()).toEqual(["bash", "read", "send_file_to_node"]);
    expect(tools?.[0]?.function.description).toContain('remote node "web01"');
  } finally {
    mock.restore();
  }
});

test("a disabled node refuses the spawn, and says what to do", async () => {
  const minted = await mintNode({ name: "web01", facts: FACTS });
  if (!minted.ok) throw new Error("mint failed");
  const nodeId = minted.minted.record.nodeId;
  await setNodeAccess(nodeId, { disabled: true });
  const runner = runnerFor(nodeAgent(nodeId));
  const before = subagentSessionIdsSync().length;

  const spawned = await spawnIt(runner);
  expect(spawned.id).toBe("");
  expect(spawned.result).toContain('node "web01" is disabled');
  expect(spawned.result).toContain("Settings > Nodes");
  expect(subagentSessionIdsSync().length).toBe(before);
});

test("a disabled node stays refused even while its machine is connected", async () => {
  const minted = await mintNode({ name: "web01", facts: FACTS });
  if (!minted.ok) throw new Error("mint failed");
  const nodeId = minted.minted.record.nodeId;
  const ws = {
    data: { node: true as const, nodeId, lastSeen: Date.now() },
    send: () => undefined,
    close: () => undefined,
  } as unknown as ServerWebSocket<NodeSocketData>;
  attachNodeSocket(ws);
  handleNodeFrame(ws, JSON.stringify({ type: "node.hello", protocol: 1, facts: FACTS }));
  await setNodeAccess(nodeId, { disabled: true });

  const spawned = await spawnIt(runnerFor(nodeAgent(nodeId)));
  expect(spawned.result).toContain("is disabled");
});

test("turning it back on lets the run start again", async () => {
  const minted = await mintNode({ name: "web01", facts: FACTS });
  if (!minted.ok) throw new Error("mint failed");
  const nodeId = minted.minted.record.nodeId;
  await setNodeAccess(nodeId, { disabled: true });
  await setNodeAccess(nodeId, { disabled: false });
  const runner = runnerFor(nodeAgent(nodeId));
  const spawned = await spawnIt(runner);
  // Enabled but offline: the refusal is the offline one, not the disabled one.
  expect(spawned.result).toContain("offline");
  expect(spawned.result).not.toContain("disabled");
});

/**
 * The owner's call: a tool added to a node while a run is going is usable in that same run, at
 * the next turn, and the cache a changed tool block costs is accepted. The set is rebuilt per
 * turn; this is what proves the next request carries it.
 */
function chatCompletion(body: Record<string, unknown>, opts: { tool?: { id: string; name: string; args: string } } = {}) {
  const message = opts.tool
    ? { content: null, tool_calls: [{ id: opts.tool.id, type: "function", function: { name: opts.tool.name, arguments: opts.tool.args } }] }
    : { content: "done" };
  return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }) as never;
}

function nodeSocket(nodeId: string, onCall?: () => Promise<unknown>) {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    data: { node: true as const, nodeId, lastSeen: Date.now() },
    send: (raw: string) => {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      sent.push(frame);
      if (frame["type"] !== "node.call") return;
      void (async () => {
        await onCall?.();
        handleNodeFrame(ws as unknown as ServerWebSocket<NodeSocketData>, JSON.stringify({ type: "node.result", callId: frame["callId"], ok: true, output: "hosts" }));
      })();
    },
    close: () => undefined,
  };
  return ws as unknown as ServerWebSocket<NodeSocketData>;
}

function toolNamesOf(request: Record<string, unknown> | undefined): string[] {
  const tools = request?.["tools"] as Array<{ function: { name: string } }> | undefined;
  return (tools ?? []).map((tool) => tool.function.name).sort();
}

test("a node tool that must ask reaches the parent conversation, and runs once allowed", async () => {
  const minted = await mintNode({ name: "web01", facts: FACTS });
  if (!minted.ok) throw new Error("mint failed");
  const nodeId = minted.minted.record.nodeId;
  await setNodeAccess(nodeId, { approval: true });
  const ws = nodeSocket(nodeId);
  attachNodeSocket(ws);
  handleNodeFrame(ws, JSON.stringify({ type: "node.hello", protocol: 1, facts: FACTS }));

  const requests: Array<Record<string, unknown>> = [];
  const mock = mockFetch(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return requests.length === 1 ? chatCompletion({}, { tool: { id: "call-1", name: "read", args: JSON.stringify({ path: "/etc/hosts" }) } }) : chatCompletion({});
  });
  try {
    const asked: Array<{ toolName: string; threadId?: string; sessionId: string }> = [];
    const runner = runnerFor(nodeAgent(nodeId));
    runner.setApprovalHandler(async (request) => {
      asked.push({ toolName: request.toolName, ...(request.threadId ? { threadId: request.threadId } : {}), sessionId: request.sessionId });
      return "allow-once";
    });
    const parent = parentMessage();
    const spawned = await runner.spawn({
      displayName: "web",
      type: "node-web01",
      mode: "run",
      task: "cat /etc/hosts",
      parentMessage: { ...parent, threadId: "projet" },
      existingIds: new Set(),
      generateId: () => "subagent/web-abcd",
      parentSessionId: "chat-1",
      visibility: "private",
    });
    expect(spawned.result).toBe("done");
    // The prompt names the tool, and rides the parent's thread: a sub-agent has no screen of its own.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.toolName).toBe("read");
    expect(asked[0]?.threadId).toBe("projet");
    expect(asked[0]?.sessionId).toBe(spawned.id);
    // The tool actually ran on the machine, instead of being denied on sight.
    const outputs = requests.map((request) => JSON.stringify(request));
    expect(outputs.some((body) => body.includes("denied by approval policy"))).toBe(false);
  } finally {
    mock.restore();
  }
});

test("a tool exposed while the run is going is in the next turn's payload", async () => {
  const minted = await mintNode({ name: "web01", facts: FACTS });
  if (!minted.ok) throw new Error("mint failed");
  const nodeId = minted.minted.record.nodeId;
  await setNodeAccess(nodeId, { tools: ["read"] });
  const ws = nodeSocket(nodeId, () => setNodeAccess(nodeId, { tools: ["read", "bash"] }));
  attachNodeSocket(ws);
  handleNodeFrame(ws, JSON.stringify({ type: "node.hello", protocol: 1, facts: FACTS }));

  const requests: Array<Record<string, unknown>> = [];
  const mock = mockFetch(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return requests.length === 1 ? chatCompletion({}, { tool: { id: "call-1", name: "read", args: JSON.stringify({ path: "/etc/hosts" }) } }) : chatCompletion({});
  });
  try {
    const spawned = await spawnIt(runnerFor(nodeAgent(nodeId)));
    expect(spawned.result).toBe("done");
    expect(toolNamesOf(requests[0])).toEqual(["read", "send_file_to_node"]);
    // The owner opened `bash` while the tool call was in flight: the second turn carries it.
    expect(toolNamesOf(requests[1])).toEqual(["bash", "read", "send_file_to_node"]);
  } finally {
    mock.restore();
  }
});

test("a tool taken away while the run is going is gone from the next turn's payload", async () => {
  const minted = await mintNode({ name: "web01", facts: FACTS });
  if (!minted.ok) throw new Error("mint failed");
  const nodeId = minted.minted.record.nodeId;
  const ws = nodeSocket(nodeId, () => setNodeAccess(nodeId, { tools: ["read"] }));
  attachNodeSocket(ws);
  handleNodeFrame(ws, JSON.stringify({ type: "node.hello", protocol: 1, facts: FACTS }));

  const requests: Array<Record<string, unknown>> = [];
  const mock = mockFetch(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return requests.length === 1 ? chatCompletion({}, { tool: { id: "call-1", name: "read", args: JSON.stringify({ path: "/etc/hosts" }) } }) : chatCompletion({});
  });
  try {
    const spawned = await spawnIt(runnerFor(nodeAgent(nodeId)));
    expect(spawned.result).toBe("done");
    expect(toolNamesOf(requests[0])).toEqual(["bash", "read", "send_file_to_node"]);
    expect(toolNamesOf(requests[1])).toEqual(["read", "send_file_to_node"]);
  } finally {
    mock.restore();
  }
});
