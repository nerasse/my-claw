import { describe, test, expect, afterEach } from "bun:test";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_PATH, MY_CLAW_DIR, type MyClawAppChannelConfig } from "../../src/core/config.ts";
import {
  mintDevice,
  listDevices,
  revokeDevice,
  setDeviceEnabled,
  ownerOf,
  defaultOwner,
} from "../../src/channels/my-claw-app/devices.ts";
import {
  openSession,
  createTicket,
  approve,
  deny,
  claim,
  lookup,
  normalizeCode,
  pendingSessions,
  setPairingClock,
  type PairingDelivery,
  type PairingDenial,
} from "../../src/channels/my-claw-app/pairing.ts";
import { pairRedirect } from "../../src/channels/my-claw-app/web.ts";
import {
  createGrant,
  redeemGrant,
  deviceOfSession,
  revokeSessionsOfDevice,
  sessionCookie,
  readCookie,
  SESSION_COOKIE,
} from "../../src/channels/my-claw-app/web-session.ts";

const PAIRING_ON: MyClawAppChannelConfig = { pairing: { enabled: true } };

async function writeConfigFile(channel: MyClawAppChannelConfig = {}): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(
    CONFIG_PATH,
    `${JSON.stringify({ whitelist: ["u1"], channels: { "my-claw-app": channel } }, null, 2)}\n`,
  );
}

async function devicesOnDisk(): Promise<Record<string, Record<string, unknown>>> {
  const raw = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  return raw.channels["my-claw-app"].devices ?? {};
}

/** Collects what a pairing socket would receive, without a socket. */
function recorder() {
  const delivered: PairingDelivery[] = [];
  const rejected: PairingDenial[] = [];
  return {
    delivered,
    rejected,
    deliver: (delivery: PairingDelivery) => delivered.push(delivery),
    reject: (reason: PairingDenial) => rejected.push(reason),
  };
}

afterEach(async () => {
  await rm(CONFIG_PATH, { force: true });
  // Sessions survive a restart by design, so the store outlives resetWebSessions and would carry
  // one test's sessions into the next.
  await rm(join(MY_CLAW_DIR, "web-sessions.json"), { force: true });
});

