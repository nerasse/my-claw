import { test } from "bun:test";
import assert from "node:assert/strict";
import { isPrivateUrl, isPrivateIp } from "../../src/tools/fetch.ts";

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
