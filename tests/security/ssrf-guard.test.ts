import { test } from "bun:test";
import assert from "node:assert/strict";
import { isPrivateUrl, isPrivateIp, isAllowedScheme, resolveAndCheckUrl } from "../../src/tools/fetch.ts";
import { mockDns } from "../helpers/mock-dns.ts";

test("isPrivateUrl: https://example.com is public", () => {
  assert.equal(isPrivateUrl("https://example.com"), false);
});

test("isPrivateUrl: https://google.com is public", () => {
  assert.equal(isPrivateUrl("https://google.com"), false);
});

test("isPrivateUrl: http://localhost is private", () => {
  assert.equal(isPrivateUrl("http://localhost"), true);
});

test("isPrivateUrl: http://localhost:8080 is private", () => {
  assert.equal(isPrivateUrl("http://localhost:8080"), true);
});

test("isPrivateUrl: http://127.0.0.1 is private", () => {
  assert.equal(isPrivateUrl("http://127.0.0.1"), true);
});

test("isPrivateUrl: http://127.0.0.1:3000 is private", () => {
  assert.equal(isPrivateUrl("http://127.0.0.1:3000"), true);
});

test("isPrivateUrl: http://10.0.0.1 is private", () => {
  assert.equal(isPrivateUrl("http://10.0.0.1"), true);
});

test("isPrivateUrl: http://10.255.255.255 is private", () => {
  assert.equal(isPrivateUrl("http://10.255.255.255"), true);
});

test("isPrivateUrl: http://172.16.0.1 is private", () => {
  assert.equal(isPrivateUrl("http://172.16.0.1"), true);
});

test("isPrivateUrl: http://172.31.255.255 is private", () => {
  assert.equal(isPrivateUrl("http://172.31.255.255"), true);
});

test("isPrivateUrl: http://172.15.0.1 is public (below 172.16 range)", () => {
  assert.equal(isPrivateUrl("http://172.15.0.1"), false);
});

test("isPrivateUrl: http://172.32.0.1 is public (above 172.31 range)", () => {
  assert.equal(isPrivateUrl("http://172.32.0.1"), false);
});

test("isPrivateUrl: http://192.168.0.1 is private", () => {
  assert.equal(isPrivateUrl("http://192.168.0.1"), true);
});

test("isPrivateUrl: http://192.168.1.100 is private", () => {
  assert.equal(isPrivateUrl("http://192.168.1.100"), true);
});

test("isPrivateUrl: http://169.254.169.254 is private (cloud metadata)", () => {
  assert.equal(isPrivateUrl("http://169.254.169.254"), true);
});

test("isPrivateUrl: http://metadata.google.internal is private", () => {
  assert.equal(isPrivateUrl("http://metadata.google.internal"), true);
});

test("isPrivateUrl: http://metadata.goog is private", () => {
  assert.equal(isPrivateUrl("http://metadata.goog"), true);
});

test("isPrivateUrl: http://0.0.0.0 is private", () => {
  assert.equal(isPrivateUrl("http://0.0.0.0"), true);
});

test("isPrivateUrl: http://[::1] is private (IPv6 loopback)", () => {
  assert.equal(isPrivateUrl("http://[::1]"), true);
});

test("isPrivateUrl: invalid URL treated as private", () => {
  assert.equal(isPrivateUrl("not a url"), true);
});

test("isPrivateUrl: empty string treated as private", () => {
  assert.equal(isPrivateUrl(""), true);
});

test("isPrivateUrl: http://8.8.8.8 is public", () => {
  assert.equal(isPrivateUrl("http://8.8.8.8"), false);
});

test("isPrivateUrl: http://192.167.0.1 is public (not 192.168)", () => {
  assert.equal(isPrivateUrl("http://192.167.0.1"), false);
});

// IPv6 tests via isPrivateUrl
test("isPrivateUrl: http://[fe80::1] is private (link-local)", () => {
  assert.equal(isPrivateUrl("http://[fe80::1]"), true);
});

test("isPrivateUrl: http://[fd00::1] is private (unique local)", () => {
  assert.equal(isPrivateUrl("http://[fd00::1]"), true);
});

test("isPrivateUrl: http://[fc00::1] is private (unique local)", () => {
  assert.equal(isPrivateUrl("http://[fc00::1]"), true);
});

test("isPrivateUrl: http://[::ffff:127.0.0.1] is private (IPv4-mapped)", () => {
  assert.equal(isPrivateUrl("http://[::ffff:127.0.0.1]"), true);
});

