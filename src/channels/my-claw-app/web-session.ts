import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../core/config.ts";
import { writeFileAtomically } from "../../utils/atomic-write.ts";
import { myClawAppLog } from "../../utils/logger.ts";

/**
 * Browser sessions for the web client (docs/my-claw-app-channel.md).
 *
 * A browser cannot present `?device=&token=` on the asset graph of an HTML page, on the service
 * worker or on an `<img src>`, so it authenticates with a cookie. The cookie holds an opaque
 * session id, never the device token: the browser therefore never receives a credential that
 * outlives a revocation, and an XSS cannot read an HttpOnly cookie to steal one.
 *
 * The bridge between the two worlds is a grant: pairing happens on a WebSocket, which cannot set
 * a cookie, so the socket hands out a single-use grant that the page exchanges over HTTP.
 */

export const SESSION_COOKIE = "claw_session";

const GRANT_TTL_MS = 30_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STORE_PATH = () => join(MY_CLAW_DIR, "web-sessions.json");

interface StoredSession {
  deviceId: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
}

interface Grant {
  deviceId: string;
  expiresAt: number;
}

const sessions = new Map<string, StoredSession>();
const grants = new Map<string, Grant>();
let loaded = false;

function now(): number {
  return Date.now();
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(STORE_PATH(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, StoredSession>;
    for (const [id, session] of Object.entries(parsed)) {
      if (session && typeof session.deviceId === "string") sessions.set(id, session);
    }
  } catch {
    // No store yet, or an unreadable one: an unusable session file must not stop the channel.
  }
}

async function persist(): Promise<void> {
  const data: Record<string, StoredSession> = {};
  for (const [id, session] of sessions) data[id] = session;
  try {
    await writeFileAtomically(STORE_PATH(), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    myClawAppLog("warn", "web session store write failed", { error: String(err) });
  }
}

/** Constant-time lookup key: a Map hit on a raw secret leaks its prefix through timing. */
function keyOf(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function createGrant(deviceId: string): string {
  const grant = randomBytes(32).toString("base64url");
  grants.set(keyOf(grant), { deviceId, expiresAt: now() + GRANT_TTL_MS });
  return grant;
}

/**
 * Exchanges a grant for a session id. Single use and short lived: the page redeems it
 * immediately after pairing, and anything later is a replay.
 */
export async function redeemGrant(
  grant: string,
  userAgent?: string,
): Promise<{ ok: true; sessionId: string; deviceId: string } | { ok: false; reason: string }> {
  load();
  const key = keyOf(grant);
  const found = grants.get(key);
  grants.delete(key);
  if (!found) return { ok: false, reason: "unknown grant" };
  if (found.expiresAt < now()) return { ok: false, reason: "expired grant" };

  const sessionId = randomBytes(32).toString("base64url");
  sessions.set(keyOf(sessionId), {
    deviceId: found.deviceId,
    createdAt: now(),
    lastSeenAt: now(),
    userAgent,
  });
  await persist();
  myClawAppLog("info", "web session opened", { deviceId: found.deviceId, userAgent });
  return { ok: true, sessionId, deviceId: found.deviceId };
}

/** The device a cookie stands for, or null. Slides the expiry, without a write on every request. */
export function deviceOfSession(sessionId: string | null): string | null {
  if (!sessionId) return null;
  load();
  const session = sessions.get(keyOf(sessionId));
  if (!session) return null;
  if (now() - session.lastSeenAt > SESSION_TTL_MS) {
    sessions.delete(keyOf(sessionId));
    void persist();
    return null;
  }
  session.lastSeenAt = now();
  return session.deviceId;
}

export async function revokeSessionsOfDevice(deviceId: string): Promise<number> {
  load();
  let dropped = 0;
  for (const [id, session] of sessions) {
    if (session.deviceId === deviceId) {
      sessions.delete(id);
      dropped += 1;
    }
  }
  if (dropped > 0) await persist();
  return dropped;
}

export async function revokeSession(sessionId: string): Promise<boolean> {
  load();
  const removed = sessions.delete(keyOf(sessionId));
  if (removed) await persist();
  return removed;
}

/** Reads one cookie out of a request header, without a parser dependency. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

/**
 * `Secure` follows the scheme the browser actually used, which is what the proxy reports in
 * `X-Forwarded-Proto`. Hardcoding it would make the client unusable over plain HTTP on the LAN,
 * and dropping it would ship a cookie without protection behind TLS.
 */
export function sessionCookie(sessionId: string, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${sessionId}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Compares two secrets without an early exit. Exported for the pairing code check. */
export function secretsMatch(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** Module-level state, reset between test files. */
export function resetWebSessions(): void {
  sessions.clear();
  grants.clear();
  loaded = false;
}
