import { afterAll, describe, expect, test } from "bun:test";
import type { MyClawAppChannelConfig } from "../../../src/core/config.ts";
import { addressInCidr, clientIp, requestHost, requestIsSecure } from "../../../src/channels/my-claw-app/web.ts";

/**
 * What a declared proxy is believed about: the scheme (the `Secure` cookie), the host (the Origin
 * check) and the client address (logs, the per-IP pairing limit). Bun listens dual-stack, so the
 * address it reports for an IPv4 peer is IPv4-mapped; the owner declares the plain one. For a month
 * the two never matched and no proxy was trusted at all (2026-10-11).
 */

const config = { web: { enabled: true, trustedProxies: ["10.10.10.50", "192.168.1.0/24"] } } as MyClawAppChannelConfig;
const forwarded = new Headers({
  "x-forwarded-proto": "https",
  "x-forwarded-host": "claw.example.fr",
  "x-forwarded-for": "203.0.113.7, 10.10.10.50",
  host: "10.10.20.10:8080",
});
const url = new URL("http://10.10.20.10:8080/my-claw-app/session");

describe("a declared proxy", () => {
  test("is recognised in the IPv4-mapped form Bun reports, and in the plain one", () => {
    for (const peer of ["::ffff:10.10.10.50", "::FFFF:10.10.10.50", "10.10.10.50", "::ffff:192.168.1.9"]) {
      expect(requestIsSecure(config, url, forwarded, peer)).toBe(true);
      expect(requestHost(config, url, forwarded, peer)).toBe("claw.example.fr");
      expect(clientIp(config, forwarded, peer)).toBe("203.0.113.7");
    }
  });

  test("anyone else is believed about nothing", () => {
    for (const peer of ["::ffff:10.10.10.51", "10.10.20.99", "::ffff:192.168.2.9", "::1", undefined]) {
      expect(requestIsSecure(config, url, forwarded, peer)).toBe(false);
      expect(requestHost(config, url, forwarded, peer)).toBe("10.10.20.10:8080");
      expect(clientIp(config, forwarded, peer)).toBe(peer);
    }
  });

  test("the mapping is only stripped from an IPv4 address, never from a crafted one", () => {
    expect(addressInCidr("::ffff:10.10.10.50", "10.10.10.50")).toBe(true);
    expect(addressInCidr("::ffff:abcd", "abcd")).toBe(false);
    expect(addressInCidr("x::ffff:10.10.10.50", "10.10.10.50")).toBe(false);
    expect(addressInCidr("::ffff:10.10.10.50", "10.10.10.0/24")).toBe(true);
  });
});

describe("the address Bun really reports", () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => {
      const peer = srv.requestIP(req)?.address;
      return Response.json({ peer, secure: requestIsSecure({ web: { trustedProxies: ["127.0.0.1"] } } as MyClawAppChannelConfig, new URL(req.url), req.headers, peer) });
    },
  });
  afterAll(() => server.stop(true));

  test("an IPv4 proxy on loopback is trusted, whatever form the address takes", async () => {
    const answer = await (await fetch(`http://127.0.0.1:${server.port}/`, { headers: { "x-forwarded-proto": "https" } })).json() as { peer: string; secure: boolean };
    expect(answer.peer).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    expect(answer.secure).toBe(true);
  });
});
