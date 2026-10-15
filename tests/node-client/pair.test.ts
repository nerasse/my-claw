/**
 * What pairing leaves on the machine: the token, and the certificate bundle when the server
 * issued one. Driven against the real surface, with fetch pointed at it.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { createNodeSurface } from "../../src/nodes/surface.ts";
import { openClaim, resetClaims } from "../../src/nodes/claims.ts";
import { nodesFilePath, resetNodesStore } from "../../src/nodes/store.ts";
import { resetNodeHub, type NodeSocketData } from "../../src/nodes/hub.ts";
import { resetNodeCa } from "../../src/nodes/ca.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { loadClientTls, loadConfig, loadToken } from "../../src/node-client/config.ts";
import { pairNode } from "../../src/node-client/pair.ts";

const SERVER = "wss://myclaw.test/node";

const fakeServer = () => ({ upgrade: () => true }) as unknown as Server<NodeSocketData>;

const surface = (mtls: boolean) =>
  createNodeSurface({ nodes: () => (mtls ? { mtls: true } : undefined), authorizeAdmin: () => true });

/** Points fetch at the surface: pairNode speaks to the server as it would over the network. */
function wire(surfaceMtls: boolean) {
  const handler = surface(surfaceMtls);
  return mockFetch(async (input, init) => {
    const request = new Request(String(input), init as RequestInit);
    const reply = await handler.handle(request, fakeServer(), {});
    if (reply === null || reply === undefined) return new Response("not found", { status: 404 });
    return reply;
  });
}

let dir: string;
const hasOpenssl = Boolean(Bun.which("openssl"));

beforeEach(async () => {
  await rm(nodesFilePath(), { force: true });
  await rm(`${MY_CLAW_DIR}/nodes/ca`, { recursive: true, force: true });
  resetNodesStore();
  resetClaims();
  resetNodeHub();
  resetNodeCa();
  dir = await mkdtemp(join(tmpdir(), "node-pair-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pairing from the client side", () => {
  test("stores the token and the config, and refuses a bad code with a readable reason", async () => {
    const claim = openClaim({ name: "web01" });
    if (!claim.ok) throw new Error("claim");
    const mock = wire(false);
    try {
      const paired = await pairNode({ server: SERVER, code: claim.code, dir, workdir: "/srv" });
      expect(paired.name).toBe("web01");
      expect(await loadToken(dir)).toBeString();
      const config = await loadConfig(dir);
      expect(config?.server).toBe(SERVER);
      expect(config?.workdir).toBe("/srv");
      expect(config?.name).toBe("web01");
      if (process.platform !== "win32") {
        expect((await stat(join(dir, "token"))).mode & 0o777).toBe(0o600);
      }

      const claim2 = openClaim({});
      if (!claim2.ok) throw new Error("claim");
      const refused = await pairNode({ server: SERVER, code: "ZZZZ9999", dir: join(dir, "other") }).catch((err: Error) => err.message);
      expect(String(refused)).toContain("not known");
    } finally {
      mock.restore();
    }
  });

  test.skipIf(!hasOpenssl)("stores the certificate bundle when the server issues one", async () => {
    const claim = openClaim({ name: "web01" });
    if (!claim.ok) throw new Error("claim");
    const mock = wire(true);
    try {
      await pairNode({ server: SERVER, code: claim.code, dir });
      const tls = await loadClientTls(dir);
      expect(tls?.cert).toContain("BEGIN CERTIFICATE");
      expect(tls?.key).toContain("PRIVATE KEY");
      if (process.platform !== "win32") {
        expect((await stat(join(dir, "client-key.pem"))).mode & 0o777).toBe(0o600);
      }
    } finally {
      mock.restore();
    }
  });

  test("a re-pair on a server without mtls drops a stale certificate", async () => {
    await writeFile(join(dir, "ca.pem"), "old");
    await writeFile(join(dir, "client.pem"), "old");
    await writeFile(join(dir, "client-key.pem"), "old");
    const claim = openClaim({ name: "web01" });
    if (!claim.ok) throw new Error("claim");
    const mock = wire(false);
    try {
      await pairNode({ server: SERVER, code: claim.code, dir });
      expect(await loadClientTls(dir)).toBeNull();
      await expect(readFile(join(dir, "client.pem"), "utf-8")).rejects.toBeDefined();
    } finally {
      mock.restore();
    }
  });
});
