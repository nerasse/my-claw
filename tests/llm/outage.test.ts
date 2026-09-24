/**
 * What counts as the provider's own failure, and what is ours.
 *
 * The distinction decides whether a run moves to another provider or dies where it stands, so the
 * two sides are pinned here: the far side's faults (and the policy refusals it owns) on one side,
 * a request we sent wrong on the other.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { isOutageClass, isPolicyRefusal, isProviderOutage } from "../../src/llm/outage.ts";

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
