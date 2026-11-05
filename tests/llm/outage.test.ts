/**
 * What counts as the provider's own failure, and what is ours.
 *
 * The distinction decides whether a run moves to another provider or dies where it stands, so the
 * two sides are pinned here: the far side's faults (and the policy refusals it owns) on one side,
 * a request we sent wrong on the other.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { isOutageClass, isPolicyRefusal, isProviderOutage, isQuotaSpent } from "../../src/llm/outage.ts";

function failure(status: number, message: string): Error & { status?: number } {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

test("the far side's faults are reroutable", () => {
  assert.equal(isOutageClass(failure(429, "rate limited")), true);
  assert.equal(isOutageClass(failure(402, "out of credits")), true);
  assert.equal(isOutageClass(failure(503, "service unavailable")), true);
  assert.equal(isOutageClass(failure(401, "invalid api key")), true);
  assert.equal(isOutageClass(failure(404, "model not found")), true);
  assert.equal(isOutageClass(failure(403, "Upstream request failed: [server_error] Upstream response was not valid JSON")), true);
});

test("a policy refusal is the provider's own, so another provider is worth trying", () => {
  // Measured 2026-09-21: four attempts of one research pass died on this, on three providers, and
  // the parent did the work itself. Another provider's policy differs; the request was fine.
  const refusal = failure(400, "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Content Exists Risk");
  assert.equal(isPolicyRefusal(refusal), true);
  assert.equal(isProviderOutage(refusal), true);
});

test("a request we sent wrong is not the provider's failure", () => {
  // Our own bug, and the one measured the same evening: glm-5.3 wants a string where we sent a
  // parts array. Rerouting would hide it behind a model that tolerates the shape.
  const shape = failure(400, '{"error":{"type":"invalid_request_error","message":"4 request validation errors: Input should be a valid string, field: \'messages[0].content.str\'"}}');
  assert.equal(isPolicyRefusal(shape), false);
  assert.equal(isProviderOutage(shape), false);
});

test("a moderation word in a 5xx is still just an outage", () => {
  assert.equal(isPolicyRefusal(failure(502, "upstream said: content filter unavailable")), false);
  assert.equal(isProviderOutage(failure(502, "upstream said: content filter unavailable")), true);
});

test("the gateway's envelope says nothing about whose fault it is: the bracketed type does", () => {
  // OpenCode Go wraps every upstream answer in "Upstream request failed: [<type>] ...". The
  // envelope alone used to read as an outage, so a 422 naming the field we sent wrong was retried
  // for 30 s, 60 s and 120 s on the same upstream and the run died anyway (measured 2026-09-24).
  const ours = failure(
    422,
    "LLM stream request failed: HTTP 422 — Upstream request failed: [invalid_request_error] Input should be a valid string",
  );
  assert.equal(isOutageClass(ours), false);
  assert.equal(isProviderOutage(ours), false);

  // The same envelope around the far side's faults, as the logs have them, still reroutes.
  const invalidJson = "Error from provider (Console Go): Upstream request failed: [server_error] Upstream response was not valid JSON";
  assert.equal(isProviderOutage(failure(400, `LLM request failed: HTTP 400 — ${invalidJson}`)), true);
  assert.equal(isProviderOutage(failure(403, `LLM request failed: HTTP 403 — ${invalidJson}`)), true);
  assert.equal(
    isProviderOutage(failure(402, "LLM request failed: HTTP 402 — Error from provider (Console Go): Upstream request failed: [insufficient_user_quota] You're out of credits")),
    true,
  );
  assert.equal(
    isProviderOutage(failure(400, "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Content Exists Risk")),
    true,
  );
});

/**
 * The quota phrases the providers actually send.
 *
 * Every one below was read as an ordinary 429 before 2026-10-27, which is why the run waited 30 s,
 * 60 s and 120 s on a wall that does not open inside a run, while the transport added three
 * requests of its own on each of those four turns -- twelve requests and 210 seconds for one
 * account, measured on `chatgpt-2` at 22:16.
 */
test("a plan limit is a spent quota, whichever words the provider picked", () => {
  const quota = (status: number, message: string): Error & { status?: number } => failure(status, message);

  // ChatGPT plan, verbatim from the log.
  assert.equal(
    isQuotaSpent(quota(429, 'Codex request failed: HTTP 429 — {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1793141751}}')),
    true,
  );
  // OpenCode Go, verbatim.
  assert.equal(isQuotaSpent(quota(429, "LLM request failed: HTTP 429 — Go usage limit exceeded")), true);
  // Synthetic, verbatim from the 2026-10-28 log: it says "rate limits", the plan is what ran out
  // (its weekly bar answered 100 % used), so it must not be waited on as a per-minute limit.
  assert.equal(
    isQuotaSpent(
      quota(
        429,
        `LLM stream request failed: HTTP 429 — {"error":"You've exceeded your subscription rate limits. Upgrade, or try again later. You can view your usage at https://synthetic.new/billing"}`,
      ),
    ),
    true,
  );
  // litellm, which already worked: kept so the widen does not become a replace.
  assert.equal(isQuotaSpent(quota(429, "litellm.RateLimitError: Custom_openaiException - quota exhausted")), true);
  assert.equal(isQuotaSpent(quota(402, "insufficient credits")), true);
});

test("a rate limit is not a quota: waiting is exactly what it is for", () => {
  // The distinction is the noun. A rate limit clears on its own inside a run; a plan limit does not,
  // and waiting on it only delays the move to a provider that can still answer.
  assert.equal(isQuotaSpent(failure(429, "rate limit reached for requests per minute")), false);
  assert.equal(isQuotaSpent(failure(429, "Too many concurrent requests")), false);
  assert.equal(
    isQuotaSpent(failure(429, '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}')),
    false,
  );
});

test("a stream that died is the wire's fault, not the request's", () => {
  // The one that mattered (2026-11-05): a Codex stream error with no code at all, after 26 tool
  // calls. Nothing about the request changed between the first byte and the last, so the run is
  // allowed to finish it somewhere else instead of dying where it stands.
  assert.equal(isOutageClass(new Error("Codex stream error : unknown")), true);
  assert.equal(isOutageClass(new Error("Anthropic stream error overloaded_error: Overloaded")), true);
  assert.equal(isOutageClass(new Error('{"type":"response.failed","response":{"error":{"code":"server_error"}}}')), true);
  // An overflow is recovered by compacting, never by another provider.
  assert.equal(isOutageClass(new Error("Codex context_length_exceeded: too long")), false);
});
