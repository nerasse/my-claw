import { randomBytes, randomInt } from "node:crypto";
import QRCode from "qrcode";
import type { MyClawAppChannelConfig } from "../../core/config.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import { mintDevice } from "./devices.ts";
import { createGrant, secretsMatch } from "./web-session.ts";

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

/** A live code claims a device for ten minutes: the log only needs to tell two apart. */
function logCode(code: string): string {
  return `${code.slice(0, 2)}…`;
}

export type PairingKind = "web" | "native";

export interface PairingDelivery {
  deviceId: string;
  owner: string;
  name: string;
  /** Browsers get a single-use grant to exchange for a cookie; native clients get the token. */
  grant?: string;
  token?: string;
}

/**
 * An approval, before it becomes a credential. The grant is minted when the frame is actually
 * sent, never when the approval lands: it lives 30 seconds, and the page it is meant for may be
 * a phone browser that is still in the background.
 */
export interface DeliveryIntent {
  deviceId: string;
  owner: string;
  name: string;
  token: string;
}

export interface PairingSession {
  code: string;
  verification: string;
  /**
   * Proof that a reconnecting socket is the one that raised this challenge. Never displayed,
   * never in the QR, never sent to the approving device: the code identifies the session, this
   * is what authorises receiving its credential.
   */
  resumeToken: string;
  expiresAt: number;
  kind: PairingKind;
  origin?: string;
  ip?: string;
  userAgent?: string;
  /** Set for a CLI ticket: the device already exists and no approval is needed. */
  preApproved?: { deviceId: string; owner: string; name: string; token: string };
  /**
   * Set for an invitation made from a paired device: approved already, but nothing is minted
   * until a client claims it, because only then is it known whether a phone or a browser joins.
   */
  invite?: { owner: string; name: string; by: string };
  /** Told when the invitation is claimed, so the inviting screen can say the device joined. */
  joined?: (deviceId: string) => void;
  deliver?: (delivery: PairingDelivery) => void;
  reject?: (reason: PairingDenial) => void;
  /** Tells the waiting client that a device is looking at its code, so it can say so. */
  pending?: (approver: string) => void;
  /** No socket attached: the page was backgrounded, reloaded, or is simply gone. */
  detachedAt?: number;
  /** An approval that landed with nothing attached, held until the page comes back. */
  parked?: DeliveryIntent;
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
/**
 * Codes that existed and no longer do, with the reason. Without this an expired code and a code
 * that was never issued answer the same "unknown", and the owner retypes a dead code believing
 * they mistyped it.
 */
const tombstones = new Map<string, { reason: PairingDenial; until: number }>();
const TOMBSTONE_MS = 15 * 60 * 1000;

let clock = (): number => Date.now();

/** Tests drive expiry with their own clock rather than sleeping through a real TTL. */
export function setPairingClock(fn: () => number): void {
  clock = fn;
}

/** The channel config is passed in: the adapter owns the live snapshot, this module owns no state. */
export function pairingEnabled(config: MyClawAppChannelConfig): boolean {
  return config.pairing?.enabled === true;
}

/**
 * Ten minutes, not two.
 *
 * Two minutes is the time it takes to read a code, pick up the phone, unlock it, open Settings,
 * Devices, and type eight characters. Measured on the first real pairing: the challenge was gone
 * before the owner finished typing, and the page still showed a code that no longer existed.
 */
function challengeTtlMs(config: MyClawAppChannelConfig): number {
  return (config.pairing?.ttlSeconds ?? 600) * 1000;
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
  // Called straight off the wire, where the field is a promise and not a guarantee.
  return String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
}

function bury(code: string, reason: PairingDenial): void {
  tombstones.set(code, { reason, until: clock() + TOMBSTONE_MS });
}

function sweep(): void {
  const at = clock();
  for (const [code, session] of sessions) {
    if (session.expiresAt <= at) {
      session.reject?.("expired");
      sessions.delete(code);
      bury(code, "expired");
    }
  }
  for (const [code, entry] of tombstones) {
    if (entry.until <= at) tombstones.delete(code);
  }
}

/** Why a code is gone, when it is gone. */
function reasonFor(code: string): PairingDenial {
  return tombstones.get(code)?.reason ?? "unknown";
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

/**
 * Makes room for a new challenge by dropping the oldest one nobody is attached to.
 *
 * A challenge now outlives its socket, so the cap would otherwise be reachable by reloading the
 * page in a fresh tab twenty times: the abandoned sessions would hold the door shut for the rest
 * of their TTL. A detached session has no client left to disappoint.
 */
function evictOldestDetached(): boolean {
  let oldestCode: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const session of sessions.values()) {
    if (session.detachedAt === undefined || session.detachedAt >= oldestAt) continue;
    oldestCode = session.code;
    oldestAt = session.detachedAt;
  }
  if (oldestCode === undefined) return false;
  sessions.delete(oldestCode);
  bury(oldestCode, "expired");
  return true;
}

export function openSession(
  config: MyClawAppChannelConfig,
  options: OpenOptions,
): { ok: true; session: PairingSession } | { ok: false; reason: string } {
  if (!pairingEnabled(config)) return { ok: false, reason: "pairing disabled" };
  sweep();
  if (rateLimited(options.ip)) return { ok: false, reason: "too many attempts" };
  if (sessions.size >= maxSessions(config) && !evictOldestDetached()) {
    return { ok: false, reason: "too many pairings in flight" };
  }

  const session: PairingSession = {
    code: newCode(),
    // Three digits the owner compares on both screens: without them, someone else's QR pairs
    // their browser to this owner and the approval looks exactly the same.
    verification: String(randomInt(1000)).padStart(3, "0"),
    resumeToken: randomBytes(32).toString("base64url"),
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
    code: logCode(session.code),
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
    resumeToken: randomBytes(32).toString("base64url"),
    expiresAt: clock() + claimTtlMs(config),
    kind: "web",
    preApproved: input,
    attempts: 0,
  };
  sessions.set(session.code, session);
  return session;
}

/**
 * An invitation from an already paired device (Devices, "Add a device"): the owner approves by
 * making it, so the first client presenting the code joins, the way a `myclaw device add` ticket
 * does. The device is minted on the claim, as a phone or a browser by who claims it: an unclaimed
 * invitation leaves nothing behind in the config.
 */
export function createInvite(
  config: MyClawAppChannelConfig,
  input: { owner: string; name: string; by: string },
  joined?: (deviceId: string) => void,
): { ok: true; session: PairingSession } | { ok: false; reason: string } {
  if (!pairingEnabled(config)) return { ok: false, reason: "pairing disabled" };
  sweep();
  if (sessions.size >= maxSessions(config) && !evictOldestDetached()) {
    return { ok: false, reason: "too many pairings in flight" };
  }
  const session: PairingSession = {
    code: newCode(),
    verification: String(randomInt(1000)).padStart(3, "0"),
    resumeToken: randomBytes(32).toString("base64url"),
    expiresAt: clock() + claimTtlMs(config),
    kind: "web",
    invite: input,
    joined,
    attempts: 0,
  };
  sessions.set(session.code, session);
  myClawAppLog("info", "pairing invitation opened", { code: logCode(session.code), by: input.by });
  return { ok: true, session };
}

export function closeSession(code: string): void {
  sessions.delete(code);
}

/**
 * The socket dropped, the challenge stays.
 *
 * Killing it here is what made pairing from a single phone impossible: switching to the app to
 * approve backgrounds the browser, the browser closes the socket, and the code on screen was
 * already dead by the time the owner finished typing it. The callbacks go, so an approval that
 * lands meanwhile is parked rather than written into a socket nobody is reading.
 */
export function detachSession(code: string): void {
  const session = sessions.get(code);
  if (!session) return;
  session.deliver = undefined;
  session.reject = undefined;
  session.pending = undefined;
  session.detachedAt = clock();
}

export interface ResumeHandlers {
  deliver: (delivery: PairingDelivery) => void;
  reject: (reason: PairingDenial) => void;
  pending?: (approver: string) => void;
}

/**
 * Re-attaches a reconnecting socket to the challenge it raised, against the token only that page
 * ever received. `flushed` says the approval had already landed and has just been delivered, so
 * the caller must not follow it with a challenge frame.
 */
export function resumeSession(
  code: string,
  resumeToken: string,
  handlers: ResumeHandlers,
): { ok: true; session: PairingSession; flushed: boolean } | { ok: false; reason: PairingDenial } {
  sweep();
  const normalized = normalizeCode(code);
  const session = sessions.get(normalized);
  if (!session) return { ok: false, reason: reasonFor(normalized) };
  if (!secretsMatch(session.resumeToken, resumeToken)) {
    myClawAppLog("warn", "pairing resume refused", { code: logCode(normalized), ip: session.ip });
    return { ok: false, reason: "unknown" };
  }

  session.deliver = handlers.deliver;
  session.reject = handlers.reject;
  session.pending = handlers.pending;
  session.detachedAt = undefined;

  const parked = session.parked;
  if (!parked) return { ok: true, session, flushed: false };
  session.parked = undefined;
  deliver(session, parked);
  return { ok: true, session, flushed: true };
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
  if (!session) return { ok: false, reason: reasonFor(normalizeCode(code)) };
  // An invitation or a ticket is approved already: it is claimed by the device that joins, never
  // approved a second time from another one, which would mint a device nobody asked for.
  if (session.invite || session.preApproved) return { ok: false, reason: "unknown" };
  session.attempts += 1;
  if (session.attempts > MAX_ATTEMPTS) {
    session.reject?.("attempts");
    sessions.delete(session.code);
    bury(session.code, "attempts");
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

  // A phone asking from its Join screen is an app device: its id says so, like one minted by the CLI.
  const native = session.kind === "native";
  const name = input.name.trim() || (native ? "phone" : "browser");
  const minted = await mintDevice(config, { name, owner: input.owner, kind: native ? "app" : "web" });
  if (!minted.ok) return { ok: false, error: minted.error };

  deliver(session, {
    deviceId: minted.device.deviceId,
    owner: minted.device.owner,
    name,
    token: minted.device.token,
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
  bury(session.code, "denied");
  myClawAppLog("warn", "pairing denied", { code: logCode(session.code), approver });
  return true;
}

/**
 * The claim path: a client presents a code for a ticket that was approved when it was created,
 * a CLI ticket (the device exists) or an invitation (the device is minted now, as what claims it).
 */
export async function claim(
  config: MyClawAppChannelConfig,
  code: string,
  kind: PairingKind,
): Promise<{ ok: true; delivery: PairingDelivery } | { ok: false; reason: PairingDenial }> {
  const session = findSession(code);
  if (!session) return { ok: false, reason: reasonFor(normalizeCode(code)) };
  if (!session.preApproved && !session.invite) return { ok: false, reason: "unknown" };
  // Taken before the mint: two clients racing on one code must not both get a device.
  sessions.delete(session.code);

  let ticket = session.preApproved;
  if (!ticket && session.invite) {
    const minted = await mintDevice(config, {
      name: session.invite.name,
      owner: session.invite.owner,
      kind: kind === "native" ? "app" : "web",
    });
    if (!minted.ok) {
      myClawAppLog("warn", "pairing invitation not minted", { code: logCode(session.code), error: minted.error });
      return { ok: false, reason: "unknown" };
    }
    ticket = { deviceId: minted.device.deviceId, owner: minted.device.owner, name: session.invite.name, token: minted.device.token };
    session.joined?.(ticket.deviceId);
  }
  const { deviceId, owner, name, token } = ticket!;
  const delivery: PairingDelivery =
    kind === "web"
      ? { deviceId, owner, name, grant: createGrant(deviceId) }
      : { deviceId, owner, name, token };
  myClawAppLog("info", "pairing ticket claimed", { deviceId, kind });
  return { ok: true, delivery };
}

/**
 * Hands the credential to the waiting page, or holds the approval until one is back.
 *
 * The parked branch is the single-phone case: the owner approves in the app while the browser is
 * backgrounded. Nothing is minted for a client that is not listening, so a grant is never burning
 * its 30 seconds in an empty room.
 */
function deliver(session: PairingSession, intent: DeliveryIntent): void {
  if (!session.deliver) {
    session.parked = intent;
    return;
  }
  const { deviceId, owner, name, token } = intent;
  session.deliver(
    session.kind === "web"
      ? { deviceId, owner, name, grant: createGrant(deviceId) }
      : { deviceId, owner, name, token },
  );
  sessions.delete(session.code);
  bury(session.code, "denied");
}

export function pendingSessions(): number {
  sweep();
  return sessions.size;
}

/** Module-level state, reset between test files. */
export function resetPairing(): void {
  sessions.clear();
  ipHits.clear();
  tombstones.clear();
  clock = () => Date.now();
}

/**
 * The QR the pairing page shows, drawn server-side.
 *
 * Encoding it in the shell would mean shipping an encoder into the one page that has to stay
 * small and dependency-free, and the payload is the claim URL rather than the credential: a photo
 * of the screen is worth nothing without a paired device to approve it.
 */
export function claimUrl(host: string, code: string, secure: boolean): string {
  return `${secure ? "https" : "http"}://${host}/pair#${code}`;
}

/**
 * Light modules on nothing suit the pairing page, which is always dark. The app draws its
 * invitation on a light or a dark theme, so it asks for dark on white: every scanner reads that,
 * not every one reads a QR inverted.
 */
export async function claimQrSvg(
  host: string,
  code: string,
  secure: boolean,
  color: { dark: string; light: string } = { dark: "#e6e8eb", light: "#0000" },
): Promise<string> {
  return QRCode.toString(claimUrl(host, code, secure), {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color,
  });
}
