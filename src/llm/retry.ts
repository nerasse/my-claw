/**
 * When an LLM call is worth trying again, and how long to wait -- one answer for the three
 * transports.
 *
 * They each carried their own list and they disagreed: the OpenAI-compatible one retried 504 and
 * not 529, the Anthropic one the reverse, and none of them 408 or the Cloudflare 52x that sit in
 * front of half the providers. A status is retryable because of what it means, not because of
 * which transport happened to meet it first.
 */

/**
 * Everything that means "the request did not fail on its merits".
 *
 * - `408` the request timed out on the way in
 * - `429` rate limited, the canonical retry
 * - `500 502 503 504` the far side, or something between us and it
 * - `520-524` Cloudflare's own: origin dropped, timed out, or handshake failed
 * - `529` Anthropic's overloaded, which is a queue, not a fault
 */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE.has(status);
}

const BASE_MS = 500;
const MAX_MS = 30_000;
const JITTER = 0.15;

/**
 * Exponential, capped, and jittered -- the jitter is not decoration. An outage hits every caller
 * at once, and a bare doubling makes them all come back at the same instant, which is how a
 * provider that was recovering gets knocked over again by its own clients.
 *
 * A `Retry-After` the server sent wins over our own arithmetic, capped so a header of an hour
 * cannot park a run for an hour.
 */
export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_MS);
  const base = Math.min(BASE_MS * 2 ** (attempt - 1), MAX_MS);
  // Capped after the jitter, not before: a ceiling the jitter can push through is not a ceiling.
  return Math.min(base * (1 + (Math.random() * 2 - 1) * JITTER), MAX_MS);
}

/** `Retry-After` as milliseconds. Accepts the delta-seconds form and the HTTP-date form. */
export function parseRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

/**
 * Whether the status in hand is a wall, asked of whoever attached the knowledge.
 *
 * A 429 is the only status where it matters: every other retryable one is a fault of the far side
 * or of the wire, and no plan closes on it. The predicate is optional and its absence means "keep
 * the usual attempts", which is what every caller that predates the oracle gets.
 *
 * Never throws: a probe that fails does not become a decision, it leaves the transport's ordinary
 * behaviour in place.
 */
export async function wallAhead(
  config: { isWall?: (err: unknown) => Promise<boolean> } | undefined,
  err: unknown,
): Promise<boolean> {
  if (!config?.isWall) return false;
  const status = (err as { status?: number } | undefined)?.status;
  if (status !== 429) return false;
  return config.isWall(err).catch(() => false);
}
