import { describe, test, expect, beforeEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SocketRegistry } from "../../src/channels/my-claw-app/socket-registry.ts";
import type { MyClawAppSessionData } from "../../src/channels/my-claw-app/controllers.ts";
import type { MyClawAppServerFrame } from "../../src/channels/my-claw-app/types.ts";
import {
  handleNodesAdd,
  handleNodesList,
  handleNodesRevoke,
  nodeFrame,
  type MyClawAppNodeDeps,
} from "../../src/channels/my-claw-app/node-handlers.ts";
import { nodeAgentName, removeNodeAgent, writeNodeAgent } from "../../src/nodes/agent.ts";
import { nodeSummaries, openNodeClaim, revokeNodeForApp } from "../../src/nodes/app.ts";
import { consumeClaim, resetClaims } from "../../src/nodes/claims.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { attachNodeSocket, handleNodeFrame, resetNodeHub, type NodeSocketData } from "../../src/nodes/hub.ts";
import { mintNode, nodeRecord, nodesFilePath, resetNodesStore } from "../../src/nodes/store.ts";
import type { NodeFacts } from "../../src/nodes/types.ts";

const FACTS: NodeFacts = {
  os: "linux",
  arch: "x64",
  hostname: "web01",
  user: "neras",
  mode: "admin",
  version: "0.2.0",
  tools: [
    { name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } },
    { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
  ],
};

async function pairNode(name = "web01"): Promise<{ nodeId: string; agent: string }> {
  const minted = await mintNode({ name, facts: FACTS });
  if (!minted.ok) throw new Error(minted.error);
  const agent = await writeNodeAgent(minted.minted.record, FACTS);
  return { nodeId: minted.minted.record.nodeId, agent };
}

interface FakeNodeSocket {
  ws: ServerWebSocket<NodeSocketData>;
  closes: Array<{ code?: number; reason?: string }>;
}

function fakeNodeSocket(nodeId: string): FakeNodeSocket {
  const closes: Array<{ code?: number; reason?: string }> = [];
  const ws = {
    data: { node: true as const, nodeId, lastSeen: Date.now() },
    send: () => {},
    close: (code?: number, reason?: string) => {
      closes.push({ code, reason });
    },
  };
  return { ws: ws as unknown as ServerWebSocket<NodeSocketData>, closes };
}

interface FakeAppSocket {
  ws: ServerWebSocket<MyClawAppSessionData>;
  frames: MyClawAppServerFrame[];
}

function fakeAppSocket(owner = "neras"): FakeAppSocket {
  const frames: MyClawAppServerFrame[] = [];
  const ws = {
    data: { deviceId: "dev-1", owner, lastSeen: Date.now() },
    send: (raw: string) => {
      frames.push(JSON.parse(raw) as MyClawAppServerFrame);
    },
  };
  return { ws: ws as unknown as ServerWebSocket<MyClawAppSessionData>, frames };
}

function deps(options: { nodes?: unknown; sockets?: FakeAppSocket[] } = {}): MyClawAppNodeDeps {
  return {
    nodes: () => (options.nodes === null ? undefined : (options.nodes as never) ?? { claimTtlSeconds: 120 }),
    sockets: { all: () => (options.sockets ?? []).map(socket => socket.ws) } as unknown as SocketRegistry,
    sendFrame: (ws, frame) => ws?.send(JSON.stringify(frame)),
  };
}

beforeEach(async () => {
  await resetNodesStore();
  await rm(nodesFilePath(), { force: true });
  await rm(join(MY_CLAW_DIR, "agents"), { recursive: true, force: true });
  resetClaims();
  resetNodeHub();
});

describe("node summaries", () => {
  test("no node, no row", async () => {
    expect(await nodeSummaries()).toEqual([]);
  });

  test("a paired node keeps the facts it announced, and its agent", async () => {
    const { nodeId, agent } = await pairNode();
    const summaries = await nodeSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.nodeId).toBe(nodeId);
    expect(summaries[0]?.online).toBe(false);
    expect(summaries[0]?.facts?.hostname).toBe("web01");
    expect(summaries[0]?.agent).toBe(agent);
    expect(await nodeAgentName(nodeId)).toBe(agent);
  });

  test("a connected node reads online, with the facts it just announced", async () => {
    const { nodeId } = await pairNode();
    const socket = fakeNodeSocket(nodeId);
    attachNodeSocket(socket.ws);
    handleNodeFrame(socket.ws, JSON.stringify({ type: "node.hello", protocol: 1, facts: { ...FACTS, version: "0.3.0" } }));
    const summaries = await nodeSummaries();
    expect(summaries[0]?.online).toBe(true);
    expect(summaries[0]?.facts?.version).toBe("0.3.0");
  });

  test("the frame the app receives is flat, tools by name", async () => {
    const { nodeId, agent } = await pairNode();
    const [summary] = await nodeSummaries();
    const frame = nodeFrame(summary!);
    expect(frame).toMatchObject({
      nodeId,
      name: "web01",
      online: false,
      os: "linux",
      arch: "x64",
      mode: "admin",
      version: "0.2.0",
      tools: ["bash", "read"],
      agent,
    });
    expect(frame).not.toHaveProperty("facts");
  });

  test("a node whose agent file was renamed away shows without one", async () => {
    const { nodeId } = await pairNode();
    await removeNodeAgent(nodeId);
    const [summary] = await nodeSummaries();
    expect(summary?.agent).toBeUndefined();
  });
});

