import type { Server, ServerWebSocket } from "bun";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authHeaders, releaseSource } from "../channels/my-claw-app/release-source.ts";
import type { NodesConfig } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { removeNodeAgent, writeNodeAgent } from "./agent.ts";
import { issueNodeCertificate } from "./ca.ts";
import { consumeClaim, openClaim, peekClaim, type ClaimDenial } from "./claims.ts";
import { attachNodeSocket, closeNodeSocket, detachNodeSocket, handleNodeFrame, type NodeSocketData } from "./hub.ts";
import { findNodeByToken, mintNode, nodeRecord, revokeNode } from "./store.ts";
import { parseNodeFacts } from "./types.ts";

/**
 * The node surface: `/node` and its JSON routes, sharing the app channel's port.
 *
 * The adapter owns the server and hands this module the requests it recognises; everything about
 * nodes -- tokens, claims, sockets, agent files -- happens here. `/node/download` and
 * `/node/install.sh` are how a machine joins: the installer and the binary come from the my-claw
 * it is pairing with, gated by the same claim code, and the my-claw fetches them from the release
 * source with its own key (docs/remote-nodes.md).
 */

type NodeWs = ServerWebSocket<NodeSocketData>;

export interface NodeSurfaceDeps {
  nodes: () => NodesConfig | undefined;
  /** A paired device, the same credential `/my-claw-app/ticket` takes. */
  authorizeAdmin: (req: Request) => boolean;
}

export interface NodeSurface {
  /** A Response = answered; undefined = upgraded; null = not a node route. */
  handle(req: Request, server: Server<NodeSocketData>, context: { ip?: string }): Promise<Response | undefined | null>;
  open(ws: NodeWs): void;
  message(ws: NodeWs, raw: string): void;
  close(ws: NodeWs): void;
}

const CLAIM_DENIAL_STATUS: Record<ClaimDenial, number> = {
  unknown: 403,
  expired: 403,
  used: 403,
  attempts: 429,
};

export const NODE_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"] as const;
export type NodeTarget = (typeof NODE_TARGETS)[number];

