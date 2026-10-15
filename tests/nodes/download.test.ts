import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import type { Server } from "bun";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { createNodeSurface, nodeFileName, NODE_TARGETS } from "../../src/nodes/surface.ts";
import { openClaim, resetClaims } from "../../src/nodes/claims.ts";
import { nodesFilePath, resetNodesStore } from "../../src/nodes/store.ts";
import { resetNodeHub, type NodeSocketData } from "../../src/nodes/hub.ts";
import { resetNodeCa } from "../../src/nodes/ca.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import type { NodeFacts } from "../../src/nodes/types.ts";

const FACTS: NodeFacts = {
  os: "linux",
  arch: "x64",
  hostname: "web01",
  user: "neras",
  mode: "user",
  version: "0.1.0",
  tools: [{ name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } }],
};

function fakeServer(): Server<NodeSocketData> {
  return { upgrade: () => true } as unknown as Server<NodeSocketData>;
}

const surface = (options: { mtls?: boolean } = {}) =>
  createNodeSurface({
    nodes: () => (options.mtls ? { mtls: true } : undefined),
    authorizeAdmin: () => true,
  });

let savedUrl: string | undefined;

beforeEach(async () => {
  await resetNodesStore();
  await rm(nodesFilePath(), { force: true });
  await rm(`${MY_CLAW_DIR}/nodes/ca`, { recursive: true, force: true });
  resetClaims();
  resetNodeHub();
  resetNodeCa();
  savedUrl = process.env["MY_CLAW_RELEASE_URL"];
});

afterEach(() => {
  if (savedUrl === undefined) delete process.env["MY_CLAW_RELEASE_URL"];
  else process.env["MY_CLAW_RELEASE_URL"] = savedUrl;
});