test("isPrivateUrl: http://[::ffff:10.0.0.1] is private (IPv4-mapped)", () => {
  assert.equal(isPrivateUrl("http://[::ffff:10.0.0.1]"), true);
});

test("isPrivateUrl: http://[2001:db8::1] is public", () => {
  assert.equal(isPrivateUrl("http://[2001:db8::1]"), false);
});

test("isPrivateUrl: http://[::ffff:8.8.8.8] is public (IPv4-mapped public)", () => {
  assert.equal(isPrivateUrl("http://[::ffff:8.8.8.8]"), false);
});

test("isPrivateUrl: http://169.254.42.42 is private (link-local range)", () => {
  assert.equal(isPrivateUrl("http://169.254.42.42"), true);
});

// isPrivateIp unit tests
test("isPrivateIp: 127.0.0.1", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
});

test("isPrivateIp: ::1", () => {
  assert.equal(isPrivateIp("::1"), true);
});

test("isPrivateIp: fe80::1", () => {
  assert.equal(isPrivateIp("fe80::1"), true);
});

test("isPrivateIp: ::ffff:192.168.1.1", () => {
  assert.equal(isPrivateIp("::ffff:192.168.1.1"), true);
});

test("isPrivateIp: 8.8.8.8 is public", () => {
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("isPrivateIp: 2001:db8::1 is public", () => {
  assert.equal(isPrivateIp("2001:db8::1"), false);
});

/**
 * Schemes. `fetch` speaks http(s) and nothing else: `file://` turned the tool into an
 * unapproved read of the whole disk, including for a research agent that has no filesystem
 * tool at all, and a hostile page reaches it through a redirect rather than through the model.
 */

test("isAllowedScheme: http and https are the only two", () => {
  assert.equal(isAllowedScheme("http://example.com"), true);
  assert.equal(isAllowedScheme("https://example.com"), true);
});

test("isAllowedScheme: file:// is refused", () => {
  assert.equal(isAllowedScheme("file:///home/neras/.my-claw/config.json"), false);
});

test("isAllowedScheme: data:, ftp: and gopher: are refused", () => {
  assert.equal(isAllowedScheme("data:text/plain,hello"), false);
  assert.equal(isAllowedScheme("ftp://example.com/x"), false);
  assert.equal(isAllowedScheme("gopher://example.com"), false);
});

test("isAllowedScheme: nonsense is refused rather than thrown on", () => {
  assert.equal(isAllowedScheme("not a url"), false);
  assert.equal(isAllowedScheme(""), false);
});

test("isPrivateUrl: a file:// url is blocked by the same gate the browser tools use", () => {
  assert.equal(isPrivateUrl("file:///etc/hostname"), true);
});

/** Ranges the first pass missed. The tailnet one is the homelab's own address space. */

test("isPrivateIp: 100.64.0.0/10 is the carrier-grade NAT range tailscale hands out", () => {
  assert.equal(isPrivateIp("100.64.0.1"), true);
  assert.equal(isPrivateIp("100.100.100.100"), true);
  assert.equal(isPrivateIp("100.127.255.255"), true);
});

test("isPrivateIp: 100.x outside 64-127 stays public", () => {
  assert.equal(isPrivateIp("100.63.255.255"), false);
  assert.equal(isPrivateIp("100.128.0.1"), false);
});

test("isPrivateIp: benchmarking, multicast and reserved are refused", () => {
  assert.equal(isPrivateIp("198.18.0.1"), true);
  assert.equal(isPrivateIp("198.19.255.255"), true);
  assert.equal(isPrivateIp("224.0.0.1"), true);
  assert.equal(isPrivateIp("240.0.0.1"), true);
  assert.equal(isPrivateIp("255.255.255.255"), true);
});

test("isPrivateIp: NAT64 carries a loopback across the translator", () => {
  assert.equal(isPrivateIp("64:ff9b::7f00:1"), true);
});

test("resolveAndCheckUrl: a name that does not resolve is refused, not allowed through", async () => {
  // Fail closed: the resolver here is not the resolver inside fetch, and the gap between the
  // two is the whole of a rebinding attack.
  //
  // Through the seam, not the real DNS. Asking the network what `.invalid` resolves to is a
  // question with two answers: NXDOMAIN on a workstation, something else entirely on a runner
  // behind a resolver that answers everything -- and the guard then reads as fail-open. The
  // suite must not depend on which network it runs in.
  const dns = mockDns(null);
  try {
    assert.equal(await resolveAndCheckUrl("https://this-name-does-not-exist.invalid/x"), true);
  } finally {
    dns.restore();
  }
});