describe("devices", () => {
  test("mint writes the device to the config file and never reuses an id or a token", async () => {
    await writeConfigFile();
    const first = await mintDevice({}, { name: "Firefox laptop", owner: "neras" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const written = await devicesOnDisk();
    const entry = written[first.device.deviceId]!;
    expect(entry.name).toBe("Firefox laptop");
    expect(entry.owner).toBe("neras");
    expect(entry.kind).toBe("web");
    expect(entry.enabled).toBe(true);
    expect(String(entry.createdAt)).toMatch(/^\d{4}-/);
    expect(first.device.deviceId).toStartWith("web-");
    expect(first.device.token.length).toBeGreaterThan(32);

    const second = await mintDevice(
      { devices: { [first.device.deviceId]: { token: first.device.token, owner: "neras" } } },
      { name: "Chrome desktop", owner: "neras" },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.device.deviceId).not.toBe(first.device.deviceId);
    expect(second.device.token).not.toBe(first.device.token);
    expect(Object.keys(await devicesOnDisk())).toHaveLength(2);
  });

  test("an owner is inherited when there is one, and refused when there are several", async () => {
    const single: MyClawAppChannelConfig = { devices: { "app-1": { token: "t", owner: "neras" } } };
    expect(defaultOwner(single)).toEqual({ ok: true, owner: "neras" });

    const many: MyClawAppChannelConfig = {
      devices: { "app-1": { token: "t", owner: "neras" }, "app-2": { token: "t", owner: "other" } },
    };
    const resolved = defaultOwner(many);
    expect(resolved.ok).toBe(false);

    await writeConfigFile(many);
    const minted = await mintDevice(many, { name: "browser" });
    expect(minted.ok).toBe(false);
  });

  test("a device without an owner stands on its own id", () => {
    expect(ownerOf({ devices: { "app-1": { token: "t" } } }, "app-1")).toBe("app-1");
    expect(ownerOf({}, "unknown")).toBe("unknown");
  });

  test("revoking is idempotent and disabling keeps the entry", async () => {
    await writeConfigFile({ devices: { "web-1": { token: "t", owner: "neras", enabled: true } } });
    const config: MyClawAppChannelConfig = { devices: { "web-1": { token: "t", owner: "neras" } } };

    expect(await setDeviceEnabled(config, "web-1", false)).toEqual({ ok: true });
    expect((await devicesOnDisk())["web-1"]!.enabled).toBe(false);
    expect(await setDeviceEnabled(config, "nope", false)).toMatchObject({ ok: false });

    expect(await revokeDevice("web-1")).toEqual({ ok: true });
    expect(await devicesOnDisk()).toEqual({});
    expect(await revokeDevice("web-1")).toEqual({ ok: true });
  });

  test("an unparsable config refuses the write instead of overwriting it", async () => {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, "{ not json");
    const minted = await mintDevice({}, { name: "browser", owner: "neras" });
    expect(minted.ok).toBe(false);
    expect(await readFile(CONFIG_PATH, "utf-8")).toBe("{ not json");
  });

  test("listing exposes no token", async () => {
    const config: MyClawAppChannelConfig = {
      devices: { "app-1": { token: "secret", name: "Pixel", owner: "neras" } },
    };
    const [device] = listDevices(config);
    expect(JSON.stringify(device)).not.toContain("secret");
    expect(device).toMatchObject({ deviceId: "app-1", name: "Pixel", owner: "neras", enabled: true });
  });
});

describe("pairing", () => {
  test("the surface does not exist until it is enabled", () => {
    const sink = recorder();
    expect(openSession({}, { kind: "web", ...sink }).ok).toBe(false);
    expect(openSession({ pairing: { enabled: false } }, { kind: "web", ...sink }).ok).toBe(false);
  });

  test("a code is typable: no ambiguous letters, and lookups fold what a human types", () => {
    const sink = recorder();
    const opened = openSession(PAIRING_ON, { kind: "web", ...sink });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(opened.session.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(opened.session.verification).toMatch(/^\d{3}$/);
    expect(normalizeCode(` ${opened.session.code.toLowerCase()} `)).toBe(opened.session.code);
    // I and L are read as 1, O as 0, U as V: the four characters a human confuses on a screen.
    expect(normalizeCode("ilou-1234")).toBe("110V1234");
  });

  test("an approved browser receives a grant and never the token", async () => {
    await writeConfigFile();
    const sink = recorder();
    const opened = openSession(PAIRING_ON, { kind: "web", ip: "10.0.0.9", ...sink });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const approved = await approve(PAIRING_ON, opened.session.code, {
      name: "Firefox laptop",
      owner: "neras",
      approver: "app-1",
    });
    expect(approved.ok).toBe(true);
    expect(sink.delivered).toHaveLength(1);
    expect(sink.delivered[0]!.grant).toBeString();
    expect(sink.delivered[0]!.token).toBeUndefined();
    expect(sink.delivered[0]!.owner).toBe("neras");
    // The session is gone with the delivery: a credential is never handed out twice.
    expect(pendingSessions()).toBe(0);
  });

  test("a native client is given the token, since it holds no cookie jar", async () => {
    await writeConfigFile();
    const sink = recorder();
    const opened = openSession(PAIRING_ON, { kind: "native", ...sink });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    await approve(PAIRING_ON, opened.session.code, { name: "Pixel", owner: "neras", approver: "app-1" });
    expect(sink.delivered[0]!.token).toBeString();
    expect(sink.delivered[0]!.grant).toBeUndefined();
  });

  test("denying is terminal and tells the waiting client why", () => {
    const sink = recorder();
    const opened = openSession(PAIRING_ON, { kind: "web", ...sink });
    if (!opened.ok) return;

    expect(deny(opened.session.code, "app-1")).toBe(true);
    expect(sink.rejected).toEqual(["denied"]);
    expect(deny(opened.session.code, "app-1")).toBe(false);
    expect(pendingSessions()).toBe(0);
  });

  test("a challenge expires on its own clock, without anybody sleeping", () => {
    let time = 1_000_000;
    setPairingClock(() => time);
    const sink = recorder();
    const opened = openSession({ pairing: { enabled: true, ttlSeconds: 120 } }, { kind: "web", ...sink });
    if (!opened.ok) return;

    time += 119_000;
    expect(lookup(opened.session.code).ok).toBe(true);
    time += 2_000;
    // Expired, and said so: a code that ran out and a code that never existed answering the same
    // "unknown" is what had the owner retyping a dead code believing they had mistyped it.
    expect(lookup(opened.session.code)).toMatchObject({ ok: false, reason: "expired" });
    expect(lookup("ZZZZZZZZ")).toMatchObject({ ok: false, reason: "unknown" });
    expect(sink.rejected).toEqual(["expired"]);
  });

  test("guessing a code is capped, and the cap kills the session", () => {
    const sink = recorder();
    const opened = openSession(PAIRING_ON, { kind: "web", ...sink });
    if (!opened.ok) return;

    for (let attempt = 0; attempt < 5; attempt++) {
      expect(lookup(opened.session.code).ok).toBe(true);
    }
    expect(lookup(opened.session.code)).toMatchObject({ ok: false, reason: "attempts" });
    expect(sink.rejected).toEqual(["attempts"]);
  });

  test("a CLI ticket is claimed once and only once", () => {
    const ticket = createTicket(PAIRING_ON, {
      deviceId: "web-abc",
      owner: "neras",
      name: "Firefox laptop",
      token: "the-token",
    });

    const claimed = claim(ticket.code, "web");
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.delivery.deviceId).toBe("web-abc");
    expect(claimed.delivery.grant).toBeString();
    expect(claimed.delivery.token).toBeUndefined();

    expect(claim(ticket.code, "web")).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("a ticket claimed by a native client carries the token it was minted with", () => {
    const ticket = createTicket(PAIRING_ON, {
      deviceId: "app-abc",
      owner: "neras",
      name: "Pixel",
      token: "the-token",
    });
    const claimed = claim(ticket.code, "native");
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.delivery.token).toBe("the-token");
  });

  test("one IP cannot open pairing sessions forever", () => {
    const sink = recorder();
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(openSession(PAIRING_ON, { kind: "web", ip: "10.0.0.9", ...sink }).ok).toBe(true);
    }
    expect(openSession(PAIRING_ON, { kind: "web", ip: "10.0.0.9", ...sink }).ok).toBe(false);
    // Another address is unaffected: the limit is per client, not global.
    expect(openSession(PAIRING_ON, { kind: "web", ip: "10.0.0.10", ...sink }).ok).toBe(true);
  });
});

describe("web sessions", () => {
  test("a grant is single use and turns into a cookie that carries no token", async () => {
    const grant = createGrant("web-1");
    const redeemed = await redeemGrant(grant, "Firefox");
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    expect(redeemed.sessionId).not.toContain("web-1");
    expect(deviceOfSession(redeemed.sessionId)).toBe("web-1");
    expect(await redeemGrant(grant)).toMatchObject({ ok: false });
  });

  test("an unknown cookie authenticates nothing", () => {
    expect(deviceOfSession("not-a-session")).toBeNull();
    expect(deviceOfSession(null)).toBeNull();
  });

  test("revoking a device drops the browser sessions it opened", async () => {
    const redeemed = await redeemGrant(createGrant("web-1"));
    const other = await redeemGrant(createGrant("web-2"));
    expect(redeemed.ok && other.ok).toBe(true);
    if (!redeemed.ok || !other.ok) return;

    expect(await revokeSessionsOfDevice("web-1")).toBe(1);
    expect(deviceOfSession(redeemed.sessionId)).toBeNull();
    expect(deviceOfSession(other.sessionId)).toBe("web-2");
  });

  test("Secure follows the scheme the browser actually used", () => {
    expect(sessionCookie("abc", true)).toContain("; Secure");
    expect(sessionCookie("abc", false)).not.toContain("Secure");
    for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/"]) {
      expect(sessionCookie("abc", false)).toContain(attribute);
    }
  });

  test("the cookie is read out of a header that holds several", () => {
    expect(readCookie(`theme=dark; ${SESSION_COOKIE}=abc; other=1`, SESSION_COOKIE)).toBe("abc");
    expect(readCookie("theme=dark", SESSION_COOKIE)).toBeNull();
    expect(readCookie(null, SESSION_COOKIE)).toBeNull();
  });
});

