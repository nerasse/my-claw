import { describe, test, expect, beforeEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import { attachNodeSocket, handleNodeFrame, resetNodeHub, type NodeSocketData } from "../../src/nodes/hub.ts";
import { nodeToolNamesFor, nodeToolsFor } from "../../src/nodes/tools.ts";
import { mintNode, resetNodesStore, nodesFilePath, setNodeAccess } from "../../src/nodes/store.ts";
import { storeNodeUpload } from "../../src/nodes/files.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { join } from "node:path";
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
    // The machine's manifest, then the one tool this server adds for sending it files.
    expect(tools?.map((t) => t.name)).toEqual(["read", "bash", "send_file_to_node"]);
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
    expect(nodeToolsFor(nodeId, { disabled: ["bash"] })?.map((t) => t.name)).toEqual(["read", "send_file_to_node"]);
    expect(nodeToolsFor(nodeId, { allow: ["read", "bash"], disabled: ["bash"] })?.map((t) => t.name)).toEqual(["read"]);
  });

  test("the record's subset narrows the manifest, under the file's own allow", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    connect(nodeId);

    await setNodeAccess(nodeId, { tools: ["read"] });
    expect(nodeToolsFor(nodeId)?.map((t) => t.name)).toEqual(["read", "send_file_to_node"]);
    // An empty list is a decision: nothing runs there.
    await setNodeAccess(nodeId, { tools: [] });
    expect(nodeToolsFor(nodeId)?.map((t) => t.name)).toEqual(["send_file_to_node"]);
    // A name the machine does not offer is never matched: the machine stays the ceiling.
    await setNodeAccess(nodeId, { tools: ["read", "write"] });
    expect(nodeToolsFor(nodeId)?.map((t) => t.name)).toEqual(["read", "send_file_to_node"]);
    await setNodeAccess(nodeId, { tools: null });
    expect(nodeToolsFor(nodeId)?.map((t) => t.name)).toEqual(["read", "bash", "send_file_to_node"]);
  });

  test("every tool of a paired machine asks first, until the owner lets it run unasked", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    connect(nodeId);

    expect(nodeToolsFor(nodeId)?.every((t) => t.requiresApproval === true)).toBe(true);
    await setNodeAccess(nodeId, { approval: false });
    expect(nodeToolsFor(nodeId)?.every((t) => t.requiresApproval === false)).toBe(true);
    await setNodeAccess(nodeId, { approval: true });
    expect(nodeToolsFor(nodeId)?.every((t) => t.requiresApproval === true)).toBe(true);
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

describe("node tools follow the app's settings on the next call, not the next run", () => {
  test("the approval flag is read again at every call", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    connect(nodeId);
    const tool = nodeToolsFor(nodeId)?.find((t) => t.name === "read");
    expect(tool?.requiresApproval).toBe(true);
    await setNodeAccess(nodeId, { approval: false });
    expect(tool?.requiresApproval).toBe(false);
    await setNodeAccess(nodeId, { approval: true });
    expect(tool?.requiresApproval).toBe(true);
  });

  test("a tool taken off the exposed list refuses its call without reaching the machine", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    const { sent } = connect(nodeId);
    const tool = nodeToolsFor(nodeId)?.find((t) => t.name === "read");
    await setNodeAccess(nodeId, { tools: [] });
    const result = await tool!.execute({ path: "/etc/hosts" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("no longer exposed");
    expect(sent.filter((frame) => frame["type"] === "node.call")).toHaveLength(0);
  });

  test("switching the node off refuses its calls, and back on lets them through", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    connect(nodeId);
    const tool = nodeToolsFor(nodeId)?.find((t) => t.name === "read");
    await setNodeAccess(nodeId, { disabled: true });
    const refused = await tool!.execute({ path: "/etc/hosts" });
    expect(refused.error).toContain("switched off");
    await setNodeAccess(nodeId, { disabled: false });
    const back = tool!.execute({ path: "/etc/hosts" });
    // It reaches the machine again: the call frame leaves with the call id the answer needs.
    await new Promise((resolve) => setTimeout(resolve, 20));
    back.catch(() => undefined);
    expect(nodeToolsFor(nodeId)?.some((t) => t.name === "read")).toBe(true);
  });
});

describe("files between this server and a node", () => {
  test("an attachment a node names is kept only when it is that node's own upload", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    const { ws, sent } = connect(nodeId);
    const upload = await storeNodeUpload(nodeId, "shot.png", new Uint8Array([137, 80, 78, 71]));

    const pending = nodeToolsFor(nodeId)!.find((tool) => tool.name === "read")!.execute({ path: "/tmp/shot.png" });
    const call = sent.find((frame) => frame["type"] === "node.call");
    handleNodeFrame(ws, JSON.stringify({
      type: "node.result",
      callId: call!["callId"],
      ok: true,
      output: "image attached",
      attachments: [
        { type: "image", path: upload.path, filename: "shot.png" },
        // A machine may name any path it likes; this one is not an upload and must not reach a prompt.
        { type: "file", path: "/home/neras/.my-claw/config.json" },
      ],
    }));
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.attachments).toEqual([{ type: "image", path: upload.path, filename: "shot.png" }]);
  });

  test("send_file_to_node hands a file of this server to the machine", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    const { ws, sent } = connect(nodeId);
    const file = join(MY_CLAW_DIR, "texture.png");
    await Bun.write(file, new Uint8Array([1, 2, 3]));

    const tool = nodeToolsFor(nodeId)!.find((candidate) => candidate.name === "send_file_to_node");
    expect(tool).toBeDefined();
    const pending = tool!.execute({ path: file });
    // The tool checks the file exists first, so the frame lands a tick later.
    const started = Date.now();
    while (!sent.some((frame) => frame["type"] === "node.put")) {
      if (Date.now() - started > 2000) throw new Error("no node.put frame was sent");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const put = sent.find((frame) => frame["type"] === "node.put");
    expect(put?.["path"]).toBe("texture.png");
    expect(String(put?.["url"])).toStartWith("/node/file/");
    handleNodeFrame(ws, JSON.stringify({ type: "node.put.result", callId: put!["callId"], ok: true, path: "/srv/game/texture.png" }));
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.output).toContain("/srv/game/texture.png");
  });

  test("send_file_to_node refuses a path that is not a file", async () => {
    const minted = await mintNode({ name: "web01", facts: FACTS });
    if (!minted.ok) throw new Error("mint failed");
    const nodeId = minted.minted.record.nodeId;
    connect(nodeId);
    const tool = nodeToolsFor(nodeId)!.find((candidate) => candidate.name === "send_file_to_node");
    const result = await tool!.execute({ path: join(MY_CLAW_DIR, "nope.png") });
    expect(result.success).toBe(false);
    expect(result.error).toContain("no file at");
  });
});
