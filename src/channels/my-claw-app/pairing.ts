import { randomBytes, randomInt } from "node:crypto";
import type { MyClawAppChannelConfig } from "../../core/config.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import { mintDevice } from "./devices.ts";
import { createGrant } from "./web-session.ts";

/**
 * Pairing sessions: the only unauthenticated surface of the channel (docs/web-pairing.md).
 *
 * A browser holds nothing, so it opens a pairing socket, shows a code, and an already paired
 * device approves it. The CLI takes the same road from the other end: `myclaw device add` mints
 * the device up front and leaves a pre-approved ticket, so a claim and an approval deliver the
 * credential through one code path.
 *
 * Nothing here is written to disk. A ticket is a credential with a two minute life, and a file
 * would outlive the window for no reason. A restart cancels every pairing in flight, which is
 * the correct answer to "the server just changed underneath you".
 */

export type PairingKind = "web" | "native";

export interface PairingDelivery {
  deviceId: string;
  owner: string;
  name: string;
  /** Browsers get a single-use grant to exchange for a cookie; native clients get the token. */
  grant?: string;
  token?: string;
}

export interface PairingSession {
  code: string;
  verification: string;
  expiresAt: number;
  kind: PairingKind;
  origin?: string;
  ip?: string;
  userAgent?: string;
  /** Set for a CLI ticket: the device already exists and no approval is needed. */
  preApproved?: { deviceId: string; owner: string; name: string; token: string };
  deliver?: (delivery: PairingDelivery) => void;
  reject?: (reason: PairingDenial) => void;
  /** Tells the waiting client that a device is looking at its code, so it can say so. */
  pending?: (approver: string) => void;
  attempts: number;
}

export type PairingDenial = "denied" | "expired" | "attempts" | "disabled" | "unknown";

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
const MAX_ATTEMPTS = 5;
const IP_WINDOW_MS = 60_000;
const IP_MAX_PER_WINDOW = 10;

const sessions = new Map<string, PairingSession>();
const ipHits = new Map<string, number[]>();

let clock = (): number => Date.now();

/** Tests drive expiry with their own clock rather than sleeping through a real TTL. */
export function setPairingClock(fn: () => number): void {
  clock = fn;
}

/** The channel config is passed in: the adapter owns the live snapshot, this module owns no state. */
export function pairingEnabled(config: MyClawAppChannelConfig): boolean {
  return config.pairing?.enabled === true;
}

function challengeTtlMs(config: MyClawAppChannelConfig): number {
  return (config.pairing?.ttlSeconds ?? 120) * 1000;
}

function claimTtlMs(config: MyClawAppChannelConfig): number {
  return (config.pairing?.claimTtlSeconds ?? 600) * 1000;
}

function maxSessions(config: MyClawAppChannelConfig): number {
  return config.pairing?.maxSessions ?? 20;
}

/**
 * Crockford base32, read off a screen and typed on a phone: no I, L, O or U, and the two pairs
 * a human confuses are folded on the way in.
 */
function newCode(): string {
  let code = "";
  while (code.length < CODE_LENGTH) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
}

function sweep(): void {
  const at = clock();
  for (const [code, session] of sessions) {
    if (session.expiresAt <= at) {
      session.reject?.("expired");
      sessions.delete(code);
    }
  }
}

function rateLimited(ip: string | undefined): boolean {
  if (!ip) return false;
  const at = clock();
  const hits = (ipHits.get(ip) ?? []).filter((stamp) => at - stamp < IP_WINDOW_MS);
  hits.push(at);
  ipHits.set(ip, hits);
  return hits.length > IP_MAX_PER_WINDOW;
}

export interface OpenOptions {
  kind: PairingKind;
  origin?: string;
  ip?: string;
  userAgent?: string;
  deliver: (delivery: PairingDelivery) => void;
  reject: (reason: PairingDenial) => void;
  pending?: (approver: string) => void;
}

export function openSession(
  config: MyClawAppChannelConfig,
  options: OpenOptions,
): { ok: true; session: PairingSession } | { ok: false; reason: string } {
  if (!pairingEnabled(config)) return { ok: false, reason: "pairing disabled" };
  sweep();
  if (rateLimited(options.ip)) return { ok: false, reason: "too many attempts" };
  if (sessions.size >= maxSessions(config)) return { ok: false, reason: "too many pairings in flight" };

  const session: PairingSession = {
    code: newCode(),
    // Three digits the owner compares on both screens: without them, someone else's QR pairs
    // their browser to this owner and the approval looks exactly the same.
    verification: String(randomInt(1000)).padStart(3, "0"),
    expiresAt: clock() + challengeTtlMs(config),
    kind: options.kind,
    origin: options.origin,
    ip: options.ip,
    userAgent: options.userAgent,
    deliver: options.deliver,
    reject: options.reject,
    pending: options.pending,
    attempts: 0,
  };
  sessions.set(session.code, session);
  myClawAppLog("info", "pairing challenge opened", {
    code: session.code,
    kind: session.kind,
    ip: session.ip,
    origin: session.origin,
  });
  return { ok: true, session };
}

