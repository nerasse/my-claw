import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayStore } from "../../src/apns-relay/storage";
import type { RelayRegistration } from "../../src/apns-relay/types";

const stores: RelayStore[] = [];
const directories: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function store(path = ":memory:"): RelayStore { const value = new RelayStore(path, "production"); stores.push(value); return value; }
function fixture(): RelayRegistration {
  return { id: "registration", keyId: "apple-key", origin: "https://instance.example", token: "fixture-token",
    secretHash: "fixture-hash", tokenUpdatedAt: 1000, active: true };
}
function registered(db: RelayStore): void {
  db.addKey({ keyId: "apple-key", publicKey: "fixture-public-key", counter: 0, environment: "production" });
  db.register(fixture());
}

describe("APNs relay durable boundaries", () => {
  test("challenges are consumed once and expire at their deadline", () => {
    const db = store();
    db.issueChallenge("one", "attest", "apple-key", 2000);
    expect(db.consumeChallenge("one", "attest", "apple-key", 1000)).toBe(true);
    expect(db.consumeChallenge("one", "attest", "apple-key", 1000)).toBe(false);
    db.issueChallenge("expired", "attest", "apple-key", 2000);
    expect(db.consumeChallenge("expired", "attest", "apple-key", 2000)).toBe(false);
  });
  test("a challenge cannot cross keys or operations", () => {
    const db = store(); db.issueChallenge("one", "manage", "apple-key", 2000);
    expect(db.consumeChallenge("one", "manage", "other-key", 1000)).toBe(false);
    expect(db.consumeChallenge("one", "attest", "apple-key", 1000)).toBe(false);
    expect(db.consumeChallenge("one", "manage", "apple-key", 1000)).toBe(true);
  });
  test("counter updates are monotonic and reject concurrent stale assertions", () => {
    const db = store(); registered(db);
    expect(db.advanceCounter("apple-key", 0, 1)).toBe(true);
    expect(db.advanceCounter("apple-key", 0, 2)).toBe(false);
    expect(db.advanceCounter("apple-key", 1, 1)).toBe(false);
    expect(db.key("apple-key")?.counter).toBe(1);
  });
  test("management is bound to the attested registration owner", () => {
    const db = store(); registered(db);
    expect(db.updateToken("registration", "other-key", "new", 2000)).toBe(false);
    expect(db.revoke("registration", "other-key")).toBe(false);
    expect(db.registration("registration")).toEqual(fixture());
  });
  test("an APNs error for the previous token cannot disable a rotated token", () => {
    const db = store(); registered(db);
    expect(db.updateToken("registration", "apple-key", "new-token", 2000)).toBe(true);
    expect(db.disableToken("registration", "fixture-token")).toBe(false);
    expect(db.registration("registration")?.active).toBe(true);
    expect(db.disableToken("registration", "new-token")).toBe(true);
    expect(db.registration("registration")).toBeNull();
  });
  test("revocation removes publication and prevents token updates", () => {
    const db = store(); registered(db);
    expect(db.revoke("registration", "apple-key")).toBe(true);
    expect(db.registration("registration")).toBeNull();
    expect(db.updateToken("registration", "apple-key", "new", 2000)).toBe(false);
  });
  test("registrations survive recreation without mixing Apple environments", () => {
    const dir = mkdtempSync(join(tmpdir(), "myclaw-relay-")); directories.push(dir);
    const path = join(dir, "relay.sqlite"); const db = store(path); registered(db); db.close();
    const restored = store(path);
    expect(restored.registration("registration")).toEqual(fixture());
    expect(() => new RelayStore(path, "development")).toThrow();
  });
});
