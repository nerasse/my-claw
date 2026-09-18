import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  validChannelName,
} from "../../src/notifications/push.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
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

test("validChannelName accepts the names the app derives and refuses everything else", () => {
  assert.equal(validChannelName("runs"), true);
  assert.equal(validChannelName("ring-3f9a"), true);
  assert.equal(validChannelName("a"), true);
  // The cap is 41 characters including the leading letter.
  assert.equal(validChannelName(`a${"b".repeat(40)}`), true);
  assert.equal(validChannelName(`a${"b".repeat(41)}`), false);
  assert.equal(validChannelName("Ring"), false);
  assert.equal(validChannelName("ring/../x"), false);
  assert.equal(validChannelName(""), false);
  assert.equal(validChannelName("x".repeat(60)), false);
  assert.equal(validChannelName("runs "), false);
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

  const outcome = await publishNotification({
    title: "Nightly digest",
    body: "Run finished",
    url: "myclaw://thread/t1",
  });

  assert.deepEqual(outcome, { delivered: 2, rang: false });
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

test("a ring names the louder channel the app pre-creates, not the ordinary one", () => {
  const plain = JSON.parse(buildPushPayload({ title: "t", body: "b" }));
  const rung = JSON.parse(buildPushPayload({ title: "t", body: "b", ring: true }));
  assert.equal(plain.type, "runs");
  assert.equal(rung.type, "ring");
});

test("buildPushPayload takes the device's own channel when given, and keeps the defaults without one", () => {
  const ordinary = JSON.parse(buildPushPayload({ title: "t", body: "b" }, { channel: "quiet-1a2b" }));
  const ring = JSON.parse(buildPushPayload({ title: "t", body: "b", ring: true }, { channel: "ring-abc" }));
  assert.equal(ordinary.type, "quiet-1a2b");
  assert.equal(ring.type, "ring-abc");
  // The two-argument call stays the app's default pair, pre-created on every device.
  assert.equal(JSON.parse(buildPushPayload({ title: "t", body: "b" })).type, "runs");
  assert.equal(JSON.parse(buildPushPayload({ title: "t", body: "b", ring: true })).type, "ring");
});

test("setChannels stores a device's sound selection beside its endpoint and leaves the rest alone", async () => {
  await resetPushState();
  await endpointStore.register("dev-1", { endpoint: "https://push.example/up/one", ...SUB_KEYS, updatedAt: "t1" });
  await endpointStore.setChannels("dev-1", { ordinary: "quiet-1a2b", ring: "ring-abc" });

  const [entry] = await endpointStore.endpoints();
  assert.equal(entry?.deviceId, "dev-1");
  assert.deepEqual(entry?.endpoint.channels, { ordinary: "quiet-1a2b", ring: "ring-abc" });
  assert.equal(entry?.endpoint.endpoint, "https://push.example/up/one");
  assert.equal(entry?.endpoint.pubKey, SUB_KEYS.pubKey);
  assert.equal(entry?.endpoint.auth, SUB_KEYS.auth);
  assert.equal(entry?.endpoint.updatedAt, "t1");

  // Persisted on disk next to the endpoint: what the next publish reads.
  const raw = JSON.parse(await readFile(join(MY_CLAW_DIR, "push", "endpoints.json"), "utf8")) as Record<string, { channels?: unknown }>;
  assert.deepEqual(raw["dev-1"]?.channels, { ordinary: "quiet-1a2b", ring: "ring-abc" });

  // A device that never registered has nothing to attach a choice to: no ghost entry.
  await endpointStore.setChannels("dev-ghost", { ordinary: "quiet" });
  assert.deepEqual((await endpointStore.endpoints()).map((e) => e.deviceId), ["dev-1"]);
});

test("an invalid channel name is ignored: the stored selection does not move", async () => {
  await resetPushState();
  await endpointStore.register("dev-1", { endpoint: "https://push.example/up/one", ...SUB_KEYS, updatedAt: "t" });
  await endpointStore.setChannels("dev-1", { ring: "ring-abc" });
  const before = await readFile(join(MY_CLAW_DIR, "push", "endpoints.json"), "utf8");

  await endpointStore.setChannels("dev-1", { ring: "Ring" });
  assert.equal(await readFile(join(MY_CLAW_DIR, "push", "endpoints.json"), "utf8"), before);

  // In a mixed frame the valid name is kept and the invalid one dropped.
  await endpointStore.setChannels("dev-1", { ordinary: "quiet", ring: "ring/../x" });
  const [entry] = await endpointStore.endpoints();
  assert.deepEqual(entry?.endpoint.channels, { ordinary: "quiet" });
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

  assert.equal((await publishNotification({ title: "t", body: "b" })).delivered, 0);
  assert.equal(calls, 0);
  mocked.restore();
});

test("a gone subscription (404/410) is unregistered instead of retried forever", async () => {
  await resetPushState();
  const mocked = mockFetch(() => Promise.resolve(new Response("gone", { status: 410 })));
  await endpointStore.register("dev-1", { endpoint: "https://push.example/up/one", ...SUB_KEYS, updatedAt: "t" });

  assert.equal((await publishNotification({ title: "t", body: "b" })).delivered, 0);
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

  const outcome = await publishNotification(
    { title: "t", body: "b", url: "myclaw://thread/t1" },
    { skipDevice: (deviceId) => isForegroundOn(deviceId, "t1") },
  );
  assert.equal(outcome.delivered, 1);
  assert.deepEqual(urls, ["https://push.example/up/two"]);
  mocked.restore();
});

test("a ring resolves the type per device: the sound it picked, else the default", async () => {
  await resetPushState();
  await endpointStore.register("dev-1", { endpoint: "https://push.example/up/one", ...SUB_KEYS, updatedAt: "t" });
  await endpointStore.register("dev-2", { endpoint: "https://push.example/up/two", ...SUB_KEYS, updatedAt: "t" });
  await endpointStore.setChannels("dev-1", { ring: "ring-abc" });

  // The body is encrypted on the wire (RFC 8291), so the type a device ends up carrying is
  // asserted where publishNotification decides it: buildPushPayload with the device's channel,
  // and the stored selections the per-device build reads.
  const picked = JSON.parse(buildPushPayload({ title: "t", body: "b", ring: true }, { channel: "ring-abc" }));
  const fallback = JSON.parse(buildPushPayload({ title: "t", body: "b", ring: true }));
  assert.equal(picked.type, "ring-abc");
  assert.equal(fallback.type, "ring");

  const targets = await endpointStore.endpoints();
  assert.equal(targets.find((t) => t.deviceId === "dev-1")?.endpoint.channels?.ring, "ring-abc");
  assert.equal(targets.find((t) => t.deviceId === "dev-2")?.endpoint.channels, undefined);

  // Both devices still get the ring: the sound is per device, the cooldown decision is one.
  const mocked = mockFetch(() => Promise.resolve(new Response("ok", { status: 200 })));
  assert.deepEqual(await publishNotification({ title: "t", body: "b", ring: true }), { delivered: 2, rang: true });
  mocked.restore();
});

test("publishNotification with no endpoints is a no-op, and a rejected endpoint never throws", async () => {
  await resetPushState();
  const mocked = mockFetch(() => Promise.resolve(new Response("denied", { status: 401 })));
  await endpointStore.register("dev-1", { endpoint: "https://push.example/up/one", ...SUB_KEYS, updatedAt: "t" });
  const outcome = await publishNotification({ title: "t", body: "b" });
  assert.equal(outcome.delivered, 0);
  mocked.restore();

  await endpointStore.unregister("dev-1");
  assert.equal((await publishNotification({ title: "t", body: "b" })).delivered, 0);
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