describe("deep links", () => {
  test("an unpaired link to a conversation comes back to it after pairing", () => {
    expect(pairRedirect("/t/thread-42")).toBe("/pair?next=%2Ft%2Fthread-42");
    expect(pairRedirect("/")).toBe("/pair");
  });

  test("the address that travels can only ever be one of ours", () => {
    // `//evil.example` is a protocol-relative URL: a browser reads it as another host.
    expect(pairRedirect("//evil.example/steal")).toBe("/pair");
    expect(pairRedirect("/\\evil.example")).toBe("/pair");
    expect(pairRedirect("https://evil.example")).toBe("/pair");
  });
});

describe("live config", () => {
  /**
   * The daemon writes config.json and watches it at the same time. Waiting for the watcher to
   * report your own write is a race, and it was lost in practice: a browser paired, then its
   * very next request was refused because the adapter's snapshot did not hold the new device.
   */
  test("a minted device is visible in the caller's config without waiting for a reload", async () => {
    await writeConfigFile({ devices: { "app-1": { token: "t", owner: "neras" } } });
    const live: MyClawAppChannelConfig = { devices: { "app-1": { token: "t", owner: "neras" } } };

    const minted = await mintDevice(live, { name: "Firefox laptop" });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    expect(live.devices?.[minted.device.deviceId]?.token).toBe(minted.device.token);
    expect(live.devices?.[minted.device.deviceId]?.enabled).toBe(true);
    expect(listDevices(live).map((device) => device.deviceId)).toContain(minted.device.deviceId);
  });

  test("revoking and disabling reach the same snapshot", async () => {
    await writeConfigFile({ devices: { "web-1": { token: "t", owner: "neras" } } });
    const live: MyClawAppChannelConfig = { devices: { "web-1": { token: "t", owner: "neras" } } };

    await setDeviceEnabled(live, "web-1", false);
    expect(live.devices?.["web-1"]?.enabled).toBe(false);

    await revokeDevice("web-1", live);
    expect(live.devices?.["web-1"]).toBeUndefined();
  });
});
