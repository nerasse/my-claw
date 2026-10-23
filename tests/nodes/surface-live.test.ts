/**
 * The node surface over a real server: the same port as the app channel, the same credential
 * resolver for the admin routes, and a real WebSocket for the node itself.
 *
 * This is the wiring the unit tests cannot prove: the adapter delegating /node to the surface,
 * dispatching the socket's frames, and closing it on a revoke.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { MyClawAppAdapter } from "../../src/channels/my-claw-app/adapter.ts";
import { MY_CLAW_DIR, type MyClawAppChannelConfig } from "../../src/core/config.ts";
import { callNodeTool, nodeOnline, resetNodeHub } from "../../src/nodes/hub.ts";
import { nodeRecord, nodesFilePath, resetNodesStore } from "../../src/nodes/store.ts";
import { resetClaims } from "../../src/nodes/claims.ts";
import type { NodeFacts } from "../../src/nodes/types.ts";

const DEVICE_ID = "test-device";
const TOKEN = "secret-token";

const FACTS: NodeFacts = {
  os: "linux",
  arch: "x64",
  hostname: "web01",
  user: "neras",
  mode: "user",
  version: "0.1.0",
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
};

const config: MyClawAppChannelConfig = {
  port: 0,
  devices: { [DEVICE_ID]: { token: TOKEN, name: "test phone" } },
  streaming: { enabled: true, minChars: 1 },
};

const adminHeaders = { "X-My-Claw-Device": DEVICE_ID, Authorization: `Bearer ${TOKEN}` };

interface NodeClient {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  closed: { code: number; reason: string } | null;
  waitFor: (type: string) => Promise<Record<string, unknown>>;
}

function connectNode(port: number, token: string): Promise<NodeClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/node`, {
      headers: { Authorization: `Bearer ${token}` },
    } as never);
    const frames: Array<Record<string, unknown>> = [];
    const waiters: Array<{ type: string; resolve: (frame: Record<string, unknown>) => void }> = [];
    const client: NodeClient = {
      ws,
      frames,
      closed: null,
      waitFor: (type: string) => {
        const found = frames.find((frame) => frame["type"] === type);
        if (found) return Promise.resolve(found);
        return new Promise((res) => waiters.push({ type, resolve: res }));
      },
    };
    const timer = setTimeout(() => reject(new Error("node ws open timeout")), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(client);
    };
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      frames.push(frame);
      for (const [index, waiter] of waiters.entries()) {
        if (waiter.type !== frame["type"]) continue;
        waiters.splice(index, 1);
        waiter.resolve(frame);
        break;
      }
    };
    ws.onclose = (event) => {
      client.closed = { code: event.code, reason: event.reason };
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("node ws error"));
    };
  });
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let adapter: MyClawAppAdapter;

beforeEach(async () => {
  await resetNodesStore();
  await rm(nodesFilePath(), { force: true });
  await rm(join(MY_CLAW_DIR, "agents"), { recursive: true, force: true });
  resetClaims();
  resetNodeHub();
  adapter = new MyClawAppAdapter(config, { flushDrafts: async () => undefined, listQuotaWaits: async () => [] } as never);
  adapter.setNodesConfig(() => undefined);
  await adapter.start();
});

afterEach(async () => {
  await adapter.stop();
  resetNodeHub();
});

test("a node pairs over HTTP, runs a tool over the socket, and is closed by a revoke", async () => {
  const base = `http://127.0.0.1:${adapter.port}`;

  // A paired device mints the claim code.
  const ticket = await fetch(`${base}/node/ticket`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "web01" }) });
  expect(ticket.status).toBe(200);
  const { code } = (await ticket.json()) as { code: string };

  // The machine trades it for its token.
  const paired = await fetch(`${base}/node/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, facts: FACTS }),
  });
  expect(paired.status).toBe(200);
  const { nodeId, token } = (await paired.json()) as { nodeId: string; token: string };
  expect(nodeRecord(nodeId)?.name).toBe("web01");

  // Its socket, with its own token.
  const client = await connectNode(adapter.port, token);
  client.ws.send(JSON.stringify({ type: "node.hello", protocol: 1, facts: FACTS }));
  await until(() => nodeOnline(nodeId));

  // A tool call travels there and back.
  const pending = callNodeTool(nodeId, "read", { path: "/etc/hosts" });
  const call = await client.waitFor("node.call");
  expect(call["tool"]).toBe("read");
  client.ws.send(JSON.stringify({ type: "node.result", callId: call["callId"], ok: true, output: "hosts" }));
  expect(await pending).toEqual({ success: true, output: "hosts" });

  // A revoke closes the socket, says why, and takes the record with it.
  const revoked = await fetch(`${base}/node/revoke`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ nodeId }) });
  expect(revoked.status).toBe(200);
  await until(() => client.closed !== null);
  expect(client.closed?.code).toBe(4003);
  expect(nodeRecord(nodeId)).toBeUndefined();
  expect(nodeOnline(nodeId)).toBe(false);
});

test("the node routes refuse what they should over the wire", async () => {
  const base = `http://127.0.0.1:${adapter.port}`;

  const anonymousTicket = await fetch(`${base}/node/ticket`, { method: "POST", body: "{}" });
  expect(anonymousTicket.status).toBe(401);

  const badCode = await fetch(`${base}/node/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "ABCD2345", facts: FACTS }),
  });
  expect(badCode.status).toBe(403);

  const badToken = await fetch(`${base}/node`, { headers: { upgrade: "websocket", authorization: "Bearer nope" } });
  expect(badToken.status).toBe(401);
});