describe("node claim", () => {
  test("the config's TTL is honoured, and the code is single use", () => {
    const opened = openNodeClaim({ claimTtlSeconds: 120 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.expiresAt - Date.now()).toBeGreaterThan(100_000);
    expect(opened.expiresAt - Date.now()).toBeLessThanOrEqual(120_000);
    expect(consumeClaim(opened.code).ok).toBe(true);
    expect(consumeClaim(opened.code).ok).toBe(false);
  });

  test("without a nodes config the default TTL applies", () => {
    const opened = openNodeClaim(undefined);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.expiresAt - Date.now()).toBeGreaterThan(500_000);
  });

  test("the name the app typed travels to the pairing", () => {
    const opened = openNodeClaim(undefined, "  build box  ");
    if (!opened.ok) throw new Error(opened.reason);
    const claimed = consumeClaim(opened.code);
    expect(claimed.ok).toBe(true);
    if (claimed.ok) expect(claimed.name).toBe("build box");
  });
});

describe("node revocation", () => {
  test("an unknown node is refused", async () => {
    expect(await revokeNodeForApp("nope")).toEqual({ ok: false, error: "unknown node" });
  });

  test("the record, the socket and the agent go together", async () => {
    const { nodeId } = await pairNode();
    const socket = fakeNodeSocket(nodeId);
    attachNodeSocket(socket.ws);
    expect(await revokeNodeForApp(nodeId)).toEqual({ ok: true });
    expect(nodeRecord(nodeId)).toBeUndefined();
    expect(await nodeAgentName(nodeId)).toBeUndefined();
    expect(socket.closes).toHaveLength(1);
  });
});

describe("node frames", () => {
  test("the roster answers the list frame", async () => {
    await pairNode();
    const app = fakeAppSocket();
    await handleNodesList(deps(), app.ws);
    expect(app.frames[0]?.type).toBe("nodes.list.result");
    const frame = app.frames[0] as { nodes: Array<{ name: string; tools: string[] }> };
    expect(frame.nodes).toHaveLength(1);
    expect(frame.nodes[0]?.name).toBe("web01");
    expect(frame.nodes[0]?.tools).toEqual(["bash", "read"]);
  });

  test("add answers a code the machine can claim", () => {
    const app = fakeAppSocket();
    handleNodesAdd(deps(), app.ws, { name: "build box" });
    const frame = app.frames[0] as { type: string; ok: boolean; code?: string };
    expect(frame.type).toBe("nodes.add.result");
    expect(frame.ok).toBe(true);
    const claimed = consumeClaim(frame.code ?? "");
    expect(claimed.ok).toBe(true);
    if (claimed.ok) expect(claimed.name).toBe("build box");
  });

  test("a revoke mirrors the new roster to the owner's other windows, not to the sender", async () => {
    const { nodeId } = await pairNode();
    const sender = fakeAppSocket();
    const other = fakeAppSocket();
    const stranger = fakeAppSocket("someone-else");
    await handleNodesRevoke(deps({ sockets: [sender, other, stranger] }), sender.ws, nodeId);
    expect(sender.frames.map(frame => frame.type)).toEqual(["nodes.revoke.result"]);
    expect(other.frames.map(frame => frame.type)).toEqual(["nodes.list.result"]);
    expect((other.frames[0] as { nodes: unknown[] }).nodes).toEqual([]);
    expect(stranger.frames).toEqual([]);
  });

  test("a revoke of something unknown answers the error", async () => {
    const app = fakeAppSocket();
    await handleNodesRevoke(deps(), app.ws, "nope");
    expect(app.frames[0]).toMatchObject({ type: "nodes.revoke.result", ok: false, error: "unknown node" });
  });
});