/** What the release carries for one target. The Windows build keeps its `.exe`. */
export function nodeFileName(version: string, target: NodeTarget): string {
  return target === "windows-x64" ? `my-claw-node-${version}-windows-x64.exe` : `my-claw-node-${version}-${target}`;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function bearer(req: Request): string | undefined {
  const presented = req.headers.get("authorization");
  return presented?.startsWith("Bearer ") ? presented.slice("Bearer ".length) : undefined;
}

export function createNodeSurface(deps: NodeSurfaceDeps): NodeSurface {
  async function handlePair(req: Request, context: { ip?: string }): Promise<Response> {
    let body: { code?: unknown; facts?: unknown };
    try {
      body = (await req.json()) as { code?: unknown; facts?: unknown };
    } catch {
      return json({ error: "invalid body" }, 400);
    }
    const code = typeof body.code === "string" ? body.code : "";
    const facts = parseNodeFacts(body.facts);
    if (!code || !facts) return json({ error: "invalid body" }, 400);

    const claimed = consumeClaim(code, context.ip);
    if (!claimed.ok) {
      void log("warn", "node claim refused", { reason: claimed.reason, ip: context.ip });
      return json({ error: claimed.reason }, CLAIM_DENIAL_STATUS[claimed.reason]);
    }

    const name = claimed.name ?? facts.hostname;
    const minted = await mintNode({ name, facts });
    if (!minted.ok) return json({ error: minted.error }, 409);
    const agent = await writeNodeAgent(minted.minted.record, facts);

    // The certificate is issued before the answer, and the pairing fails without it: a node that
    // stored a token but no certificate would be refused at its first upgrade, with nothing on
    // its side explaining why.
    let mtls: { ca: string; cert: string; key: string } | undefined;
    if (deps.nodes()?.mtls) {
      try {
        mtls = await issueNodeCertificate(minted.minted.record.nodeId);
      } catch (err) {
        await revokeNode(minted.minted.record.nodeId);
        await removeNodeAgent(minted.minted.record.nodeId);
        void log("error", "node certificate issuance failed", { nodeId: minted.minted.record.nodeId, error: String(err) });
        return json({ error: "the server could not issue a certificate (is openssl installed?)" }, 500);
      }
    }

    void log("info", "node paired", { nodeId: minted.minted.record.nodeId, agent, mtls: Boolean(mtls), ip: context.ip });
    return json({
      nodeId: minted.minted.record.nodeId,
      name: minted.minted.record.name,
      token: minted.minted.token,
      ...(mtls ? { mtls } : {}),
    });
  }

  function handleTicket(req: Request, context: { ip?: string }): Response {
    if (!deps.authorizeAdmin(req)) return new Response("Unauthorized", { status: 401 });
    const opened = openClaim({
      ttlSeconds: deps.nodes()?.claimTtlSeconds,
      ip: context.ip,
    });
    if (!opened.ok) return json({ error: opened.reason }, 429);
    return json({ code: opened.code, expiresAt: opened.expiresAt });
  }

  async function handleRevoke(req: Request): Promise<Response> {
    if (!deps.authorizeAdmin(req)) return new Response("Unauthorized", { status: 401 });
    let body: { nodeId?: unknown };
    try {
      body = (await req.json()) as { nodeId?: unknown };
    } catch {
      return json({ error: "invalid body" }, 400);
    }
    const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
    if (!nodeId || !nodeRecord(nodeId)) return json({ error: "unknown node" }, 404);
    closeNodeSocket(nodeId, "revoked");
    await revokeNode(nodeId);
    await removeNodeAgent(nodeId);
    return json({ ok: true });
  }

  /**
   * The client binary, fetched from the release source with the server's own key and streamed to
   * the machine that is joining. The claim code is the gate: short-lived, and this route never
   * consumes it -- only pairing does. `version` pins a build; absent, the newest one.
   */
  async function handleDownload(req: Request, url: URL, context: { ip?: string }): Promise<Response> {
    const target = url.searchParams.get("target") ?? "";
    if (!(NODE_TARGETS as readonly string[]).includes(target)) {
      return json({ error: `unknown target (${NODE_TARGETS.join(", ")})` }, 400);
    }
    const code = bearer(req) ?? url.searchParams.get("code") ?? "";
    const claim = code ? peekClaim(code, context.ip) : ({ ok: false, reason: "unknown" } as const);
    if (!claim.ok) return json({ error: claim.reason }, CLAIM_DENIAL_STATUS[claim.reason]);

    const source = releaseSource();
    if (!source) return json({ error: "no release source on this server: run `myclaw release-key <key>`" }, 503);

    let version = url.searchParams.get("version") ?? "";
    if (version && !/^\d+\.\d+\.\d+$/.test(version)) return json({ error: "invalid version" }, 400);
    if (!version) {
      const latestUrl = `${source.base}/node/latest.json`;
      const latest = await fetch(latestUrl, { headers: { Accept: "application/json", ...authHeaders(latestUrl, source) } });
      if (!latest.ok) {
        await latest.body?.cancel();
        void log("warn", "node download: release source refused", { status: latest.status });
        return json({ error: `release source answered HTTP ${latest.status}` }, 502);
      }
      const body = (await latest.json().catch(() => undefined)) as { version?: unknown } | undefined;
      version = typeof body?.version === "string" ? body.version : "";
      if (!version) return json({ error: "no node release found" }, 502);
    }

    const name = nodeFileName(version, target as NodeTarget);
    const fileUrl = `${source.base}/node/${version}/${name}`;
    const file = await fetch(fileUrl, { headers: authHeaders(fileUrl, source) });
    if (!file.ok || !file.body) {
      await file.body?.cancel();
      void log("warn", "node download: build missing", { version, target, status: file.status });
      return json({ error: `no node build published for ${target} yet (looked for ${name})` }, 404);
    }
    void log("info", "node download", { version, target, ip: context.ip });
    const length = file.headers.get("content-length");
    return new Response(file.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${name}"`,
        ...(length ? { "content-length": length } : {}),
      },
    });
  }

  /** The installers, served from this release: the ones that match the server being joined. */
  async function handleInstaller(script: string): Promise<Response> {
    const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const file = Bun.file(join(repoRoot, "packaging", script));
    if (!(await file.exists())) return new Response("Not Found", { status: 404 });
    const type = script.endsWith(".ps1") ? "text/plain; charset=utf-8" : "text/x-shellscript; charset=utf-8";
    return new Response(file, { headers: { "content-type": type } });
  }

  function handleUpgrade(req: Request, server: Server<NodeSocketData>, context: { ip?: string }): Response | undefined {
    const clientCertHeader = deps.nodes()?.clientCertHeader;
    if (clientCertHeader) {
      const expected = deps.nodes()?.clientCertValue ?? "SUCCESS";
      if (req.headers.get(clientCertHeader) !== expected) {
        void log("warn", "node upgrade refused: client certificate not verified", { header: clientCertHeader, ip: context.ip });
        return new Response("Forbidden", { status: 403 });
      }
    }
    if (req.headers.get("upgrade") !== "websocket") return new Response("Upgrade Required", { status: 426 });

    const token = bearer(req);
    const record = token ? findNodeByToken(token) : undefined;
    if (!record) {
      void log("warn", "node upgrade refused: bad token", { ip: context.ip });
      return new Response("Unauthorized", { status: 401 });
    }

    const data: NodeSocketData = { node: true, nodeId: record.nodeId, lastSeen: Date.now() };
    if (server.upgrade(req, { data })) return undefined;
    return new Response("Upgrade Failed", { status: 500 });
  }

  return {
    async handle(req, server, context) {
      const url = new URL(req.url);
      if (url.pathname !== "/node" && !url.pathname.startsWith("/node/")) return null;

      if (url.pathname === "/node" && req.method === "GET") return handleUpgrade(req, server, context);
      if (url.pathname === "/node/pair" && req.method === "POST") return handlePair(req, context);
      if (url.pathname === "/node/ticket" && req.method === "POST") return handleTicket(req, context);
      if (url.pathname === "/node/revoke" && req.method === "POST") return handleRevoke(req);
      if (url.pathname === "/node/download" && req.method === "GET") return handleDownload(req, url, context);
      if (url.pathname === "/node/install.sh" && req.method === "GET") return handleInstaller("install-node.sh");
      if (url.pathname === "/node/install.ps1" && req.method === "GET") return handleInstaller("install-node.ps1");
      return new Response("Not Found", { status: 404 });
    },

    open(ws) {
      attachNodeSocket(ws);
    },

    message(ws, raw) {
      try {
        handleNodeFrame(ws, raw);
      } catch (err) {
        void log("error", "node frame dispatch threw", { nodeId: ws.data.nodeId, error: String(err) });
      }
    },

    close(ws) {
      detachNodeSocket(ws);
    },
  };
}
