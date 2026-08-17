import { test } from "bun:test";
import assert from "node:assert/strict";
import { securityHeaders } from "../../src/channels/my-claw-app/web.ts";

/**
 * The policy that ships with every page of the web client.
 *
 * Asserted rather than reviewed, because a directive that is one token short fails at the far end
 * of a user action with a message that names nothing: a picked file could not be read back and the
 * app said "Failed to fetch", with the actual reason only in the browser console. Measured in a
 * real Chromium: `connect-src 'self' ws: wss:` refuses `fetch('blob:...')`, adding `blob:` allows
 * it, and img-src/media-src already allowed blob: so the same file displayed fine.
 */

function directive(name: string): string[] {
  const policy = securityHeaders()["Content-Security-Policy"] ?? "";
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  assert.ok(found, `${name} is missing from the policy`);
  return found.split(/\s+/).slice(1);
}

test("csp: a picked file can be read back (connect-src allows blob:)", () => {
  assert.ok(directive("connect-src").includes("blob:"));
});

test("csp: the socket schemes stay allowed alongside it", () => {
  const sources = directive("connect-src");
  assert.ok(sources.includes("'self'"));
  assert.ok(sources.includes("ws:"));
  assert.ok(sources.includes("wss:"));
});

test("csp: blob: never widens where code may come from", () => {
  // The point of the policy is that no third party can run in a page holding a session cookie.
  // blob: in connect-src is about reading bytes; it must not leak into script or default.
  assert.ok(!directive("default-src").includes("blob:"));
  const policy = securityHeaders()["Content-Security-Policy"] ?? "";
  assert.ok(!/script-src[^;]*blob:/.test(policy));
});

test("csp: media and images already allowed blob:, and still do", () => {
  assert.ok(directive("img-src").includes("blob:"));
  assert.ok(directive("media-src").includes("blob:"));
});
