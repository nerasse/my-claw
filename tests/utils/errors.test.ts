/**
 * A provider failure, as a note can say it.
 *
 * The notes drawn above an answer are one line in a thread, not a bug report. A transport error
 * carries the provider's whole HTTP answer -- status, JSON body, and the URL its billing page
 * lives at -- and putting that in the note made a fallback read as
 * `HTTP 429 — {"error":"You've exceeded your subscription rate limits. Upgrade, or try again…`
 * (owner, 2026-11-14: "horrible l'ui des erreurs"). The raw error still goes to the log.
 */

import { describe, expect, test } from "bun:test";
import { noticeReason } from "../../src/utils/errors.ts";

describe("noticeReason", () => {
  test("keeps the status and the sentence, drops the payload", () => {
    const err = new Error(
      'LLM stream request failed: HTTP 429 — {"error":"You\'ve exceeded your subscription rate limits. Upgrade, or try again later. You can view your usage at https://synthetic.new/billing"}',
    );
    expect(noticeReason(err)).toBe("429 · You've exceeded your subscription rate limits");
  });

  test("reads a nested error object the way the provider wrote it", () => {
    const err = new Error(
      'Anthropic request failed: HTTP 429 — {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}',
    );
    expect(noticeReason(err)).toBe("429 · Number of requests has exceeded your rate limit");
  });

  test("a bare sentence after the status is the answer", () => {
    expect(noticeReason(new Error("OpenAI request failed: HTTP 529 — overloaded"))).toBe(
      "529 · overloaded",
    );
  });

  test("network failures keep their own words, and lose their line breaks", () => {
    expect(noticeReason(new Error("fetch failed\n  ECONNRESET"))).toBe("fetch failed ECONNRESET");
  });

  test("a long sentence is bounded, never a paragraph", () => {
    const reason = noticeReason(new Error(`HTTP 500 — ${"x".repeat(400)}`));
    expect(reason.length).toBeLessThanOrEqual(126);
    expect(reason.endsWith("…")).toBe(true);
  });

  test("a clause ends at the first full stop or semicolon", () => {
    expect(noticeReason(new Error("HTTP 502 — upstream says no. Also this; and that"))).toBe(
      "502 · upstream says no",
    );
  });
});
