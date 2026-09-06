/**
 * One retry policy for the three transports.
 *
 * They each carried their own list and the lists disagreed: the OpenAI-compatible one retried 504
 * and not 529, the Anthropic one the reverse, and none of them 408 or the Cloudflare 52x that sit
 * in front of half the providers. A 529 read as a hard failure is a run that gives up on a queue.
 */

import { test, expect } from "bun:test";
import { isRetryableStatus, retryDelayMs, parseRetryAfterMs } from "../../src/llm/retry.ts";

test("a status is retryable because of what it means, not which transport met it first", () => {
  for (const status of [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]) {
    expect(isRetryableStatus(status)).toBe(true);
  }
  // A request that failed on its merits: trying it again would fail the same way.
  for (const status of [200, 400, 401, 403, 404, 409, 413, 422, 501]) {
    expect(isRetryableStatus(status)).toBe(false);
  }
});

test("the backoff is jittered, because an outage releases every caller at once", () => {
  const delays = new Set(Array.from({ length: 20 }, () => retryDelayMs(3)));
  // A bare doubling returns the same number every time, and every client comes back together.
  expect(delays.size).toBeGreaterThan(1);
  for (const delay of delays) {
    expect(delay).toBeGreaterThan(1500);
    expect(delay).toBeLessThan(2500);
  }
});

test("the backoff grows and then stops growing", () => {
  expect(retryDelayMs(1)).toBeLessThan(retryDelayMs(4));
  expect(retryDelayMs(40)).toBeLessThanOrEqual(30_000);
});

test("a Retry-After the server sent wins, but cannot park a run for an hour", () => {
  const seconds = new Response(null, { headers: { "retry-after": "12" } });
  expect(parseRetryAfterMs(seconds)).toBe(12_000);
  expect(retryDelayMs(1, 12_000)).toBe(12_000);
  expect(retryDelayMs(1, 3_600_000)).toBe(30_000);

  const httpDate = new Response(null, { headers: { "retry-after": new Date(Date.now() + 5_000).toUTCString() } });
  const parsed = parseRetryAfterMs(httpDate);
  expect(parsed).toBeGreaterThan(1_000);
  expect(parsed).toBeLessThanOrEqual(5_000);

  expect(parseRetryAfterMs(new Response(null))).toBeUndefined();
  expect(parseRetryAfterMs(new Response(null, { headers: { "retry-after": "later" } }))).toBeUndefined();
});
