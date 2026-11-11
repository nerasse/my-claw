import { describe, test, expect, beforeEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SocketRegistry } from "../../src/channels/my-claw-app/socket-registry.ts";
import type { MyClawAppSessionData } from "../../src/channels/my-claw-app/controllers.ts";
import type { MyClawAppServerFrame } from "../../src/channels/my-claw-app/types.ts";
import {
  handleNodesAccessSet,
  handleNodesAdd,
  handleNodesDescribe,
  handleNodesList,
  handleNodesMcpSet,
  handleNodesRename,
  handleNodesRevoke,
  handleNodesUpdate,
  nodeFrame,
  type MyClawAppNodeDeps,
} from "../../src/channels/my-claw-app/node-handlers.ts";
import { nodeAgentName, removeNodeAgent, writeNodeAgent } from "../../src/nodes/agent.ts";
import { setNodeMcp } from "../../src/nodes/store.ts";
import {
  nodeSummaries,
  openNodeClaim,
  renameNodeForApp,
  revokeNodeForApp,
  setNodeAccessForApp,
  setNodeDescriptionForApp,
  updateNodeForApp,
} from "../../src/nodes/app.ts";
import { readAppVersion } from "../../src/core/diagnostics.ts";
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
  sent: Array<Record<string, unknown>>;
  closes: Array<{ code?: number; reason?: string }>;
}

function fakeNodeSocket(nodeId: string): FakeNodeSocket {
  const sent: Array<Record<string, unknown>> = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const ws = {
    data: { node: true as const, nodeId, lastSeen: Date.now() },
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
    close: (code?: number, reason?: string) => {
      closes.push({ code, reason });
    },
  };
  return { ws: ws as unknown as ServerWebSocket<NodeSocketData>, sent, closes };
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

  test("its standing grants go with it, and the machine on this side keeps theirs", async () => {
    const { nodeId } = await pairNode();
    const write = async (): Promise<void> => {
      const path = join(MY_CLAW_DIR, "config.json");
      const current = JSON.parse(await Bun.file(path).text().catch(() => "{}")) as Record<string, unknown>;
      current["tools"] = { alwaysAllow: [
        { tool: "bash", origin: "local", args: '{"command":"df -h"}' },
        { tool: "bash", origin: nodeId, args: '{"command":"uptime"}' },
      ] };
      await Bun.write(path, JSON.stringify(current, null, 2));
    };
    await write();

    expect(await revokeNodeForApp(nodeId)).toEqual({ ok: true });

    const after = JSON.parse(await Bun.file(join(MY_CLAW_DIR, "config.json")).text()) as {
      tools?: { alwaysAllow?: Array<{ origin: string }> };
    };
    expect(after.tools?.alwaysAllow?.map((grant) => grant.origin)).toEqual(["local"]);
  });
});

describe("node rename", () => {
  test("the record and the agent file move together", async () => {
    const { nodeId } = await pairNode();
    const renamed = await renameNodeForApp(nodeId, "prod web");
    expect(renamed).toEqual({ ok: true, agent: "node-prod-web" });
    expect(nodeRecord(nodeId)?.name).toBe("prod web");
    expect(await nodeAgentName(nodeId)).toBe("node-prod-web");
  });

  test("the prompt below the header survives the move", async () => {
    const { nodeId } = await pairNode();
    await renameNodeForApp(nodeId, "prod web");
    const text = await Bun.file(join(MY_CLAW_DIR, "agents", "node-prod-web.md")).text();
    expect(text).toContain(`node: ${nodeId}`);
    expect(text).toContain("You are the agent of the remote node");
  });

  test("a name another node already holds is refused", async () => {
    await pairNode("web01");
    const second = await pairNode("web02");
    expect(await renameNodeForApp(second.nodeId, "Web01")).toEqual({ ok: false, error: 'a node named "Web01" already exists' });
  });

  test("a name whose agent file is taken is refused before anything moves", async () => {
    const first = await pairNode("web01");
    const second = await pairNode("web02");
    expect(second.agent).toBe("node-web02");
    // web02's file is renamed onto web01's name: the file is there, the rename stops.
    const renamed = await renameNodeForApp(second.nodeId, "web01");
    expect(renamed.ok).toBe(false);
    expect(renamed.error).toContain("already exists");
    expect(nodeRecord(second.nodeId)?.name).toBe("web02");
    expect(await nodeAgentName(second.nodeId)).toBe("node-web02");
    expect(nodeRecord(first.nodeId)?.name).toBe("web01");
  });

  test("renaming to the same name is a no-op, not an error", async () => {
    const { nodeId, agent } = await pairNode();
    expect(await renameNodeForApp(nodeId, "  web01  ")).toEqual({ ok: true, agent });
  });

  test("an unknown node is refused", async () => {
    expect(await renameNodeForApp("nope", "web01")).toEqual({ ok: false, error: "unknown node" });
  });
});

