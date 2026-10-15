/**
 * The whole join, end to end and in one process: the server mints a claim, the client pairs over
 * HTTP, dials its socket, runs a tool the server asked for, survives the server restarting, and
 * leaves for good when it is revoked.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MyClawAppAdapter } from "../../src/channels/my-claw-app/adapter.ts";
import type { MyClawAppChannelConfig } from "../../src/core/config.ts";
import { openClaim, resetClaims } from "../../src/nodes/claims.ts";
import { callNodeTool, nodeOnline, resetNodeHub } from "../../src/nodes/hub.ts";
import { nodesFilePath, resetNodesStore } from "../../src/nodes/store.ts";
import { loadConfig, loadToken, type NodeClientConfig } from "../../src/node-client/config.ts";
import { NodeRevokedError, runNode } from "../../src/node-client/connection.ts";
import { pairNode } from "../../src/node-client/pair.ts";

const DEVICE_ID = "test-device";
const TOKEN = "secret-token";
const adminHeaders = { "X-My-Claw-Device": DEVICE_ID, Authorization: `Bearer ${TOKEN}` };

function channelConfig(port = 0): MyClawAppChannelConfig {
  return {
    port,
    devices: { [DEVICE_ID]: { token: TOKEN, name: "test phone" } },
    streaming: { enabled: true, minChars: 1 },
  };
}

async function until(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Bun's fetch pools connections; a pooled one to a server that just restarted answers ECONNRESET
 * once. The real client (device-cli) retries the same way.
 */
async function postEventually(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError;
}

let adapter: MyClawAppAdapter;
let dir: string;

beforeEach(async () => {
  await rm(nodesFilePath(), { force: true });
  resetNodesStore();
  resetClaims();
  resetNodeHub();
  dir = await mkdtemp(join(tmpdir(), "node-client-e2e-"));
  adapter = new MyClawAppAdapter(channelConfig(), { flushDrafts: async () => undefined } as never);
  adapter.setNodesConfig(() => undefined);
  await adapter.start();
});

afterEach(async () => {
  await adapter.stop();
  resetNodeHub();
  await rm(dir, { recursive: true, force: true });
});

async function paired(dirPath: string): Promise<{ nodeId: string; config: NodeClientConfig; token: string }> {
  const claim = openClaim({ name: "e2e-node" });
  if (!claim.ok) throw new Error("open claim failed");
  const server = `ws://127.0.0.1:${adapter.port}/node`;
  const pairedNode = await pairNode({ server, code: claim.code, dir: dirPath, workdir: dirPath });
  const config = await loadConfig(dirPath);
  const token = await loadToken(dirPath);
  if (!config || !token) throw new Error("pairing stored nothing");
  return { nodeId: pairedNode.nodeId, config, token };
}

test("a node pairs, serves a tool call, reconnects after a restart, and is stopped by a revoke", async () => {
  const node = await paired(dir);
  const logs: string[] = [];
  const controller = new AbortController();
  // The rejection must be handled from the start: bun fails a test on a rejection that is
  // momentarily unhandled, and the revoke lands before the assertion below.
  let runError: unknown;
  const runDone = runNode({
    config: node.config,
    token: node.token,
    log: (level, message) => logs.push(`${level}:${message}`),
    signal: controller.signal,
    backoff: { initialMs: 50, maxMs: 200 },
  }).catch((err: unknown) => {
    runError = err;
  });

  await until(() => nodeOnline(node.nodeId));

  // A tool call the server issued runs on this machine and comes back.
  const result = await callNodeTool(node.nodeId, "bash", { command: "echo from-the-node" });
  expect(result.success).toBe(true);
  expect(result.output).toContain("from-the-node");

  // A second call proves the connection stays up between calls.
  const second = await callNodeTool(node.nodeId, "write", { path: join(dir, "written.txt"), content: "hi" });
  expect(second.success).toBe(true);

  // The server restarts: the socket drops, the client comes back on its own.
  const port = adapter.port;
  await adapter.stop();
  await until(() => !nodeOnline(node.nodeId));
  adapter = new MyClawAppAdapter(channelConfig(port), { flushDrafts: async () => undefined } as never);
  adapter.setNodesConfig(() => undefined);
  await adapter.start();
  await until(() => nodeOnline(node.nodeId));
  const afterRestart = await callNodeTool(node.nodeId, "read", { path: join(dir, "written.txt") });
  expect(afterRestart).toEqual({ success: true, output: "hi" });

  // Revocation: the server closes with its own code, and the client stops for good.
  const revoked = await postEventually(`http://127.0.0.1:${port}/node/revoke`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ nodeId: node.nodeId }),
  });
  expect(revoked.status).toBe(200);
  await runDone;
  expect(runError).toBeInstanceOf(NodeRevokedError);
  expect(nodeOnline(node.nodeId)).toBe(false);
});

test("a node whose call outlives the socket is cancelled, and pairing refuses a bad code", async () => {
  const node = await paired(dir);
  const controller = new AbortController();
  let runError: unknown;
  const runDone = runNode({
    config: node.config,
    token: node.token,
    log: () => undefined,
    signal: controller.signal,
    backoff: { initialMs: 50, maxMs: 200 },
  }).catch((err: unknown) => {
    runError = err;
  });
  await until(() => nodeOnline(node.nodeId));

  // A long call in flight, then the server restarts under it: the client aborts it.
  const pending = callNodeTool(node.nodeId, "bash", { command: "sleep 20", timeoutMs: 60_000 });
  const port = adapter.port;
  await adapter.stop();
  const result = await pending;
  expect(result.success).toBe(false);

  adapter = new MyClawAppAdapter(channelConfig(port), { flushDrafts: async () => undefined } as never);
  adapter.setNodesConfig(() => undefined);
  await adapter.start();
  await until(() => nodeOnline(node.nodeId));

  controller.abort();
  await runDone;
  expect(runError).toBeUndefined();

  const refused = await pairNode({ server: `ws://127.0.0.1:${port}/node`, code: "ABCD2345", dir }).catch((err: Error) => err.message);
  expect(String(refused)).toContain("not known");
});
