import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  loadOrCreateVapid,
  endpointStore,
  foregroundStore,
  publishNotification,
  isForegroundOn,
  resetPushState,
} from "../../src/notifications/push.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

// The stores persist to the temp MY_CLAW_DIR; resetPushState() (also wired in
// setup-globals.ts) clears them between tests.

test("loadOrCreateVapid generates a stable web-push application-server key", async () => {
  const first = await loadOrCreateVapid();
  // Public key: raw P-256 point (0x04 || X || Y) = 65 bytes, base64url.
  assert.equal(Buffer.from(first.publicKey, "base64url").length, 65);
  assert.equal(Buffer.from(first.privateKey, "base64url").length, 32);

  // Stable across boots: the second call reads the same file.
  const second = await loadOrCreateVapid();
  assert.equal(second.publicKey, first.publicKey);
  assert.equal(second.privateKey, first.privateKey);
});

test("endpointStore registers, lists and unregisters per device", async () => {
  await resetPushState();
  await endpointStore.register("dev-1", { endpoint: "https://push.example/up/secret", updatedAt: "t1" });
  await endpointStore.register("dev-2", { endpoint: "https://push.example/up/other", updatedAt: "t2" });
  const all = await endpointStore.endpoints();
  assert.equal(all.length, 2);

  await endpointStore.unregister("dev-1");
  const after = await endpointStore.endpoints();
  assert.deepEqual(after.map((e) => e.deviceId), ["dev-2"]);
});

test("foregroundStore tracks the device state and isForegroundOn matches only the same thread", async () => {
  await resetPushState();
  await foregroundStore.set("dev-1", { foreground: true, threadId: "t1" });
  assert.equal(await isForegroundOn("dev-1", "t1"), true);
  assert.equal(await isForegroundOn("dev-1", "t2"), false);
  await foregroundStore.set("dev-1", { foreground: false });
  assert.equal(await isForegroundOn("dev-1", "t1"), false);
});

// A registration always carries the keys the connector generated; these are a real pair so
// web-push can actually encrypt against them.
const SUB_KEYS = {
  pubKey: "BL4V3Dus18yzlGuLrjd-st4VlRaWvdY7oCNkxgEGIUctWbZjh9zHYdqjodOFXOABzanFmGcUtn0Y131wy8hHDEk",
  auth: "alrZHgX8MDe_DISRVbWZ1A",
};

test("publishNotification encrypts the payload: the connector drops anything it cannot decrypt", async () => {
  await resetPushState();
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const mocked = mockFetch((url, init) => {
    calls.push({ url: String(url), body: init?.body, headers: (init?.headers ?? {}) as Record<string, string> });
    return Promise.resolve(new Response("ok", { status: 200 }));
  });
  await endpointStore.register("dev-1", { endpoint: "https://push.example/up/one", ...SUB_KEYS, updatedAt: "t" });
  await endpointStore.register("dev-2", { endpoint: "https://push.example/up/two", ...SUB_KEYS, updatedAt: "t" });

  const delivered = await publishNotification({
    title: "Nightly digest",
    body: "Run finished",
    url: "myclaw://thread/t1",
  });

  assert.equal(delivered, 2);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    // RFC 8291 body: binary, and never the plaintext JSON.
    assert.ok(call.body instanceof Uint8Array || Buffer.isBuffer(call.body));
    assert.ok(!Buffer.from(call.body as Uint8Array).toString("utf8").includes("Nightly digest"));
    assert.equal(call.headers["Content-Encoding"], "aes128gcm");
    assert.ok(String(call.headers["Authorization"] ?? "").startsWith("vapid"));
  }
  mocked.restore();
});

test("an endpoint without encryption keys is skipped rather than sent in the clear", async () => {
  await resetPushState();
  let calls = 0;
  const mocked = mockFetch(() => {
    calls += 1;
    return Promise.resolve(new Response("ok", { status: 200 }));
  });
  await endpointStore.register("dev-legacy", { endpoint: "https://push.example/up/legacy", updatedAt: "t" });

  assert.equal(await publishNotification({ title: "t", body: "b" }), 0);
  assert.equal(calls, 0);
  mocked.restore();
});

test("a gone subscription (404/410) is unregistered instead of retried forever", async () => {
  await resetPushState();
  const mocked = mockFetch(() => Promise.resolve(new Response("gone", { status: 410 })));
  await endpointStore.register("dev-1", { endpoint: "https://push.example/up/one", ...SUB_KEYS, updatedAt: "t" });

  assert.equal(await publishNotification({ title: "t", body: "b" }), 0);
  assert.deepEqual(await endpointStore.endpoints(), []);
  mocked.restore();
});

test("publishNotification skips a device foreground on the same thread", async () => {
  await resetPushState();
  const urls: string[] = [];
  const mocked = mockFetch((url, init) => {
    urls.push(String(url));
    return Promise.resolve(new Response("ok", { status: 200 }));
  });
  await endpointStore.register("dev-1", { endpoint: "https://push.example/up/one", ...SUB_KEYS, updatedAt: "t" });
  await endpointStore.register("dev-2", { endpoint: "https://push.example/up/two", ...SUB_KEYS, updatedAt: "t" });
  await foregroundStore.set("dev-1", { foreground: true, threadId: "t1" });

  const delivered = await publishNotification(
    { title: "t", body: "b", url: "myclaw://thread/t1" },
    { skipDevice: (deviceId) => isForegroundOn(deviceId, "t1") },
  );
  assert.equal(delivered, 1);
  assert.deepEqual(urls, ["https://push.example/up/two"]);
  mocked.restore();
});

test("publishNotification with no endpoints is a no-op, and a rejected endpoint never throws", async () => {
  await resetPushState();
  const mocked = mockFetch(() => Promise.resolve(new Response("denied", { status: 401 })));
  await endpointStore.register("dev-1", { endpoint: "https://push.example/up/one", ...SUB_KEYS, updatedAt: "t" });
  const delivered = await publishNotification({ title: "t", body: "b" });
  assert.equal(delivered, 0);
  mocked.restore();

  await endpointStore.unregister("dev-1");
  assert.equal(await publishNotification({ title: "t", body: "b" }), 0);
});
