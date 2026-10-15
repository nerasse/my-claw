import { describe, test, expect, beforeEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  attachNodeSocket,
  callNodeTool,
  closeNodeSocket,
  detachNodeSocket,
  handleNodeFrame,
  nodeFactsOf,
  nodeOnline,
  offerNodeUpdate,
  resetNodeHub,
  type NodeSocketData,
} from "../../src/nodes/hub.ts";
import { nodeTargetFor, type NodeFacts } from "../../src/nodes/types.ts";
import { readAppVersion } from "../../src/core/diagnostics.ts";

const FACTS: NodeFacts = {
  os: "linux",
  arch: "x64",
  hostname: "web01",
  user: "neras",
  mode: "user",
  version: "0.1.0",
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
};

interface FakeSocket {
  ws: ServerWebSocket<NodeSocketData>;
  sent: Array<Record<string, unknown>>;
  closes: Array<{ code?: number; reason?: string }>;
}

function fakeSocket(nodeId: string): FakeSocket {
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

function hello(socket: FakeSocket, facts: NodeFacts = FACTS, protocol = 1): void {
  handleNodeFrame(socket.ws, JSON.stringify({ type: "node.hello", protocol, facts }));
}

/** Answers the first `node.call` frame the socket received, and returns it. */
function answerCall(socket: FakeSocket, output: string, ok = true): Record<string, unknown> {
  const call = socket.sent.find((frame) => frame["type"] === "node.call");
  if (!call) throw new Error("no node.call frame was sent");
  handleNodeFrame(
    socket.ws,
    JSON.stringify({ type: "node.result", callId: call["callId"], ok, output, ...(ok ? {} : { error: output }) }),
  );
  return call;
}

beforeEach(() => {
  resetNodeHub();
});

describe("node hub", () => {
  test("a hello announces the node and its manifest", () => {
    const socket = fakeSocket("node-1");
    attachNodeSocket(socket.ws);
    expect(nodeOnline("node-1")).toBe(true);
    expect(nodeFactsOf("node-1")).toBeUndefined();

    hello(socket);
    expect(nodeFactsOf("node-1")?.tools.map((t) => t.name)).toEqual(["read"]);
  });

  test("a hello of the wrong protocol or with malformed facts closes the socket", () => {
    const socket = fakeSocket("node-1");
    attachNodeSocket(socket.ws);
    hello(socket, FACTS, 99);
    expect(socket.closes[0]?.code).toBe(4002);

    const other = fakeSocket("node-2");
    attachNodeSocket(other.ws);
    handleNodeFrame(other.ws, JSON.stringify({ type: "node.hello", protocol: 1, facts: { os: "linux" } }));
    expect(other.closes[0]?.code).toBe(4001);
  });

  test("a tool call round-trips, with the bridge's private args stripped", async () => {
    const socket = fakeSocket("node-1");
    attachNodeSocket(socket.ws);
    hello(socket);

    const pending = callNodeTool("node-1", "read", { path: "/etc/hosts", __signal: undefined, __message: { secret: true } });
    const call = answerCall(socket, "127.0.0.1 localhost");
    expect(call["tool"]).toBe("read");
    expect(call["args"]).toEqual({ path: "/etc/hosts" });

    const result = await pending;
    expect(result).toEqual({ success: true, output: "127.0.0.1 localhost" });
  });

  test("a failing result keeps its error", async () => {
    const socket = fakeSocket("node-1");
    attachNodeSocket(socket.ws);
    hello(socket);
    const pending = callNodeTool("node-1", "read", { path: "/nope" });
    answerCall(socket, "ENOENT: no such file", false);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toBe("ENOENT: no such file");
  });

  test("a call to a node that is not connected answers at once", async () => {
    const result = await callNodeTool("node-gone", "read", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("not connected");
  });

  test("a disconnect fails whatever was pending", async () => {
    const socket = fakeSocket("node-1");
    attachNodeSocket(socket.ws);
    hello(socket);
    const pending = callNodeTool("node-1", "read", {});
    detachNodeSocket(socket.ws);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("disconnected");
    expect(nodeOnline("node-1")).toBe(false);
  });

  test("a silent node times out", async () => {
    const socket = fakeSocket("node-1");
    attachNodeSocket(socket.ws);
    hello(socket);
    const result = await callNodeTool("node-1", "bash", { command: "sleep 999" }, { timeoutMs: 20 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("did not answer");
  });

  test("an abort sends node.cancel and answers cancelled", async () => {
    const socket = fakeSocket("node-1");
    attachNodeSocket(socket.ws);
    hello(socket);
    const controller = new AbortController();
    const pending = callNodeTool("node-1", "bash", { command: "sleep 999" }, { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toBe("cancelled");
    expect(socket.sent.some((frame) => frame["type"] === "node.cancel")).toBe(true);
  });

  test("an already-aborted signal never reaches the wire", async () => {
    const socket = fakeSocket("node-1");
    attachNodeSocket(socket.ws);
    hello(socket);
    const controller = new AbortController();
    controller.abort();
    const result = await callNodeTool("node-1", "bash", { command: "true" }, { signal: controller.signal });
    expect(result.error).toBe("cancelled");
    expect(socket.sent.some((frame) => frame["type"] === "node.call")).toBe(false);
  });

  test("a reconnect replaces the old socket and fails its calls", async () => {
    const first = fakeSocket("node-1");
    attachNodeSocket(first.ws);
    hello(first);
    const pending = callNodeTool("node-1", "read", {});

    const second = fakeSocket("node-1");
    attachNodeSocket(second.ws);
    expect(first.closes[0]?.code).toBe(4000);
    expect((await pending).error).toContain("reconnected");

    // The answer now goes to the live socket only.
    hello(second);
    const next = callNodeTool("node-1", "read", {});
    answerCall(second, "ok");
    expect((await next).success).toBe(true);
  });

  test("a revoke tells the node why and drops it", () => {
    const socket = fakeSocket("node-1");
    attachNodeSocket(socket.ws);
    hello(socket);
    expect(closeNodeSocket("node-1", "revoked")).toBe(true);
    expect(socket.sent.some((frame) => frame["type"] === "node.bye" && frame["reason"] === "revoked")).toBe(true);
    expect(socket.closes[0]?.code).toBe(4003);
    expect(nodeOnline("node-1")).toBe(false);
    expect(closeNodeSocket("node-1", "revoked")).toBe(false);
  });

  test("frames from a socket that is not the node's are ignored", () => {
    const current = fakeSocket("node-1");
    attachNodeSocket(current.ws);
    const stale = fakeSocket("node-1");
    hello(stale, { ...FACTS, hostname: "impostor" });
    expect(nodeFactsOf("node-1")).toBeUndefined();
  });
});

describe("the update offer", () => {
  test("the target follows the machine's facts, and refuses what nothing is built for", () => {
    expect(nodeTargetFor("linux", "x64")).toBe("linux-x64");
    expect(nodeTargetFor("linux", "arm64")).toBe("linux-arm64");
    expect(nodeTargetFor("darwin", "arm64")).toBe("darwin-arm64");
    expect(nodeTargetFor("win32", "x64")).toBe("windows-x64");
    expect(nodeTargetFor("win32", "arm64")).toBeNull();
    expect(nodeTargetFor("freebsd", "x64")).toBeNull();
    expect(nodeTargetFor("linux", "riscv64")).toBeNull();
  });

  test("a node of another version is offered the one this server runs", async () => {
    const serverVersion = await readAppVersion();
    const socket = fakeSocket("node-1");
    attachNodeSocket(socket.ws);
    await offerNodeUpdate(socket.ws, "node-1", { ...FACTS, version: "0.0.1" });
    const frame = socket.sent.find((f) => f["type"] === "node.update");
    expect(frame?.["version"]).toBe(serverVersion);
    expect(frame?.["target"]).toBe("linux-x64");
  });

  test("an aligned node, a dev version and an unknown platform are left alone", async () => {
    const serverVersion = await readAppVersion();
    const aligned = fakeSocket("node-1");
    await offerNodeUpdate(aligned.ws, "node-1", { ...FACTS, version: serverVersion });
    expect(aligned.sent).toEqual([]);

    const dev = fakeSocket("node-1");
    await offerNodeUpdate(dev.ws, "node-1", { ...FACTS, version: "dev" });
    expect(dev.sent).toEqual([]);

    const exotic = fakeSocket("node-1");
    await offerNodeUpdate(exotic.ws, "node-1", { ...FACTS, version: "0.0.1", os: "freebsd" });
    expect(exotic.sent).toEqual([]);
  });

  test("a hello wires the offer, after the facts are stored", async () => {
    await readAppVersion();
    const socket = fakeSocket("node-1");
    attachNodeSocket(socket.ws);
    hello(socket, { ...FACTS, version: "0.0.1" });
    // The offer resolves through a cached promise; flush the microtasks it needs.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.sent.some((f) => f["type"] === "node.update")).toBe(true);
  });
});
