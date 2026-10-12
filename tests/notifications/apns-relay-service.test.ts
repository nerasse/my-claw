import { afterEach, expect, test } from "bun:test";
import { RelayService, sendingSecretHash } from "../../src/apns-relay/service";
import { RelayStore } from "../../src/apns-relay/storage";
import type { IntegrityVerifier } from "../../src/apns-relay/integrity";
import type { PublishOutcome } from "../../src/apns-relay/types";

const keyId = Buffer.alloc(32, 1).toString("base64");
const otherKey = Buffer.alloc(32, 2).toString("base64");
const stores: RelayStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function harness() {
  const store = new RelayStore(":memory:", "production"); stores.push(store);
  let counter = 0; let now = 1000; let outcome: PublishOutcome = { kind: "accepted" }; let sends = 0;
  const integrity: IntegrityVerifier = {
    attest(id) { return { keyId: id, publicKey: "fixture-public-key", environment: "production" }; },
    assertion(_, __, assertion) { if (assertion.toString() === "bad") throw new Error("invalid"); return ++counter; }
  };
  const service = new RelayService(store, integrity, { async send() { sends++; return outcome; } }, () => now);
  const request = (path: string, body: unknown, signedKey?: string, assertion = "fixture") => service.fetch(new Request("https://relay.example" + path, {
    method: "POST", headers: { "content-type": "application/json", ...(signedKey ? { "x-app-attest-key": signedKey,
      "x-app-attest-assertion": Buffer.from(assertion).toString("base64") } : {}) }, body: JSON.stringify(body)
  }), "127.0.0.1");
  async function challenge(purpose = "manage", id = keyId): Promise<string> {
    const response = await request("/v1/challenges", { purpose, keyId: id });
    return (await response.json() as { nonce: string }).nonce;
  }
  async function attest(id = keyId): Promise<void> {
    const nonce = await challenge("attest", id);
    expect((await request("/v1/attestations", { nonce, keyId: id, attestation: Buffer.from("fixture").toString("base64") })).status).toBe(204);
  }
  async function register(id = keyId): Promise<{ id: string; secret: string }> {
    const nonce = await challenge("manage", id);
    const response = await request("/v1/registrations", { nonce, origin: "https://instance.example", token: "a".repeat(64) }, id);
    expect(response.status).toBe(201);
    return await response.json() as { id: string; secret: string };
  }
  function publish(id: string, secret: string, body = "private preview") {
    return service.fetch(new Request(`https://relay.example/v1/registrations/${id}/publish`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + secret },
      body: JSON.stringify({ title: "MyClaw", body, target: { kind: "thread", threadId: "conversation" }, ring: false })
    }), "127.0.0.1");
  }
  return { store, request, challenge, attest, register, publish, sends: () => sends,
    clock: (value: number) => { now = value; }, outcome: (value: PublishOutcome) => { outcome = value; } };
}

test("attested enrollment returns only a scoped sending capability", async () => {
  const h = harness(); await h.attest(); const registration = await h.register();
  expect(registration.id).toBeString(); expect(registration.secret).toHaveLength(43);
  expect(h.store.registration(registration.id)?.secretHash).not.toBe(registration.secret);
  expect((await h.publish(registration.id, registration.secret)).status).toBe(202);
  expect(h.sends()).toBe(1);
});
test("a replayed, expired or invalid management assertion cannot enroll", async () => {
  const h = harness(); await h.attest();
  const nonce = await h.challenge();
  const payload = { nonce, origin: "https://instance.example", token: "a".repeat(64) };
  expect((await h.request("/v1/registrations", payload, keyId, "bad")).status).toBe(401);
  expect((await h.request("/v1/registrations", payload, keyId)).status).toBe(401);
  const expired = await h.challenge(); h.clock(200_000);
  expect((await h.request("/v1/registrations", { ...payload, nonce: expired }, keyId)).status).toBe(401);
});
test("another registration's secret cannot publish or authorize management", async () => {
  const h = harness(); await h.attest(); await h.attest(otherKey);
  const first = await h.register(); const second = await h.register(otherKey);
  expect((await h.publish(first.id, second.secret)).status).toBe(401);
  expect((await h.request(`/v1/registrations/${first.id}/revoke`, { nonce: await h.challenge("manage", otherKey) }, otherKey)).status).toBe(401);
  expect(h.store.registration(first.id)).not.toBeNull(); expect(h.sends()).toBe(0);
});
test("payload limits and APNs failures are explicit without persisting message content", async () => {
  const h = harness(); await h.attest(); const registration = await h.register();
  expect((await h.publish(registration.id, registration.secret, "x".repeat(10_000))).status).toBe(413);
  h.outcome({ kind: "temporary", retryAfter: 30 });
  const retry = await h.publish(registration.id, registration.secret);
  expect(retry.status).toBe(503); expect(retry.headers.get("retry-after")).toBe("30");
  expect(h.store.registration(registration.id)).not.toBeNull();
  h.outcome({ kind: "invalid-token" });
  expect((await h.publish(registration.id, registration.secret)).status).toBe(410);
  expect(h.store.registration(registration.id)).toBeNull();
});

test("an obsolete invalid-token response keeps the rotated registration publishable", async () => {
  const store = new RelayStore(":memory:", "production"); stores.push(store);
  store.addKey({ keyId, publicKey: "fixture-key", environment: "production", counter: 0 });
  const id = "11111111-1111-4111-8111-111111111111"; const secret = "s".repeat(43);
  store.register({ id, keyId, origin: "https://instance.example", token: "a".repeat(64), tokenUpdatedAt: 1000, secretHash: sendingSecretHash(secret), active: true });
  const service = new RelayService(store, { attest() { throw new Error(); }, assertion() { throw new Error(); } }, {
    async send() { store.updateToken(id, keyId, "b".repeat(64), 2000); return { kind: "invalid-token", invalidatedAt: 1500 }; }
  });
  const response = await service.fetch(new Request(`https://relay.example/v1/registrations/${id}/publish`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + secret },
    body: JSON.stringify({ title: "Title", body: "Preview", target: { kind: "thread", threadId: "thread" }, ring: false })
  }), "127.0.0.1");
  expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("1");
  expect(store.registration(id)?.token).toBe("b".repeat(64));
});