/**
 * A pre-approved ticket for `myclaw device add`: the device exists already, so the first client
 * presenting the code gets its credential without anybody approving anything.
 */
export function createTicket(
  config: MyClawAppChannelConfig,
  input: { deviceId: string; owner: string; name: string; token: string },
): PairingSession {
  sweep();
  const session: PairingSession = {
    code: newCode(),
    verification: String(randomInt(1000)).padStart(3, "0"),
    expiresAt: clock() + claimTtlMs(config),
    kind: "web",
    preApproved: input,
    attempts: 0,
  };
  sessions.set(session.code, session);
  return session;
}

export function closeSession(code: string): void {
  sessions.delete(code);
}

export function findSession(code: string): PairingSession | undefined {
  sweep();
  return sessions.get(normalizeCode(code));
}

/** What the approving device shows before the owner decides. Never includes a credential. */
export function lookup(
  code: string,
  approver?: string,
): { ok: true; session: PairingSession } | { ok: false; reason: PairingDenial } {
  const session = findSession(code);
  if (!session) return { ok: false, reason: "unknown" };
  session.attempts += 1;
  if (session.attempts > MAX_ATTEMPTS) {
    session.reject?.("attempts");
    sessions.delete(session.code);
    return { ok: false, reason: "attempts" };
  }
  if (approver) session.pending?.(approver);
  return { ok: true, session };
}

export async function approve(
  config: MyClawAppChannelConfig,
  code: string,
  input: { name: string; owner: string; approver: string },
): Promise<{ ok: true; deviceId: string } | { ok: false; error: string }> {
  const found = lookup(code);
  if (!found.ok) return { ok: false, error: found.reason };
  const session = found.session;

  const minted = await mintDevice(config, { name: input.name, owner: input.owner, kind: "web" });
  if (!minted.ok) return { ok: false, error: minted.error };

  deliver(session, {
    deviceId: minted.device.deviceId,
    owner: minted.device.owner,
    name: input.name,
    ...(session.kind === "web"
      ? { grant: createGrant(minted.device.deviceId) }
      : { token: minted.device.token }),
  });
  myClawAppLog("info", "pairing approved", {
    deviceId: minted.device.deviceId,
    approver: input.approver,
    origin: session.origin,
    ip: session.ip,
  });
  return { ok: true, deviceId: minted.device.deviceId };
}

export function deny(code: string, approver: string): boolean {
  const session = findSession(code);
  if (!session) return false;
  session.reject?.("denied");
  sessions.delete(session.code);
  myClawAppLog("warn", "pairing denied", { code: session.code, approver });
  return true;
}

/** The claim path: a client presents a code for a ticket that was approved when it was created. */
export function claim(
  code: string,
  kind: PairingKind,
): { ok: true; delivery: PairingDelivery } | { ok: false; reason: PairingDenial } {
  const found = lookup(code);
  if (!found.ok) return { ok: false, reason: found.reason };
  const session = found.session;
  if (!session.preApproved) return { ok: false, reason: "unknown" };

  const { deviceId, owner, name, token } = session.preApproved;
  sessions.delete(session.code);
  const delivery: PairingDelivery =
    kind === "web"
      ? { deviceId, owner, name, grant: createGrant(deviceId) }
      : { deviceId, owner, name, token };
  myClawAppLog("info", "pairing ticket claimed", { deviceId, kind });
  return { ok: true, delivery };
}

function deliver(session: PairingSession, delivery: PairingDelivery): void {
  session.deliver?.(delivery);
  sessions.delete(session.code);
}

/** A pairing socket that drops takes its session with it: a credential is never redeliverable. */
export function releaseByDeliver(deliverFn: (delivery: PairingDelivery) => void): void {
  for (const [code, session] of sessions) {
    if (session.deliver === deliverFn) sessions.delete(code);
  }
}

export function pendingSessions(): number {
  sweep();
  return sessions.size;
}

/** Module-level state, reset between test files. */
export function resetPairing(): void {
  sessions.clear();
  ipHits.clear();
  clock = () => Date.now();
}

/** A QR the browser can render without shipping an encoder: the server draws it as SVG. */
export function claimUrl(host: string, code: string, secure: boolean): string {
  return `${secure ? "https" : "http"}://${host}/pair#${code}`;
}

export function newVerificationNonce(): string {
  return randomBytes(8).toString("hex");
}
