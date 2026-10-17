import { describe, test, expect, beforeEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import { attachNodeSocket, handleNodeFrame, resetNodeHub, type NodeSocketData } from "../../src/nodes/hub.ts";
import { nodeToolNamesFor, nodeToolsFor } from "../../src/nodes/tools.ts";
import { mintNode, resetNodesStore, nodesFilePath, setNodeAccess } from "../../src/nodes/store.ts";
import type { NodeFacts } from "../../src/nodes/types.ts";
import { rm } from "node:fs/promises";

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

function connect(nodeId: string): { ws: ServerWebSocket<NodeSocketData>; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    data: { node: true as const, nodeId, lastSeen: Date.now() },
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
    close: () => undefined,
  };
  const socket = ws as unknown as ServerWebSocket<NodeSocketData>;
  attachNodeSocket(socket);
  handleNodeFrame(socket, JSON.stringify({ type: "node.hello", protocol: 1, facts: FACTS }));
  return { ws: socket, sent };
}

beforeEach(async () => {
  await resetNodesStore();
  await rm(nodesFilePath(), { force: true });
  resetNodeHub();
});

describe("node tools", () => {
  test("an offline node has no tools at all", () => {
    expect(nodeToolsFor("node-none")).toBeNull();
  });

  test("the manifest becomes tools, each saying where it runs", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    connect(minted.minted.record.nodeId);

    const tools = nodeToolsFor(minted.minted.record.nodeId);
    expect(tools?.map((t) => t.name)).toEqual(["read", "bash"]);
    expect(tools?.[0]?.description).toContain("remote node \"web01\"");
    expect(tools?.[0]?.parameters).toEqual(FACTS.tools[0]!.parameters);
    expect(nodeToolNamesFor(minted.minted.record.nodeId)).toEqual(["read", "bash"]);
  });

  test("the file's tools: narrows the manifest, and a denylist applies on top", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    connect(nodeId);

    expect(nodeToolsFor(nodeId, { allow: ["read"] })?.map((t) => t.name)).toEqual(["read"]);
    expect(nodeToolsFor(nodeId, { allow: ["write"] })?.map((t) => t.name)).toEqual([]);
    expect(nodeToolsFor(nodeId, { disabled: ["bash"] })?.map((t) => t.name)).toEqual(["read"]);
    expect(nodeToolsFor(nodeId, { allow: ["read", "bash"], disabled: ["bash"] })?.map((t) => t.name)).toEqual(["read"]);
  });

  test("the record's subset narrows the manifest, under the file's own allow", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    connect(nodeId);

    await setNodeAccess(nodeId, { tools: ["read"] });
    expect(nodeToolsFor(nodeId)?.map((t) => t.name)).toEqual(["read"]);
    // An empty list is a decision: nothing runs there.
    await setNodeAccess(nodeId, { tools: [] });
    expect(nodeToolsFor(nodeId)?.map((t) => t.name)).toEqual([]);
    // A name the machine does not offer is never matched: the machine stays the ceiling.
    await setNodeAccess(nodeId, { tools: ["read", "write"] });
    expect(nodeToolsFor(nodeId)?.map((t) => t.name)).toEqual(["read"]);
    await setNodeAccess(nodeId, { tools: null });
    expect(nodeToolsFor(nodeId)?.map((t) => t.name)).toEqual(["read", "bash"]);
  });

  test("the approval flag rides every tool of the node", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    connect(nodeId);

    expect(nodeToolsFor(nodeId)?.every((t) => t.requiresApproval === undefined)).toBe(true);
    await setNodeAccess(nodeId, { approval: true });
    expect(nodeToolsFor(nodeId)?.every((t) => t.requiresApproval === true)).toBe(true);
    await setNodeAccess(nodeId, { approval: false });
    expect(nodeToolsFor(nodeId)?.every((t) => t.requiresApproval === undefined)).toBe(true);
  });

  test("executing a tool sends the call and returns the answer", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    const { ws, sent } = connect(nodeId);

    const tool = nodeToolsFor(nodeId)?.find((t) => t.name === "read");
    expect(tool).toBeDefined();
    const pending = tool!.execute({ path: "/etc/hosts" });
    const call = sent.find((frame) => frame["type"] === "node.call");
    expect(call).toBeDefined();
    handleNodeFrame(ws, JSON.stringify({ type: "node.result", callId: call!["callId"], ok: true, output: "hosts" }));
    const result = await pending;
    expect(result).toEqual({ success: true, output: "hosts" });
  });
});
