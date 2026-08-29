import type { ServerWebSocket } from "bun";
import type { MyClawAppChannelConfig } from "../../core/config.ts";
import type { PairingKind } from "./pairing.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import {
  claim,
  claimQrSvg,
  closeSession,
  detachSession,
  normalizeCode,
  openSession,
  resumeSession,
  type PairingDelivery,
  type PairingDenial,
  type PairingSession,
} from "./pairing.ts";
import { redeemGrant, sessionCookie } from "./web-session.ts";
import { securityHeaders } from "./web.ts";
import type { MyClawAppServerFrame } from "./types.ts";

/**
 * The pairing socket and the grant exchange (docs/web-pairing.md).
 *
 * Kept out of adapter.ts because it is a different protocol on a different route with a
 * different trust level: nothing here is authenticated, and none of it may reach a chat handler.
 * A pairing socket can never become a chat socket, it only ever carries the four frames below.
 */

export interface PairSocketData {
  pairing: true;
  /** The challenge this socket raised, so closing it destroys the session. */
  code?: string;
  origin?: string;
  ip?: string;
  userAgent?: string;
  lastSeen: number;
  /** Host and scheme the browser used, so the QR points back at the page it is shown on. */
  host?: string;
  secure?: boolean;
  /** What the client announced in pair.hello, so a claim knows which credential to hand out. */
  kind?: PairingKind;
  /** Present so the shape stays compatible with the chat socket data. */
  deviceId: string;
  owner: string;
}

type PairWs = ServerWebSocket<PairSocketData>;

function send(ws: PairWs, frame: MyClawAppServerFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // The socket went away mid-delivery; the session is dropped by the close handler.
  }
}

export class PairingSockets {
  constructor(private readonly config: () => MyClawAppChannelConfig) {}

  message(ws: PairWs, raw: string): void {
    ws.data.lastSeen = Date.now();
    let frame:
      | { type?: unknown; kind?: unknown; code?: unknown; userAgent?: unknown; resume?: unknown }
      | undefined;
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;

    if (frame.type === "pair.hello") {
      const kind = frame.kind === "native" ? "native" : "web";
      ws.data.kind = kind;
      if (typeof frame.userAgent === "string") ws.data.userAgent = frame.userAgent.slice(0, 200);
      // A refused resume is not an error worth showing: the challenge simply outlived its
      // usefulness, and the page gets a new one on the same socket.
      if (this.resume(ws, frame.resume)) return;
      this.open(ws, kind);
      return;
    }

    if (frame.type === "pair.claim" && typeof frame.code === "string") {
      // The ticket was minted by the CLI, but what the client gets depends on who is asking: a
      // browser takes a grant (its assets are fetched with a cookie), a native client takes the
      // token itself. A client that never sent pair.hello is treated as a browser, the previous
      // behaviour.
      const claimed = claim(frame.code, ws.data.kind ?? "web");
      if (!claimed.ok) {
        send(ws, { type: "pair.denied", reason: claimed.reason });
        return;
      }
      this.grant(ws, claimed.delivery);
      return;
    }
  }

  close(ws: PairWs): void {
    // The challenge outlives the socket, the credential does not: it is only ever sent to a
    // connection that proves the resume token, and only once.
    if (ws.data.code) detachSession(ws.data.code);
  }

  /** POST /my-claw-app/session: the grant becomes the cookie the bundle is served against. */
  async handleSessionPost(req: Request, secure: boolean): Promise<Response> {
    let grant: unknown;
    try {
      grant = ((await req.json()) as { grant?: unknown }).grant;
    } catch {
      return new Response("Bad Request", { status: 400, headers: securityHeaders() });
    }
    if (typeof grant !== "string" || grant.length === 0) {
      return new Response("Bad Request", { status: 400, headers: securityHeaders() });
    }

    const redeemed = await redeemGrant(grant, req.headers.get("user-agent") ?? undefined);
    if (!redeemed.ok) {
      myClawAppLog("warn", "grant refused", { reason: redeemed.reason });
      return new Response("Unauthorized", { status: 401, headers: securityHeaders() });
    }

    return new Response(null, {
      status: 204,
      headers: securityHeaders({ "Set-Cookie": sessionCookie(redeemed.sessionId, secure) }),
    });
  }

  /** Picks a challenge back up after a reconnect. False means there is nothing to pick up. */
  private resume(ws: PairWs, resume: unknown): boolean {
    if (typeof resume !== "object" || resume === null) return false;
    const { code, token } = resume as { code?: unknown; token?: unknown };
    if (typeof code !== "string" || typeof token !== "string") return false;
    if (ws.data.code && ws.data.code !== normalizeCode(code)) closeSession(ws.data.code);

    const resumed = resumeSession(code, token, {
      deliver: (delivery: PairingDelivery): void => this.grant(ws, delivery),
      reject: (reason: PairingDenial): void => send(ws, { type: "pair.denied", reason }),
      pending: (approver: string): void => send(ws, { type: "pair.pending", approver }),
    });
    if (!resumed.ok) return false;
    // The approval landed while the page was away and has just been delivered: a challenge frame
    // on top of it would put a dead code back on a screen that is already leaving.
    if (resumed.flushed) return true;

    ws.data.code = resumed.session.code;
    this.sendChallenge(ws, resumed.session);
    return true;
  }

  private open(ws: PairWs, kind: "web" | "native"): void {
    if (ws.data.code) closeSession(ws.data.code);

    const deliver = (delivery: PairingDelivery): void => this.grant(ws, delivery);
    const reject = (reason: PairingDenial): void => send(ws, { type: "pair.denied", reason });
    const pending = (approver: string): void => send(ws, { type: "pair.pending", approver });

    const opened = openSession(this.config(), {
      kind,
      origin: ws.data.origin,
      ip: ws.data.ip,
      userAgent: ws.data.userAgent,
      deliver,
      reject,
      pending,
    });
    if (!opened.ok) {
      send(ws, { type: "pair.denied", reason: "disabled" });
      try {
        ws.close(1008, opened.reason);
      } catch {
        // already gone
      }
      return;
    }

    ws.data.code = opened.session.code;
    this.sendChallenge(ws, opened.session);
  }

  private sendChallenge(ws: PairWs, session: PairingSession): void {
    send(ws, {
      type: "pair.challenge",
      code: session.code,
      verification: session.verification,
      expiresAt: session.expiresAt,
      resumeToken: session.resumeToken,
    });
    // The QR is a second frame: drawing it takes a few milliseconds, and the code must be on
    // screen immediately rather than after the encoder.
    if (!ws.data.host) return;
    void claimQrSvg(ws.data.host, session.code, ws.data.secure === true)
      .then((qrSvg) => {
        if (ws.data.code !== session.code) return;
        send(ws, {
          type: "pair.challenge",
          code: session.code,
          verification: session.verification,
          expiresAt: session.expiresAt,
          resumeToken: session.resumeToken,
          qrSvg,
        });
      })
      .catch(() => {
        // No QR is a cosmetic loss: the code is typable and the page says so.
      });
  }

  private grant(ws: PairWs, delivery: PairingDelivery): void {
    ws.data.code = undefined;
    send(ws, {
      type: "pair.granted",
      deviceId: delivery.deviceId,
      owner: delivery.owner,
      name: delivery.name,
      ...(delivery.grant ? { grant: delivery.grant } : {}),
      ...(delivery.token ? { token: delivery.token } : {}),
    });
  }
}
