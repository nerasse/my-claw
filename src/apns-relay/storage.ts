import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppleEnvironment, AttestedKey, ChallengePurpose, RelayRegistration } from "./types";

export class RelayStore {
  private readonly db: Database;
  private closed = false;
  constructor(path: string, private readonly environment: AppleEnvironment) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        PRAGMA busy_timeout=5000;
        PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS challenges (
          nonce TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK(purpose IN ('attest','manage')),
          keyId TEXT NOT NULL, expiresAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS challenge_expiry ON challenges(expiresAt);
        CREATE TABLE IF NOT EXISTS attested_keys (
          keyId TEXT PRIMARY KEY, publicKey TEXT NOT NULL,
          counter INTEGER NOT NULL CHECK(counter >= 0 AND counter <= 4294967295),
          environment TEXT NOT NULL CHECK(environment IN ('development','production'))
        );
        CREATE TABLE IF NOT EXISTS registrations (
          id TEXT PRIMARY KEY, keyId TEXT NOT NULL REFERENCES attested_keys(keyId),
          origin TEXT NOT NULL, token TEXT NOT NULL, secretHash TEXT NOT NULL,
          tokenUpdatedAt INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1))
        );
        CREATE INDEX IF NOT EXISTS registration_owner ON registrations(keyId);
      `);
      this.db.transaction(() => {
        this.db.query("INSERT OR IGNORE INTO metadata(name,value) VALUES ('environment',?)").run(environment);
        const stored = this.db.query<{ value: string }, []>("SELECT value FROM metadata WHERE name='environment'").get();
        if (stored?.value !== environment) throw new Error("Apple environment mismatch");
      })();
    } catch (error) { this.close(); throw error; }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
  pruneChallenges(now: number): void { this.db.query("DELETE FROM challenges WHERE expiresAt <= ?").run(now); }
  issueChallenge(nonce: string, purpose: ChallengePurpose, keyId: string, expiresAt: number): void {
    const count = this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM challenges").get()?.count ?? 0;
    if (count >= 10_000) throw new Error("Challenge capacity reached");
    this.db.query("INSERT INTO challenges(nonce,purpose,keyId,expiresAt) VALUES (?,?,?,?)").run(nonce, purpose, keyId, expiresAt);
  }
  consumeChallenge(nonce: string, purpose: ChallengePurpose, keyId: string, now: number): boolean {
    return this.db.query<{ nonce: string }, [string, ChallengePurpose, string, number]>(
      "DELETE FROM challenges WHERE nonce=? AND purpose=? AND keyId=? AND expiresAt>? RETURNING nonce"
    ).get(nonce, purpose, keyId, now) !== null;
  }
  addKey(key: AttestedKey): void {
    if (key.environment !== this.environment) throw new Error("Apple environment mismatch");
    this.db.query("INSERT INTO attested_keys(keyId,publicKey,counter,environment) VALUES (?,?,?,?)")
      .run(key.keyId, key.publicKey, key.counter, key.environment);
  }
  key(keyId: string): AttestedKey | null {
    return this.db.query<AttestedKey, [string]>("SELECT * FROM attested_keys WHERE keyId=?").get(keyId);
  }
  advanceCounter(keyId: string, previous: number, next: number): boolean {
    if (!Number.isInteger(next) || next <= previous || next > 0xffffffff) return false;
    return this.db.query("UPDATE attested_keys SET counter=? WHERE keyId=? AND counter=?").run(next, keyId, previous).changes === 1;
  }
  register(registration: RelayRegistration): void {
    this.db.transaction(() => {
      this.db.query("UPDATE registrations SET active=0 WHERE keyId=? AND active=1").run(registration.keyId);
      this.db.query("INSERT INTO registrations(id,keyId,origin,token,secretHash,tokenUpdatedAt,active) VALUES (?,?,?,?,?,?,?)")
        .run(registration.id, registration.keyId, registration.origin, registration.token, registration.secretHash,
          registration.tokenUpdatedAt, registration.active ? 1 : 0);
    })();
  }
  registration(id: string): RelayRegistration | null {
    const row = this.registrationIncludingRevoked(id);
    return row?.active ? row : null;
  }
  registrationIncludingRevoked(id: string): RelayRegistration | null {
    const row = this.db.query<Omit<RelayRegistration, "active"> & { active: number }, [string]>(
      "SELECT * FROM registrations WHERE id=?"
    ).get(id);
    return row ? { ...row, active: row.active === 1 } : null;
  }
  updateToken(id: string, keyId: string, token: string, now: number): boolean {
    return this.db.query("UPDATE registrations SET token=?,tokenUpdatedAt=? WHERE id=? AND keyId=? AND active=1")
      .run(token, now, id, keyId).changes === 1;
  }
  revoke(id: string, keyId: string): boolean {
    return this.db.query("UPDATE registrations SET active=0 WHERE id=? AND keyId=? AND active=1").run(id, keyId).changes === 1;
  }
  disableToken(id: string, token: string): boolean {
    return this.db.query("UPDATE registrations SET active=0 WHERE id=? AND token=? AND active=1").run(id, token).changes === 1;
  }
}
