import { describe, test, expect, beforeEach } from "bun:test";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "bun";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { createNodeSurface } from "../../src/nodes/surface.ts";
import { consumeClaim, openClaim, resetClaims } from "../../src/nodes/claims.ts";
import { findNodeByToken, nodeRecord, nodesFilePath, resetNodesStore } from "../../src/nodes/store.ts";
import { resetNodeHub, type NodeSocketData } from "../../src/nodes/hub.ts";
import type { NodeFacts } from "../../src/nodes/types.ts";

const FACTS: NodeFacts = {
  os: "linux",
  arch: "x64",
  hostname: "web01",
  user: "neras",
  mode: "admin",
  version: "0.1.0",
  tools: [{ name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } }],
};

interface UpgradeCall {
  data: NodeSocketData;
}

function fakeServer(): { server: Server<NodeSocketData>; upgrades: UpgradeCall[] } {
  const upgrades: UpgradeCall[] = [];
  const server = {
    upgrade: (_req: Request, options: { data: NodeSocketData }) => {
      upgrades.push({ data: options.data });
      return true;
    },
  };
  return { server: server as unknown as Server<NodeSocketData>, upgrades };
}

function surface(options: { admin?: boolean; clientCertHeader?: string } = {}) {
  return createNodeSurface({
    nodes: () => (options.clientCertHeader ? { clientCertHeader: options.clientCertHeader } : undefined),
    authorizeAdmin: () => options.admin === true,
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetNodesStore();
  await rm(nodesFilePath(), { force: true });
  await rm(join(MY_CLAW_DIR, "agents"), { recursive: true, force: true });
  resetClaims();
  resetNodeHub();
});

describe("node surface", () => {
  test("another path is not the surface's business", async () => {
    const reply = await surface().handle(new Request("http://local/my-claw-app"), fakeServer().server, {});
    expect(reply).toBeNull();
  });

  test("an unknown /node subpath answers 404", async () => {
    const reply = await surface().handle(new Request("http://local/node/nope"), fakeServer().server, {});
    expect(reply?.status).toBe(404);
  });

  test("a ticket needs a paired device", async () => {
    const unauthorized = await surface({ admin: false }).handle(post("/node/ticket", {}), fakeServer().server, {});
    expect(unauthorized?.status).toBe(401);

    const authorized = await surface({ admin: true }).handle(post("/node/ticket", { name: "web01" }), fakeServer().server, {});
    expect(authorized?.status).toBe(200);
    const body = (await authorized!.json()) as { code: string };
    expect(body.code).toMatch(/^[0-9A-Z]{8}$/);
  });

  test("a code trades for a token, writes the record and the agent, and dies with the exchange", async () => {
    const opened = openClaim({ name: "web01" });
    if (!opened.ok) throw new Error("open failed");
    const { server } = fakeServer();

    const reply = await surface().handle(post("/node/pair", { code: opened.code, facts: FACTS }), server, { ip: "10.0.0.9" });
    expect(reply?.status).toBe(200);
    const body = (await reply!.json()) as { nodeId: string; name: string; token: string };
    expect(body.name).toBe("web01");
    expect(findNodeByToken(body.token)?.nodeId).toBe(body.nodeId);

    // The agent file is there, and the code cannot be replayed.
    await access(join(MY_CLAW_DIR, "agents", "node-web01.md"));
    const replay = await surface().handle(post("/node/pair", { code: opened.code, facts: FACTS }), server, { ip: "10.0.0.9" });
    expect(replay?.status).toBe(403);
  });

  test("the hostname names the node when the claim carried none", async () => {
    const opened = openClaim({});
    if (!opened.ok) throw new Error("open failed");
    const reply = await surface().handle(post("/node/pair", { code: opened.code, facts: FACTS }), fakeServer().server, {});
    const body = (await reply!.json()) as { name: string };
    expect(body.name).toBe("web01");
  });

  test("a bad code, bad facts and a taken name each answer their own status", async () => {
    const { server } = fakeServer();
    const unknown = await surface().handle(post("/node/pair", { code: "ABCD2345", facts: FACTS }), server, {});
    expect(unknown?.status).toBe(403);

    const opened = openClaim({});
    if (!opened.ok) throw new Error("open failed");
    const badFacts = await surface().handle(post("/node/pair", { code: opened.code, facts: { os: "linux" } }), server, {});
    expect(badFacts?.status).toBe(400);
    // The code was not burned by the malformed attempt.
    expect(consumeClaim(opened.code).ok).toBe(true);

    const taken = openClaim({ name: "web01" });
    if (!taken.ok) throw new Error("open failed");
    await surface().handle(post("/node/pair", { code: taken.code, facts: FACTS }), server, {});
    const clash = openClaim({ name: "web01" });
    if (!clash.ok) throw new Error("open failed");
    const refused = await surface().handle(post("/node/pair", { code: clash.code, facts: FACTS }), server, {});
    expect(refused?.status).toBe(409);
  });

  test("an upgrade needs the node token", async () => {
    const opened = openClaim({ name: "web01" });
    if (!opened.ok) throw new Error("open failed");
    const { server, upgrades } = fakeServer();
    const paired = await surface().handle(post("/node/pair", { code: opened.code, facts: FACTS }), server, {});
    const { nodeId, token } = (await paired!.json()) as { nodeId: string; token: string };

    const anonymous = await surface().handle(new Request("http://local/node", { headers: { upgrade: "websocket" } }), server, {});
    expect(anonymous?.status).toBe(401);

    const good = new Request("http://local/node", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });
    const upgraded = await surface().handle(good, server, {});
    expect(upgraded).toBeUndefined();
    expect(upgrades[0]?.data).toEqual({ node: true, nodeId, lastSeen: expect.any(Number) });
  });

  test("a configured client-cert header is a second gate on /node only", async () => {
    const opened = openClaim({ name: "web01" });
    if (!opened.ok) throw new Error("open failed");
    const { server } = fakeServer();
    const paired = await surface({ clientCertHeader: "X-SSL-Client-Verify" }).handle(post("/node/pair", { code: opened.code, facts: FACTS }), server, {});
    const { token } = (await paired!.json()) as { token: string };

    const missing = await surface({ clientCertHeader: "X-SSL-Client-Verify" }).handle(
      new Request("http://local/node", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } }),
      server,
      {},
    );
    expect(missing?.status).toBe(403);

    const wrong = await surface({ clientCertHeader: "X-SSL-Client-Verify" }).handle(
      new Request("http://local/node", {
        headers: { upgrade: "websocket", authorization: `Bearer ${token}`, "X-SSL-Client-Verify": "NONE" },
      }),
      server,
      {},
    );
    expect(wrong?.status).toBe(403);

    const verified = await surface({ clientCertHeader: "X-SSL-Client-Verify" }).handle(
      new Request("http://local/node", {
        headers: { upgrade: "websocket", authorization: `Bearer ${token}`, "X-SSL-Client-Verify": "SUCCESS" },
      }),
      server,
      {},
    );
    expect(verified).toBeUndefined();
  });

  test("a revoke removes the node and its agent file, and needs a device", async () => {
    const opened = openClaim({ name: "web01" });
    if (!opened.ok) throw new Error("open failed");
    const { server } = fakeServer();
    const paired = await surface().handle(post("/node/pair", { code: opened.code, facts: FACTS }), server, {});
    const { nodeId } = (await paired!.json()) as { nodeId: string };

    const unauthorized = await surface({ admin: false }).handle(post("/node/revoke", { nodeId }), server, {});
    expect(unauthorized?.status).toBe(401);

    const revoked = await surface({ admin: true }).handle(post("/node/revoke", { nodeId }), server, {});
    expect(revoked?.status).toBe(200);
    expect(nodeRecord(nodeId)).toBeUndefined();
    await expect(access(join(MY_CLAW_DIR, "agents", "node-web01.md"))).rejects.toBeDefined();

    const again = await surface({ admin: true }).handle(post("/node/revoke", { nodeId }), server, {});
    expect(again?.status).toBe(404);
  });
});
