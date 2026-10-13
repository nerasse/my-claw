import type { Server, ServerWebSocket } from "bun";
import type { NodesConfig } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { removeNodeAgent, writeNodeAgent } from "./agent.ts";
import { consumeClaim, openClaim, type ClaimDenial } from "./claims.ts";
import { attachNodeSocket, closeNodeSocket, detachNodeSocket, handleNodeFrame, type NodeSocketData } from "./hub.ts";
import { findNodeByToken, mintNode, nodeRecord, revokeNode } from "./store.ts";
import { parseNodeFacts } from "./types.ts";

/**
 * The node surface: `/node` and its three JSON routes, sharing the app channel's port.
 *
 * The adapter owns the server and hands this module the requests it recognises; everything about
 * nodes -- tokens, claims, sockets, agent files -- happens here. docs/remote-nodes.md.
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

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
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
    void log("info", "node paired", { nodeId: minted.minted.record.nodeId, agent, ip: context.ip });
    return json({ nodeId: minted.minted.record.nodeId, name: minted.minted.record.name, token: minted.minted.token });
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

    const presented = req.headers.get("authorization");
    const token = presented?.startsWith("Bearer ") ? presented.slice("Bearer ".length) : undefined;
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
