/**
 * The Nodes page over a real server: a paired device drives pairing and revocation from the app
 * socket, exactly as the settings screen does. This is the wiring the handler tests cannot prove:
 * the adapter dispatching nodes.* frames, the claim travelling to a real /node/pair, and a revoke
 * closing the node's socket from the app.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { MyClawAppAdapter } from "../../src/channels/my-claw-app/adapter.ts";
import { MY_CLAW_DIR, type MyClawAppChannelConfig } from "../../src/core/config.ts";
import { resetClaims } from "../../src/nodes/claims.ts";
import { nodeOnline, resetNodeHub } from "../../src/nodes/hub.ts";
import { nodeRecord, nodesFilePath, resetNodesStore } from "../../src/nodes/store.ts";
import type { NodeFacts } from "../../src/nodes/types.ts";

const DEVICE_ID = "test-device";
const TOKEN = "secret-token";

const FACTS: NodeFacts = {
  os: "linux",
  arch: "x64",
  hostname: "web01",
  user: "neras",
  mode: "admin",
  version: "0.1.0",
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
};

const config: MyClawAppChannelConfig = {
  port: 0,
  devices: { [DEVICE_ID]: { token: TOKEN, name: "test phone" } },
};

const deviceHeaders = { "X-My-Claw-Device": DEVICE_ID, Authorization: `Bearer ${TOKEN}` };

interface Client {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  closed: { code: number; reason: string } | null;
  waitFor: (type: string) => Promise<Record<string, unknown>>;
  /** The next frame of that type, ignoring the ones already received. */
  next: (type: string) => Promise<Record<string, unknown>>;
}

function connect(port: number, path: string, headers: Record<string, string>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers } as never);
    const frames: Array<Record<string, unknown>> = [];
    const waiters: Array<{ type: string; from: number; resolve: (frame: Record<string, unknown>) => void }> = [];
    const client: Client = {
      ws,
      frames,
      closed: null,
      waitFor: (type: string) => {
        const found = frames.find((frame) => frame["type"] === type);
        if (found) return Promise.resolve(found);
        return new Promise((res) => waiters.push({ type, from: 0, resolve: res }));
      },
      next: (type: string) => {
        const from = frames.length;
        const found = frames.slice(from).find((frame) => frame["type"] === type);
        if (found) return Promise.resolve(found);
        return new Promise((res) => waiters.push({ type, from, resolve: res }));
      },
    };
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(client);
    };
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      frames.push(frame);
      for (const [index, waiter] of waiters.entries()) {
        if (waiter.type !== frame["type"] || frames.length - 1 < waiter.from) continue;
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
      reject(new Error("ws error"));
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
  adapter = new MyClawAppAdapter(config, { flushDrafts: async () => undefined } as never);
  adapter.setNodesConfig(() => undefined);
  await adapter.start();
});

afterEach(async () => {
  await adapter.stop();
  resetNodeHub();
});

test("the app pairs a node, lists it online, and revokes it", async () => {
  const app = await connect(adapter.port, "/my-claw-app", deviceHeaders);

  // An empty roster first: what the page shows before anything is paired.
  app.ws.send(JSON.stringify({ type: "nodes.list" }));
  const empty = await app.waitFor("nodes.list.result");
  expect(empty["nodes"]).toEqual([]);

  // A code, minted from the app, claimed by the machine over the real HTTP route.
  app.ws.send(JSON.stringify({ type: "nodes.add", name: "build box" }));
  const added = await app.next("nodes.add.result");
  expect(added["ok"]).toBe(true);
  const code = String(added["code"]);
  const paired = await fetch(`http://127.0.0.1:${adapter.port}/node/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, facts: FACTS }),
  });
  expect(paired.status).toBe(200);
  const { nodeId, token } = (await paired.json()) as { nodeId: string; token: string };

  // The row the page draws: the name the app typed, the facts the machine announced, its agent.
  app.ws.send(JSON.stringify({ type: "nodes.list" }));
  const listed = await app.next("nodes.list.result");
  const nodes = listed["nodes"] as Array<Record<string, unknown>>;
  expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({
    nodeId,
    name: "build box",
    online: false,
    os: "linux",
    mode: "admin",
    version: "0.1.0",
    tools: ["read"],
    agent: "node-build-box",
  });
  await access(join(MY_CLAW_DIR, "agents", "node-build-box.md"));

  // Connected: the same row reads online, from the live socket.
  const node = await connect(adapter.port, "/node", { Authorization: `Bearer ${token}` });
  node.ws.send(JSON.stringify({ type: "node.hello", protocol: 1, facts: FACTS }));
  await until(() => nodeOnline(nodeId));
  app.ws.send(JSON.stringify({ type: "nodes.list" }));
  const online = await app.next("nodes.list.result");
  expect((online["nodes"] as Array<Record<string, unknown>>)[0]?.["online"]).toBe(true);

  // Revoking from the app closes the node's socket, drops the record and takes the agent.
  app.ws.send(JSON.stringify({ type: "nodes.revoke", nodeId }));
  const revoked = await app.next("nodes.revoke.result");
  expect(revoked).toMatchObject({ ok: true, nodeId });
  await until(() => node.closed !== null);
  expect(nodeRecord(nodeId)).toBeUndefined();
  expect(nodeOnline(nodeId)).toBe(false);
  await rm(join(MY_CLAW_DIR, "agents", "node-build-box.md"), { force: true });
});

test("a revocation from one window refreshes the owner's other one", async () => {
  const first = await connect(adapter.port, "/my-claw-app", deviceHeaders);
  const second = await connect(adapter.port, "/my-claw-app", deviceHeaders);

  first.ws.send(JSON.stringify({ type: "nodes.add" }));
  const added = await first.next("nodes.add.result");
  const paired = await fetch(`http://127.0.0.1:${adapter.port}/node/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: added["code"], facts: FACTS }),
  });
  const { nodeId } = (await paired.json()) as { nodeId: string };
  second.ws.send(JSON.stringify({ type: "nodes.list" }));
  await second.waitFor("nodes.list.result");

  first.ws.send(JSON.stringify({ type: "nodes.revoke", nodeId }));
  await first.next("nodes.revoke.result");
  await until(() => (second.frames.filter((frame) => frame["type"] === "nodes.list.result").length >= 2));
  const refreshed = second.frames.filter((frame) => frame["type"] === "nodes.list.result").at(-1)!;
  expect(refreshed["nodes"]).toEqual([]);
});