describe("node description", () => {
  test("only the description line is rewritten", async () => {
    const { nodeId } = await pairNode();
    expect(await setNodeDescriptionForApp(nodeId, "The build box. Never touch /etc.")).toEqual({ ok: true });
    const text = await Bun.file(join(MY_CLAW_DIR, "agents", "node-web01.md")).text();
    expect(text).toContain('description: The build box. Never touch /etc.');
    expect(text).toContain("base: node");
    expect(text).toContain(`node: ${nodeId}`);
    expect(text).toContain("You are the agent of the remote node");
    expect((await nodeSummaries())[0]?.description).toBe("The build box. Never touch /etc.");
  });

  test("a description is one line by construction", async () => {
    const { nodeId } = await pairNode();
    await setNodeDescriptionForApp(nodeId, "  two\nlines   here  ");
    const text = await Bun.file(join(MY_CLAW_DIR, "agents", "node-web01.md")).text();
    expect(text).toContain("description: two lines here");
  });

  test("an empty description is refused", async () => {
    const { nodeId } = await pairNode();
    expect(await setNodeDescriptionForApp(nodeId, "   ")).toEqual({ ok: false, error: "a description is required" });
  });

  test("a node without an agent file is refused", async () => {
    const { nodeId } = await pairNode();
    await removeNodeAgent(nodeId);
    expect(await setNodeDescriptionForApp(nodeId, "anything")).toEqual({ ok: false, error: "this node has no agent file" });
  });
});

