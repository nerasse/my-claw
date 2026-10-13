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
import { mintNode, nodesFilePath, resetNodesStore } from "../../src/nodes/store.ts";
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
  await rm(nodesFilePath(), { force: true });
  resetNodesStore();
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
    expect(tools?.map((t) => t.function.name).sort()).toEqual(["bash", "read"]);
    expect(tools?.[0]?.function.description).toContain('remote node "web01"');
  } finally {
    mock.restore();
  }
});
