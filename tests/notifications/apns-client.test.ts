import { afterEach, expect, test } from "bun:test";
import { APNsRegistrationStore, publishAPNs, registeredAPNsDevices, relayURL } from "../../src/notifications/apns";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mockFetch } from "../helpers/mock-fetch";
const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
async function store() { return new APNsRegistrationStore(join(await mkdtemp(join(tmpdir(), "apns-client-")), "registrations.json")); }
const id = "11111111-1111-4111-8111-111111111111"; const secret = "s".repeat(43);
test("setup counts an authorized APNs phone without disclosing its sending capability", async () => {
  const entries = await store();
  await entries.register("iphone", { registrationId: id, secret });
  await entries.register("revoked-phone", { registrationId: "22222222-2222-4222-8222-222222222222", secret });
  const deps = { store: entries, url: "https://relay.example", authorized: (deviceId: string) => deviceId === "iphone" };
  expect(await registeredAPNsDevices(deps)).toEqual(["iphone"]);
  expect(await registeredAPNsDevices({ ...deps, url: undefined })).toEqual([]);
  await entries.unregister("iphone");
  expect(await registeredAPNsDevices(deps)).toEqual([]);
});
test("the relay is configured locally, never from a client endpoint", () => {
  expect(relayURL("https://relay.example")).toBe("https://relay.example");
  expect(relayURL("http://relay.example")).toBeUndefined();
  expect(relayURL("https://user:pass@relay.example")).toBeUndefined();
  expect(relayURL("https://relay.example/path")).toBeUndefined();
});
test("foreground filtering, transient retry and permanent revocation use the registered capability", async () => {
  const entries = await store(); await entries.register("device", { registrationId: id, secret });
  let calls = 0; const delays: number[] = [];
  restores.push(mockFetch(async (input, init) => {
    expect(String(input)).toBe(`https://relay.example/v1/registrations/${id}/publish`);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer " + secret);
    calls++; return calls === 1 ? new Response(null, { status: 503, headers: { "Retry-After": "2" } }) : new Response(null, { status: 202 });
  }).restore);
  const message = { title: "t", body: "b", target: { kind: "thread" as const, threadId: "t" } };
  const deps = { store: entries, url: "https://relay.example", wait: async (ms: number) => { delays.push(ms); } };
  expect(await publishAPNs(message, { skipDevice: async () => true }, deps)).toBe(0); expect(calls).toBe(0);
  expect(await publishAPNs(message, undefined, deps)).toBe(1); expect(delays).toEqual([2000]);
  restores.push(mockFetch(async () => new Response(null, { status: 410 })).restore);
  expect(await publishAPNs(message, undefined, deps)).toBe(0); expect(await entries.entries()).toEqual([]);
});
test("an old failed request cannot remove a replacement registration", async () => {
  const entries = await store(); await entries.register("device", { registrationId: id, secret });
  restores.push(mockFetch(async () => { await entries.register("device", { registrationId: "22222222-2222-4222-8222-222222222222", secret }); return new Response(null, { status: 410 }); }).restore);
  await publishAPNs({ title: "t", body: "b", target: { kind: "thread", threadId: "t" } }, undefined, { store: entries, url: "https://relay.example", wait: async () => {} });
  expect((await entries.entries())[0]?.registration.registrationId).toStartWith("22222222");
});
test("revocation during a temporary error stops retries even if the capability remains on disk", async () => {
  const entries = await store(); await entries.register("device", { registrationId: id, secret });
  let enabled = false; let calls = 0;
  restores.push(mockFetch(async () => { calls++; return new Response(null, { status: 503 }); }).restore);
  const deps = { store: entries, url: "https://relay.example", authorized: () => enabled, wait: async () => { enabled = false; } };
  const message = { title: "t", body: "b", target: { kind: "thread" as const, threadId: "t" } };
  expect(await publishAPNs(message, undefined, deps)).toBe(0); expect(calls).toBe(0);
  enabled = true;
  expect(await publishAPNs(message, undefined, deps)).toBe(0); expect(calls).toBe(1);
  expect(await entries.entries()).toHaveLength(1);
});
test("revocation during the final storage read prevents a new HTTP publication", async () => {
  const entries = await store(); await entries.register("device", { registrationId: id, secret });
  let enabled = true; let calls = 0; let reads = 0;
  const read = entries.entries.bind(entries);
  entries.entries = async () => { const value = await read(); if (++reads === 2) enabled = false; return value; };
  restores.push(mockFetch(async () => { calls++; return new Response(null, { status: 202 }); }).restore);
  expect(await publishAPNs({ title: "t", body: "b", target: { kind: "thread", threadId: "t" } }, undefined,
    { store: entries, url: "https://relay.example", authorized: () => enabled, wait: async () => {} })).toBe(0);
  expect(calls).toBe(0);
});