describe("node access", () => {
  test("a freshly paired machine reads as asking before anything runs", async () => {
    await pairNode();
    const summary = (await nodeSummaries())[0];
    expect(summary?.approval).toBe(true);
    expect(nodeFrame(summary!).approval).toBe(true);
  });

  test("an exposed subset and the approval flag are stored, and read back", async () => {
    const { nodeId } = await pairNode();
    expect(await setNodeAccessForApp(nodeId, { tools: ["read"], approval: true })).toEqual({ ok: true });
    const summary = (await nodeSummaries())[0];
    expect(summary?.exposed).toEqual(["read"]);
    expect(summary?.approval).toBe(true);
    const frame = nodeFrame(summary!);
    expect(frame.exposed).toEqual(["read"]);
    expect(frame.approval).toBe(true);
  });

  test("null removes the narrowing, false lets the machine run unasked", async () => {
    const { nodeId } = await pairNode();
    await setNodeAccessForApp(nodeId, { tools: ["read"], approval: true });
    await setNodeAccessForApp(nodeId, { tools: null, approval: false });
    const summary = (await nodeSummaries())[0];
    expect(summary?.exposed).toBeUndefined();
    expect(summary?.approval).toBeUndefined();
    expect(nodeRecord(nodeId)?.tools).toBeUndefined();
    expect(nodeRecord(nodeId)?.approval).toBe(false);
  });

  test("an empty list is a decision: nothing exposed", async () => {
    const { nodeId } = await pairNode();
    expect(await setNodeAccessForApp(nodeId, { tools: [] })).toEqual({ ok: true });
    expect(nodeRecord(nodeId)?.tools).toEqual([]);
  });

  test("an unknown node is refused", async () => {
    expect(await setNodeAccessForApp("nope", { approval: true })).toEqual({ ok: false, error: "unknown node" });
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

  test("rename answers the new agent name and mirrors the roster", async () => {
    const { nodeId } = await pairNode();
    const app = fakeAppSocket();
    const other = fakeAppSocket();
    await handleNodesRename(deps({ sockets: [app, other] }), app.ws, { nodeId, name: "prod web" });
    expect(app.frames[0]).toMatchObject({ type: "nodes.rename.result", ok: true, nodeId, name: "prod web", agent: "node-prod-web" });
    const mirror = other.frames[0] as { type: string; nodes: Array<{ name: string; agent: string }> };
    expect(mirror.type).toBe("nodes.list.result");
    expect(mirror.nodes[0]).toMatchObject({ name: "prod web", agent: "node-prod-web" });
  });

  test("a refused rename says why and changes nothing", async () => {
    await pairNode("web01");
    const second = await pairNode("web02");
    const app = fakeAppSocket();
    await handleNodesRename(deps(), app.ws, { nodeId: second.nodeId, name: "web01" });
    expect(app.frames[0]).toMatchObject({ type: "nodes.rename.result", ok: false, error: 'a node named "web01" already exists' });
    expect(nodeRecord(second.nodeId)?.name).toBe("web02");
  });

  test("describe writes the line and mirrors", async () => {
    const { nodeId } = await pairNode();
    const app = fakeAppSocket();
    await handleNodesDescribe(deps(), app.ws, { nodeId, description: "Build box" });
    expect(app.frames[0]).toMatchObject({ type: "nodes.describe.result", ok: true, nodeId });
    expect((await nodeSummaries())[0]?.description).toBe("Build box");
  });

  test("access.set takes the subset and the flag, refusing what is not there", async () => {
    const { nodeId } = await pairNode();
    const app = fakeAppSocket();
    await handleNodesAccessSet(deps(), app.ws, { nodeId, tools: ["read", 42, "read"], approval: false });
    expect(app.frames[0]).toMatchObject({ type: "nodes.access.set.result", ok: true, nodeId });
    expect(nodeRecord(nodeId)?.tools).toEqual(["read"]);
    expect(nodeRecord(nodeId)?.approval).toBe(false);
    const refused = fakeAppSocket();
    await handleNodesAccessSet(deps(), refused.ws, { nodeId: "nope", approval: true });
    expect(refused.frames[0]).toMatchObject({ type: "nodes.access.set.result", ok: false, error: "unknown node" });
  });
});

describe("node disabled", () => {
  test("the flag is stored, and read back on the summary and the frame", async () => {
    const { nodeId } = await pairNode();
    expect(await setNodeAccessForApp(nodeId, { disabled: true })).toEqual({ ok: true });
    const summary = (await nodeSummaries())[0];
    expect(summary?.disabled).toBe(true);
    expect(nodeFrame(summary!).disabled).toBe(true);
    await setNodeAccessForApp(nodeId, { disabled: false });
    expect((await nodeSummaries())[0]?.disabled).toBeUndefined();
    expect(nodeRecord(nodeId)?.disabled).toBeUndefined();
  });

  test("the frame carries it too", async () => {
    const { nodeId } = await pairNode();
    const app = fakeAppSocket();
    await handleNodesAccessSet(deps(), app.ws, { nodeId, disabled: true });
    expect(app.frames[0]).toMatchObject({ type: "nodes.access.set.result", ok: true, nodeId });
    expect(nodeRecord(nodeId)?.disabled).toBe(true);
  });
});

describe("forcing an update", () => {
  test("an unknown node is refused", async () => {
    expect(await updateNodeForApp("nope")).toEqual({ ok: false, error: "unknown node" });
  });

  test("an offline node is refused", async () => {
    const { nodeId } = await pairNode();
    expect(await updateNodeForApp(nodeId)).toEqual({ ok: false, error: "the node is offline" });
  });

  test("a node already on the server's version is told so", async () => {
    const version = await readAppVersion();
    const minted = await mintNode({ name: "web01", facts: { ...FACTS, version } });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    const socket = fakeNodeSocket(nodeId);
    attachNodeSocket(socket.ws);
    handleNodeFrame(socket.ws, JSON.stringify({ type: "node.hello", protocol: 1, facts: { ...FACTS, version } }));
    expect(await updateNodeForApp(nodeId)).toEqual({ ok: false, error: `the node already runs ${version}` });
  });

  test("a node behind the server is offered the build, forced", async () => {
    const { nodeId } = await pairNode();
    const socket = fakeNodeSocket(nodeId);
    attachNodeSocket(socket.ws);
    handleNodeFrame(socket.ws, JSON.stringify({ type: "node.hello", protocol: 1, facts: FACTS }));
    const offered = await updateNodeForApp(nodeId);
    expect(offered.ok).toBe(true);
    // The hello offers the build best-effort, asynchronously and without force: what the owner's
    // press adds is exactly one forced offer.
    const forced = socket.sent.filter((frame) => frame["type"] === "node.update" && frame["force"] === true);
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatchObject({ version: await readAppVersion(), target: "linux-x64" });
  });

  test("the frame answers with the refusal", async () => {
    const app = fakeAppSocket();
    await handleNodesUpdate(deps(), app.ws, { nodeId: "nope" });
    expect(app.frames[0]).toMatchObject({ type: "nodes.update.result", ok: false, error: "unknown node" });
  });
});


describe("node MCP", () => {
  const GODOT = { transport: "stdio" as const, command: "godot-mcp", args: ["--headless"] };

  test("the list is stored, pushed to the machine, and mirrored", async () => {
    const { nodeId } = await pairNode();
    const socket = fakeNodeSocket(nodeId);
    attachNodeSocket(socket.ws);
    handleNodeFrame(socket.ws, JSON.stringify({ type: "node.hello", protocol: 1, facts: FACTS }));
    socket.sent.length = 0;
    const app = fakeAppSocket();
    await handleNodesMcpSet(deps(), app.ws, { nodeId, mcp: { godot: GODOT } });
    expect(app.frames[0]).toMatchObject({ type: "nodes.mcp.set.result", ok: true, nodeId });
    expect(nodeRecord(nodeId)?.mcp).toEqual({ godot: GODOT });
    expect(socket.sent.find((frame) => frame["type"] === "node.config")).toEqual({ type: "node.config", mcp: { godot: GODOT } });
  });

  test("a malformed list is refused and nothing is stored", async () => {
    const { nodeId } = await pairNode();
    const app = fakeAppSocket();
    await handleNodesMcpSet(deps(), app.ws, { nodeId, mcp: { broken: { transport: "carrier-pigeon" } } });
    expect(app.frames[0]).toMatchObject({ type: "nodes.mcp.set.result", ok: false, error: "invalid MCP list" });
    expect(nodeRecord(nodeId)?.mcp).toBeUndefined();
  });

  test("a node that was away is handed the list on its next connect", async () => {
    const { nodeId } = await pairNode();
    const app = fakeAppSocket();
    await handleNodesMcpSet(deps(), app.ws, { nodeId, mcp: { godot: GODOT } });
    const socket = fakeNodeSocket(nodeId);
    attachNodeSocket(socket.ws);
    expect(socket.sent.find((frame) => frame["type"] === "node.config")).toEqual({ type: "node.config", mcp: { godot: GODOT } });
  });

  test("the roster carries the configured servers, the reported state, and what the machine runs alone", async () => {
    const { nodeId } = await pairNode();
    await setNodeMcp(nodeId, { godot: GODOT });
    const socket = fakeNodeSocket(nodeId);
    attachNodeSocket(socket.ws);
    handleNodeFrame(socket.ws, JSON.stringify({
      type: "node.hello",
      protocol: 1,
      facts: { ...FACTS, mcp: [{ name: "godot", ok: true, tools: 3 }, { name: "local", ok: false, tools: 0, error: "no such binary" }] },
    }));
    const [summary] = await nodeSummaries();
    expect(summary?.mcp).toEqual([
      { name: "godot", transport: "stdio", target: "godot-mcp --headless", ok: true, tools: 3, config: GODOT },
      { name: "local", transport: "stdio", target: "", external: true, ok: false, tools: 0, error: "no such binary" },
    ]);
    const frame = nodeFrame(summary!);
    expect(frame.mcp?.[0]?.config).toEqual(GODOT);
  });
});
