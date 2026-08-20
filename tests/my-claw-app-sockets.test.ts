import { test, describe, expect } from "bun:test";
import assert from "node:assert/strict";
import { SocketRegistry } from "../src/channels/my-claw-app/socket-registry.ts";
import type { MyClawAppSessionData } from "../src/channels/my-claw-app/controllers.ts";

interface FakeSocket {
  data: MyClawAppSessionData;
  closed: Array<{ code: number; reason: string }>;
  close(code: number, reason: string): void;
}

let seq = 0;

function socket(deviceId: string, owner = "neras"): FakeSocket {
  const closed: Array<{ code: number; reason: string }> = [];
  return {
    // The registry only ever reads deviceId and owner; the rest of the session data is the
    // adapter's business.
    data: { deviceId, owner, lastSeen: Date.now(), id: `s${++seq}` } as unknown as MyClawAppSessionData,
    closed,
    close(code: number, reason: string) {
      closed.push({ code, reason });
    },
  };
}

function registryOf(sockets: FakeSocket[]): SocketRegistry {
  const registry = new SocketRegistry();
  for (const ws of sockets) registry.add(ws as never);
  return registry;
}

describe("SocketRegistry", () => {
  test("one device keeps every surface it opens", () => {
    // The regression this exists for: two tabs of one browser profile are one device id, and the
    // second used to close the first.
    const tabs = [socket("web-1"), socket("web-1"), socket("web-1")];
    const registry = registryOf(tabs);

    assert.equal(registry.countFor("web-1"), 3);
    assert.equal(registry.size, 3);
    for (const tab of tabs) assert.deepEqual(tab.closed, [], "no surface is evicted by another");
  });

  test("removing one surface leaves the others alone", () => {
    const [first, second] = [socket("web-1"), socket("web-1")];
    const registry = registryOf([first, second]);

    assert.equal(registry.remove(first as never), true);
    assert.equal(registry.countFor("web-1"), 1);
    assert.equal(registry.has(second as never), true);
    assert.equal(registry.has(first as never), false);
    // Idempotent: a close event can arrive twice for one socket.
    assert.equal(registry.remove(first as never), false);
  });

  test("a device with no surface left is forgotten, not kept as an empty group", () => {
    const only = socket("phone-1");
    const registry = registryOf([only]);
    registry.remove(only as never);

    assert.deepEqual(registry.deviceIds(), []);
    assert.equal(registry.countFor("phone-1"), 0);
  });

  test("an owner's surfaces span their devices, and stop at their own", () => {
    const mine = [socket("web-1"), socket("web-1"), socket("phone-1")];
    const other = socket("web-9", "someone-else");
    const registry = registryOf([...mine, other]);

    assert.equal(registry.forOwner("neras").length, 3);
    assert.equal(registry.forOwner("someone-else").length, 1);
    assert.equal(registry.all().length, 4);
  });

  test("closing a device takes all of its surfaces, and only its own", () => {
    const doomed = [socket("web-1"), socket("web-1")];
    const kept = socket("phone-1");
    const registry = registryOf([...doomed, kept]);

    assert.equal(registry.closeDevice("web-1", 1008, "revoked"), 2);

    for (const ws of doomed) assert.deepEqual(ws.closed, [{ code: 1008, reason: "revoked" }]);
    assert.deepEqual(kept.closed, []);
    assert.equal(registry.countFor("web-1"), 0);
    assert.equal(registry.countFor("phone-1"), 1);
  });

  test("closing an unknown device is a no-op, not a throw", () => {
    const registry = registryOf([socket("web-1")]);
    expect(registry.closeDevice("nobody", 1008, "revoked")).toBe(0);
    assert.equal(registry.size, 1);
  });

  test("a socket that throws on close does not stop the others from closing", () => {
    const angry = socket("web-1");
    angry.close = () => {
      throw new Error("already gone");
    };
    const calm = socket("web-1");
    const registry = registryOf([angry, calm]);

    assert.equal(registry.closeDevice("web-1", 1001, "stale"), 2);
    assert.deepEqual(calm.closed, [{ code: 1001, reason: "stale" }]);
  });

  test("clear drops everything without closing anything", () => {
    const ws = socket("web-1");
    const registry = registryOf([ws]);
    registry.clear();

    assert.equal(registry.size, 0);
    assert.deepEqual(ws.closed, [], "shutdown closes sockets itself, before clearing");
  });
});