/** The hub as the server sees it: latest.json, and the file itself. */
function hubMock(options: { version?: string; missing?: boolean } = {}) {
  const version = options.version ?? "9.9.9";
  const seen: string[] = [];
  const mock = mockFetch(async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/node/latest.json")) {
      return Response.json({ version, files: NODE_TARGETS.map((target) => ({ name: nodeFileName(version, target), size: 4 })) });
    }
    if (url.includes(`/node/${version}/`)) {
      if (options.missing) return new Response("nope", { status: 404 });
      return new Response("BINARY", { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return new Response("not found", { status: 404 });
  });
  return { mock, seen };
}

describe("the node download relay", () => {
  test("a claim code fetches the newest build for a target, through the release source", async () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://hub.test/my-claw";
    const { mock, seen } = hubMock();
    try {
      const claim = openClaim({ name: "web01" });
      if (!claim.ok) throw new Error("claim");
      const reply = await surface().handle(
        new Request("http://local/node/download?target=linux-x64", { headers: { authorization: `Bearer ${claim.code}` } }),
        fakeServer(),
        {},
      );
      expect(reply?.status).toBe(200);
      expect(await reply!.text()).toBe("BINARY");
      expect(reply?.headers.get("content-disposition")).toContain("my-claw-node-9.9.9-linux-x64");
      expect(seen.some((url) => url.endsWith("/node/latest.json"))).toBe(true);
      expect(seen.some((url) => url.endsWith("/node/9.9.9/my-claw-node-9.9.9-linux-x64"))).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("the download never consumes the code, and pairing still can", async () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://hub.test/my-claw";
    const { mock } = hubMock();
    try {
      const claim = openClaim({});
      if (!claim.ok) throw new Error("claim");
      const first = await surface().handle(
        new Request(`http://local/node/download?target=linux-x64&code=${claim.code}`),
        fakeServer(),
        {},
      );
      expect(first?.status).toBe(200);
      const second = await surface().handle(
        new Request(`http://local/node/download?target=linux-x64&code=${claim.code}`),
        fakeServer(),
        {},
      );
      expect(second?.status).toBe(200);

      const paired = await surface().handle(
        new Request("http://local/node/pair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: claim.code, facts: FACTS }),
        }),
        fakeServer(),
        {},
      );
      expect(paired?.status).toBe(200);
    } finally {
      mock.restore();
    }
  });

  test("a bad code, an unknown target, a pinned version and a missing build each answer their own status", async () => {
    process.env["MY_CLAW_RELEASE_URL"] = "https://hub.test/my-claw";
    const { mock, seen } = hubMock({ missing: true });
    try {
      const bad = await surface().handle(new Request("http://local/node/download?target=linux-x64"), fakeServer(), {});
      expect(bad?.status).toBe(403);

      const claim = openClaim({});
      if (!claim.ok) throw new Error("claim");
      const wrongCode = await surface().handle(
        new Request("http://local/node/download?target=linux-x64&code=ZZZZ9999"),
        fakeServer(),
        {},
      );
      expect(wrongCode?.status).toBe(403);

      const unknown = await surface().handle(
        new Request(`http://local/node/download?target=plan9&code=${claim.code}`),
        fakeServer(),
        {},
      );
      expect(unknown?.status).toBe(400);

      // Pinned: latest.json is never asked for.
      seen.length = 0;
      const pinned = await surface().handle(
        new Request(`http://local/node/download?target=linux-x64&version=1.2.3&code=${claim.code}`),
        fakeServer(),
        {},
      );
      expect(pinned?.status).toBe(404);
      expect(seen.some((url) => url.endsWith("/node/latest.json"))).toBe(false);
      expect(seen.some((url) => url.endsWith("/node/1.2.3/my-claw-node-1.2.3-linux-x64"))).toBe(true);

      const invalid = await surface().handle(
        new Request(`http://local/node/download?target=linux-x64&version=latest&code=${claim.code}`),
        fakeServer(),
        {},
      );
      expect(invalid?.status).toBe(400);
    } finally {
      mock.restore();
    }
  });

  test("without a release source the relay says so", async () => {
    delete process.env["MY_CLAW_RELEASE_URL"];
    const claim = openClaim({});
    if (!claim.ok) throw new Error("claim");
    const reply = await surface().handle(
      new Request(`http://local/node/download?target=linux-x64&code=${claim.code}`),
      fakeServer(),
      {},
    );
    expect(reply?.status).toBe(503);
  });

  test("both installers are served from the release", async () => {
    const sh = await surface().handle(new Request("http://local/node/install.sh"), fakeServer(), {});
    expect(sh?.status).toBe(200);
    expect(await sh!.text()).toContain("install-node");

    const ps1 = await surface().handle(new Request("http://local/node/install.ps1"), fakeServer(), {});
    expect(ps1?.status).toBe(200);
    expect(await ps1!.text()).toContain("Scheduled Task");
  });
});

const hasOpenssl = Boolean(Bun.which("openssl"));

describe("the mTLS pairing", () => {
  test.skipIf(!hasOpenssl)("issues a certificate signed by the server's own CA, in the pair response", async () => {
    const claim = openClaim({ name: "web01" });
    if (!claim.ok) throw new Error("claim");
    const reply = await surface({ mtls: true }).handle(
      new Request("http://local/node/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: claim.code, facts: FACTS }),
      }),
      fakeServer(),
      {},
    );
    expect(reply?.status).toBe(200);
    const body = (await reply!.json()) as { nodeId: string; mtls?: { ca: string; cert: string; key: string } };
    expect(body.mtls?.ca).toContain("BEGIN CERTIFICATE");
    expect(body.mtls?.cert).toContain("BEGIN CERTIFICATE");
    expect(body.mtls?.key).toContain("PRIVATE KEY");

    // The certificate really chains to the CA the server kept.
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const scratch = await mkdtemp(join(tmpdir(), "node-ca-verify-"));
    const caPath = join(scratch, "ca.pem");
    const certPath = join(scratch, "client.pem");
    await writeFile(caPath, body.mtls!.ca);
    await writeFile(certPath, body.mtls!.cert);
    const verify = Bun.spawnSync(["openssl", "verify", "-CAfile", caPath, certPath]);
    expect(verify.exitCode).toBe(0);
  });

  test("without mtls the response carries no certificate", async () => {
    const claim = openClaim({ name: "web01" });
    if (!claim.ok) throw new Error("claim");
    const reply = await surface().handle(
      new Request("http://local/node/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: claim.code, facts: FACTS }),
      }),
      fakeServer(),
      {},
    );
    const body = (await reply!.json()) as { mtls?: unknown };
    expect(body.mtls).toBeUndefined();
  });
});
