import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MyClawAppAdapter } from "../../../src/channels/my-claw-app/adapter.ts";
import { mintTicket, verifyTicket } from "../../../src/channels/my-claw-app/media-ticket.ts";
import type { MyClawAppChannelConfig } from "../../../src/core/config.ts";

/**
 * Where a native client's credential travels (docs/my-claw-app-channel.md, "Credentials"). The
 * device token opens everything, and a URL is logged by every proxy on its way: it goes in headers.
 * What has to sit in a URL (an image, a player, a download) carries a media ticket instead, which
 * only reads media and expires.
 */

const DEVICE = "app-test";
const TOKEN = "device-secret-token";
const HOUR = 60 * 60 * 1000;

describe("the media ticket", () => {
  const tokenOf = (id: string) => (id === DEVICE ? TOKEN : undefined);

  test("names its device, and lives 24 to 36 hours", () => {
    for (const offset of [0, 1, 11.9 * HOUR]) {
      const now = Date.UTC(2026, 9, 11, 0, 0, 0) + offset;
      const { ticket, expiresAt } = mintTicket(DEVICE, TOKEN, now);
      expect(expiresAt - now).toBeGreaterThan(24 * HOUR);
      expect(expiresAt - now).toBeLessThanOrEqual(36 * HOUR);
      expect(verifyTicket(ticket, tokenOf, now)).toBe(DEVICE);
      expect(verifyTicket(ticket, tokenOf, expiresAt)).toBeNull();
    }
  });

  test("is the same for twelve hours, so image caches keep their keys", () => {
    const start = Date.UTC(2026, 9, 11, 0, 0, 0);
    expect(mintTicket(DEVICE, TOKEN, start).ticket).toBe(mintTicket(DEVICE, TOKEN, start + 11 * HOUR).ticket);
    expect(mintTicket(DEVICE, TOKEN, start).ticket).not.toBe(mintTicket(DEVICE, TOKEN, start + 12 * HOUR).ticket);
  });

  test("dies with the token, and cannot be forged, stretched or moved to another device", () => {
    const now = Date.now();
    const { ticket } = mintTicket(DEVICE, TOKEN, now);
    const [id, expires, sig] = ticket.split(".") as [string, string, string];
    expect(verifyTicket(ticket, () => "rotated", now)).toBeNull();
    expect(verifyTicket(ticket, () => undefined, now)).toBeNull();
    expect(verifyTicket(`${id}.${Number(expires) + 3600}.${sig}`, tokenOf, now)).toBeNull();
    expect(verifyTicket(`other.${expires}.${sig}`, (d) => (d === "other" ? TOKEN : undefined), now)).toBeNull();
    const far = mintTicket(DEVICE, TOKEN, now + 10 * 24 * HOUR).ticket;
    expect(verifyTicket(far, tokenOf, now)).toBeNull();
    for (const junk of ["", "a.b.c", `${ticket}x`, ticket.slice(0, -1), "../x.1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
      expect(verifyTicket(junk, tokenOf, now)).toBeNull();
    }
  });
});

describe("the adapter", () => {
  let adapter: MyClawAppAdapter;
  let base: string;
  const config = (): MyClawAppChannelConfig => ({
    port: 0,
    devices: { [DEVICE]: { token: TOKEN, name: "phone" }, off: { token: "off-token", enabled: false } },
  } as MyClawAppChannelConfig);
  const headers = { "X-My-Claw-Device": DEVICE, Authorization: `Bearer ${TOKEN}` };

  beforeEach(async () => {
    adapter = new MyClawAppAdapter(config(), { flushDrafts: async () => {} } as never);
    await adapter.start();
    base = `http://127.0.0.1:${adapter.port}`;
  });
  afterEach(async () => {
    await adapter.stop();
  });

  test("reads the credential from headers; a wrong token or a disabled device is refused", async () => {
    expect((await fetch(`${base}/health`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/health`, { headers: { ...headers, Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${base}/health`, { headers: { "X-My-Claw-Device": "off", Authorization: "Bearer off-token" } })).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(401);
  });

  test("a ticket opens the read routes and nothing else", async () => {
    const { ticket } = mintTicket(DEVICE, TOKEN);
    expect((await fetch(`${base}/media/nope?ticket=${ticket}`)).status).toBe(404);
    expect((await fetch(`${base}/skills?source=builtin&name=x&ticket=${ticket}`)).status).not.toBe(401);
    for (const [path, method] of [["/health", "GET"], ["/app-update", "GET"], ["/media", "POST"], ["/fs/upload?path=/tmp", "POST"]] as const) {
      expect((await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}ticket=${ticket}`, { method })).status).toBe(401);
    }
    expect((await fetch(`${base}/media/nope?ticket=${ticket.slice(0, -2)}xx`)).status).toBe(401);
  });

  test("a disabled device's tickets stop working", async () => {
    const { ticket } = mintTicket("off", "off-token");
    expect((await fetch(`${base}/media/nope?ticket=${ticket}`)).status).toBe(401);
  });

  test("the socket opens with headers, is handed a ticket that works, and again on request", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${adapter.port}/my-claw-app`, { headers } as never);
    const tickets: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame["type"] !== "media.ticket") return;
        tickets.push(frame);
        if (tickets.length === 1) ws.send(JSON.stringify({ type: "media.ticket.get" }));
        else resolve();
      };
      ws.onerror = () => reject(new Error("socket refused"));
    });
    ws.close();
    expect(tickets[1]!["ticket"]).toBe(tickets[0]!["ticket"]);
    expect(tickets[0]!["expiresAt"]).toBeGreaterThan(Date.now() + 24 * HOUR);
    expect((await fetch(`${base}/media/nope?ticket=${tickets[0]!["ticket"]}`)).status).toBe(404);
  });

  test("a socket open as the bucket turns is handed the next ticket, once", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${adapter.port}/my-claw-app`, { headers } as never);
    const tickets: string[] = [];
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame["type"] === "media.ticket") tickets.push(String(frame["ticket"]));
    };
    while (tickets.length < 1) await Bun.sleep(10);
    const refresh = (now: number) => (adapter as unknown as { refreshTickets(now: number): void }).refreshTickets(now);
    refresh(Date.now());
    const later = Date.now() + 13 * HOUR;
    refresh(later);
    refresh(later);
    while (tickets.length < 2) await Bun.sleep(10);
    await Bun.sleep(50);
    ws.close();
    expect(tickets).toHaveLength(2);
    expect(tickets[1]).not.toBe(tickets[0]);
  });

  test("the URL credential of older apps still works, for the transition", async () => {
    expect((await fetch(`${base}/health?device=${DEVICE}&token=${TOKEN}`)).status).toBe(200);
    expect((await fetch(`${base}/health?device=${DEVICE}&token=nope`)).status).toBe(401);
  });
});
