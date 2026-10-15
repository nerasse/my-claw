import { randomInt } from "node:crypto";
import { log } from "../utils/logger.ts";

/**
 * Claim codes for nodes: minted where the operator is, consumed where the node is.
 *
 * Same shape as the app channel's pairing (`channels/my-claw-app/pairing.ts`) and deliberately
 * separate: this protocol has no socket and no approval, one code is one node, and the store it
 * feeds is its own. A code lives in memory only -- a short-lived credential in a file would
 * outlive its window for nothing.
 */

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
const IP_WINDOW_MS = 60_000;
const IP_MAX_PER_WINDOW = 10;
const TOMBSTONE_MS = 15 * 60 * 1000;

export type ClaimDenial = "unknown" | "expired" | "used" | "attempts";

interface Claim {
  code: string;
  /** Named at mint time when the operator knew it; otherwise the hostname fills it at the claim. */
  name?: string;
  expiresAt: number;
}

const claims = new Map<string, Claim>();
const tombstones = new Map<string, { reason: ClaimDenial; until: number }>();
const ipHits = new Map<string, number[]>();
let clock = (): number => Date.now();

/** Tests drive expiry with their own clock rather than sleeping through a real TTL. */
export function setClaimClock(fn: () => number): void {
  clock = fn;
}

/** Crockford base32, read off a screen and typed on a keyboard: no I, L, O or U. */
export function normalizeClaimCode(input: string): string {
  return String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
}

function newCode(): string {
  let code = "";
  while (code.length < CODE_LENGTH) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function bury(code: string, reason: ClaimDenial): void {
  tombstones.set(code, { reason, until: clock() + TOMBSTONE_MS });
}

function sweep(): void {
  const at = clock();
  for (const [code, claim] of claims) {
    if (claim.expiresAt <= at) {
      claims.delete(code);
      bury(code, "expired");
    }
  }
  for (const [code, entry] of tombstones) {
    if (entry.until <= at) tombstones.delete(code);
  }
}

function reasonFor(code: string): ClaimDenial {
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

export interface OpenClaimOptions {
  name?: string;
  ttlSeconds?: number;
  ip?: string;
}

export function openClaim(options: OpenClaimOptions = {}): { ok: true; code: string; expiresAt: number } | { ok: false; reason: string } {
  sweep();
  if (rateLimited(options.ip)) return { ok: false, reason: "too many attempts" };
  const ttl = options.ttlSeconds && options.ttlSeconds > 0 ? options.ttlSeconds : 600;
  const claim: Claim = {
    code: newCode(),
    ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    expiresAt: clock() + ttl * 1000,
  };
  claims.set(claim.code, claim);
  void log("info", "node claim opened", { code: `${claim.code.slice(0, 2)}…`, name: claim.name, ttl });
  return { ok: true, code: claim.code, expiresAt: claim.expiresAt };
}

/**
 * Reads a code without taking it, for the download relay: a claim authorises both fetching the
 * client and pairing it, and only the pairing consumes the code. The per-IP window counts here
 * too, so the download is not a way around it.
 */
export function peekClaim(code: string, ip?: string): { ok: true; name?: string } | { ok: false; reason: ClaimDenial } {
  sweep();
  const normalized = normalizeClaimCode(code);
  if (rateLimited(ip)) return { ok: false, reason: "attempts" };
  const claim = claims.get(normalized);
  if (!claim) return { ok: false, reason: reasonFor(normalized) };
  return { ok: true, ...(claim.name ? { name: claim.name } : {}) };
}

/**
 * Takes a code, once. The per-IP window counts every attempt, valid code or not: it is what
 * stands against hammering, and a throttled caller is refused without burning the code it
 * presented, which a retry in a minute still finds valid.
 */
export function consumeClaim(code: string, ip?: string): { ok: true; name?: string } | { ok: false; reason: ClaimDenial } {
  sweep();
  const normalized = normalizeClaimCode(code);
  if (rateLimited(ip)) return { ok: false, reason: "attempts" };
  const claim = claims.get(normalized);
  if (!claim) return { ok: false, reason: reasonFor(normalized) };
  // Taken before anything is minted: two nodes racing on one code must not both pair.
  claims.delete(normalized);
  bury(normalized, "used");
  return { ok: true, ...(claim.name ? { name: claim.name } : {}) };
}

export function pendingClaims(): number {
  sweep();
  return claims.size;
}

/** Module-level state, reset between test files. */
export function resetClaims(): void {
  claims.clear();
  tombstones.clear();
  ipHits.clear();
  clock = () => Date.now();
}
