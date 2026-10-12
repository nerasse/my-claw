import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A credential that may sit in a URL: the media a native client hands to image views, players and
 * the download manager, which cannot all carry a header. It opens GET /media, /skills and
 * /fs/download for one device, and nothing else: not the socket, not an upload. It expires.
 *
 * It is the device token's HMAC over the device and an expiry, so the server keeps no state:
 * revoking the device or rotating its token voids every ticket it had, a restart voids none.
 *
 * The expiry is bucketed: every socket of a device gets the same ticket for twelve hours, so the
 * URLs an image cache is keyed on stay stable, and a ticket always has 24 to 36 hours ahead of it.
 * docs/my-claw-app-channel.md, "Credentials".
 */

const BUCKET_MS = 12 * 60 * 60 * 1000;
const LIFETIME_BUCKETS = 3;
/** A ticket expiring further out than this was not minted here. */
const MAX_AHEAD_MS = LIFETIME_BUCKETS * BUCKET_MS;
/** How often an open socket is handed a fresh ticket. */
export const TICKET_REFRESH_MS = BUCKET_MS;

function sign(token: string, deviceId: string, expires: number): string {
  return createHmac("sha256", token).update(`media:${deviceId}:${expires}`).digest("base64url").slice(0, 32);
}

export function mintTicket(deviceId: string, token: string, now = Date.now()): { ticket: string; expiresAt: number } {
  const expiresAt = (Math.floor(now / BUCKET_MS) + LIFETIME_BUCKETS) * BUCKET_MS;
  const expires = Math.floor(expiresAt / 1000);
  return { ticket: `${deviceId}.${expires}.${sign(token, deviceId, expires)}`, expiresAt };
}

/** The device a ticket stands for, or null. `tokenOf` answers only for an enabled device. */
export function verifyTicket(ticket: string, tokenOf: (deviceId: string) => string | undefined, now = Date.now()): string | null {
  const match = /^([A-Za-z0-9_-]{1,80})\.(\d{1,12})\.([A-Za-z0-9_-]{32})$/.exec(ticket);
  if (!match) return null;
  const [, deviceId, expiresRaw, signature] = match as unknown as [string, string, string, string];
  const expiresAt = Number(expiresRaw) * 1000;
  if (expiresAt <= now || expiresAt > now + MAX_AHEAD_MS) return null;
  const token = tokenOf(deviceId);
  if (!token) return null;
  const expected = Buffer.from(sign(token, deviceId, Number(expiresRaw)));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? deviceId : null;
}
