import { expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { APNsToken, apnsEnvelope, classifyAPNsResponse } from "../../src/apns-relay/provider";
import type { RelayRegistration } from "../../src/apns-relay/types";
const registration: RelayRegistration = { id: "registration", keyId: "key", origin: "https://instance.example", token: "aa", secretHash: "hash", tokenUpdatedAt: 1000, active: true };
test("provider token is ES256, scoped to the Apple team and refreshed before expiry", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" }); let now = 1_000_000;
  const token = new APNsToken("APPLE_TEAM", "APPLE_KEY", keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), () => now);
  const value = token.value(); const [header, payload, signature] = value.split(".");
  expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "APPLE_KEY" });
  expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iss: "APPLE_TEAM", iat: 1000 });
  expect(verify("sha256", Buffer.from(`${header}.${payload}`), { key: keys.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
  expect(token.value()).toBe(value); now += 51 * 60_000; expect(token.value()).not.toBe(value);
});
test("notification carries the association and destination without exposing secrets", () => {
  const payload = apnsEnvelope(registration, { title: "Title", body: "Preview", target: { kind: "thread", threadId: "thread" }, ring: true });
  expect(payload).toEqual({ aps: { alert: { title: "Title", body: "Preview" }, sound: "default", "thread-id": "thread:thread" },
    myclaw: { origin: "https://instance.example", registrationId: "registration", target: { kind: "thread", threadId: "thread" } } });
  expect(JSON.stringify(payload)).not.toContain("secretHash");
});
test("only definitive device errors revoke, other APNs failures remain retryable or explicit", () => {
  expect(classifyAPNsResponse(200, "")).toEqual({ kind: "accepted" });
  expect(classifyAPNsResponse(410, '{"reason":"Unregistered","timestamp":1234}')).toEqual({ kind: "invalid-token", invalidatedAt: 1234 });
  expect(classifyAPNsResponse(400, '{"reason":"BadDeviceToken"}')).toEqual({ kind: "invalid-token" });
  expect(classifyAPNsResponse(403, '{"reason":"ExpiredProviderToken"}')).toEqual({ kind: "configuration-error" });
  expect(classifyAPNsResponse(413, '{"reason":"PayloadTooLarge"}')).toEqual({ kind: "invalid-payload" });
  expect(classifyAPNsResponse(429, "")).toEqual({ kind: "temporary", retryAfter: 30 });
  expect(classifyAPNsResponse(503, "")).toEqual({ kind: "temporary", retryAfter: 30 });
});
