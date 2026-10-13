import { describe, test, expect, beforeEach } from "bun:test";
import {
  consumeClaim,
  normalizeClaimCode,
  openClaim,
  pendingClaims,
  resetClaims,
  setClaimClock,
} from "../../src/nodes/claims.ts";

beforeEach(() => {
  resetClaims();
});

describe("node claims", () => {
  test("a code is consumed once, and its name rides along", () => {
    const opened = openClaim({ name: "web01" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.code).toMatch(/^[0-9A-Z]{8}$/);

    const first = consumeClaim(opened.code);
    expect(first).toEqual({ ok: true, name: "web01" });
    expect(consumeClaim(opened.code)).toEqual({ ok: false, reason: "used" });
    expect(pendingClaims()).toBe(0);
  });

  test("a claim without a name leaves the hostname to fill it", () => {
    const opened = openClaim({});
    if (!opened.ok) throw new Error("open failed");
    expect(consumeClaim(opened.code)).toEqual({ ok: true });
  });

  test("codes read off a screen survive confusable characters and spacing", () => {
    const opened = openClaim({});
    if (!opened.ok) throw new Error("open failed");
    const messy = `${opened.code.slice(0, 4).toLowerCase()}-${opened.code.slice(4)}`;
    expect(normalizeClaimCode(messy)).toBe(opened.code);
    expect(consumeClaim(messy).ok).toBe(true);
  });

  test("an expired code is refused, and says why", () => {
    let now = 1_000_000;
    setClaimClock(() => now);
    const opened = openClaim({ ttlSeconds: 60 });
    if (!opened.ok) throw new Error("open failed");
    now += 61_000;
    expect(consumeClaim(opened.code)).toEqual({ ok: false, reason: "expired" });
  });

  test("an unknown code and a consumed one are told apart", () => {
    expect(consumeClaim("ABCD2345")).toEqual({ ok: false, reason: "unknown" });
    const opened = openClaim({});
    if (!opened.ok) throw new Error("open failed");
    consumeClaim(opened.code);
    expect(consumeClaim(opened.code)).toEqual({ ok: false, reason: "used" });
  });

  test("the per-IP window refuses a hammered caller without burning the code", () => {
    const opened = openClaim({});
    if (!opened.ok) throw new Error("open failed");
    for (let i = 0; i < 10; i++) {
      expect(consumeClaim("ZZZZ9999", "10.0.0.1").ok).toBe(false);
    }
    // Eleventh hit of the window: throttled, even for a valid code.
    expect(consumeClaim(opened.code, "10.0.0.1")).toEqual({ ok: false, reason: "attempts" });
    // A caller from elsewhere still claims it.
    expect(consumeClaim(opened.code, "10.0.0.2").ok).toBe(true);
  });

  test("the open path is rate-limited too", () => {
    for (let i = 0; i < 10; i++) expect(openClaim({ ip: "10.0.0.1" }).ok).toBe(true);
    const refused = openClaim({ ip: "10.0.0.1" });
    expect(refused.ok).toBe(false);
    expect(openClaim({ ip: "10.0.0.2" }).ok).toBe(true);
  });
});
