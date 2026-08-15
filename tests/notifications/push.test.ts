import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  loadOrCreateVapid,
  endpointStore,
  foregroundStore,
  publishNotification,
  isForegroundOn,
  resetPushState,
  stripMarkdown,
  cleanNotificationText,
  buildPushPayload,
  notificationIdFor,
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

test("the payload carries the channel type the app pre-creates as IMPORTANCE_HIGH", async () => {
  const payload = JSON.parse(buildPushPayload({ title: "t", body: "b", url: "myclaw://thread/x" }));
  assert.equal(payload.type, "runs");
  assert.equal(payload.title, "t");
  assert.equal(payload.url, "myclaw://thread/x");
});

test("a notification that names a thread is addressable: same link, same id, and it fits an Android Int", () => {
  const first = JSON.parse(buildPushPayload({ title: "a", body: "1", url: "myclaw://thread/abc" }));
  const again = JSON.parse(buildPushPayload({ title: "b", body: "2", url: "myclaw://thread/abc" }));
  const other = JSON.parse(buildPushPayload({ title: "c", body: "3", url: "myclaw://thread/def" }));
  assert.equal(first.id, again.id);
  assert.notEqual(first.id, other.id);
  assert.equal(first.id, notificationIdFor("myclaw://thread/abc"));
  for (const id of [first.id, other.id]) {
    assert.ok(Number.isInteger(id) && id >= 0 && id <= 0x7fffffff, `id out of Int range: ${id}`);
  }
});

test("the id of a link is a fixed vector: the app recomputes it to dismiss the notification", () => {
  // Shared contract with notificationIdFor in the app (src/core/notifications.ts). These three
  // numbers are asserted on both sides: a drift here stops every dismissal, silently.
  assert.equal(notificationIdFor("myclaw://thread/abc"), 1185530383);
  assert.equal(notificationIdFor("myclaw://thread/from-notif"), 333754526);
  assert.equal(notificationIdFor("myclaw://job/job-1"), 253371665);
});

test("a notification with no link keeps a unique id: nothing could address it later anyway", () => {
  const first = JSON.parse(buildPushPayload({ title: "a", body: "1" }));
  const second = JSON.parse(buildPushPayload({ title: "a", body: "1" }));
  assert.notEqual(first.id, second.id);
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

test("stripMarkdown turns a markdown answer into plain text and keeps the bullet lines", () => {
  const markdown = [
    "# Summary",
    "",
    "The **digest** is ready: see `value` and the [link](https://example.com).",
    "",
    "- item one",
    "- item two",
    "",
    "> a quote",
    "```ts",
    "const x = 1;",
    "```",
  ].join("\n");
  const plain = stripMarkdown(markdown);
  assert.ok(plain.includes("The digest is ready: see value and the link."));
  assert.ok(plain.includes("- item one"));
  assert.ok(plain.includes("- item two"));
  assert.ok(!plain.includes("# Summary"));
  assert.ok(!plain.includes("**digest**"));
  assert.ok(!plain.includes("https://example.com"));
  assert.ok(!plain.includes("const x = 1;"));
  assert.ok(!plain.includes("> a quote"));
});

test("cleanNotificationText also drops the em dash from error texts", () => {
  assert.equal(
    cleanNotificationText("HTTP 429 — out of credits — retry later"),
    "HTTP 429: out of credits: retry later",
  );
});
