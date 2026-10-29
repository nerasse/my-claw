/**
 * When a provider's failure is about *it* rather than about the request -- one answer for every
 * path that talks to a model.
 *
 * Two families, and both are worth another provider:
 *
 * - **The far side is down, unreachable, overloaded or out of money.** Outage-class statuses
 *   (server errors, payment required, rate limited), network faults, an auth failure that is a
 *   key problem on that one provider, a model or endpoint that no longer exists there. The
 *   request itself was fine.
 * - **The far side refuses the content on policy.** A moderation refusal is the provider's own:
 *   another provider's policy differs, and the very same prompt usually goes through. Measured
 *   2026-09-21: a research pass died four times in a row on `[invalid_request_error] Content
 *   Exists Risk` while healthy providers sat unused, and the parent had to do the work itself.
 *
 * What is deliberately *not* here: a malformed request. A 400 that names a shape we sent wrong is
 * our bug, and rerouting it would hide the bug behind a model that happens to tolerate it.
 */

// Outage-class statuses: server errors, payment required, rate limited, request timeout.
const OUTAGE_STATUSES = new Set([402, 408, 425, 429, 500, 502, 503, 504, 529]);
const OUTAGE_TEXT = /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR_|fetch failed|overloaded|rate limit|quota|credit|balance|subscription/i;

/**
 * The body saying, in its own words, that the fault is on the far side.
 *
 * A gateway has no status of its own for "my upstream answered with something that was not JSON",
 * so it reaches for whatever its edge returns -- OpenCode Go sends a **403** for exactly that, and
 * 403 is where this predicate used to stop reading. The message is the evidence and the status is
 * an accident of the edge, so the message wins. Measured 2026-09-20: a ten-minute run with
 * twenty-six tool calls died on it while a healthy second route candidate sat unused.
 *
 * "Upstream request failed" is not evidence: it is the envelope OpenCode Go puts around every
 * upstream answer, a malformed request's included. The bracketed type inside it is what tells.
 * Read as an outage, the envelope retried a 422 naming the field we sent wrong for three and a half
 * minutes, on the same upstream, before the run died of it anyway (measured 2026-09-24).
 */
const UPSTREAM_FAULT = /\[server_error\]|upstream response was not valid json|bad gateway|invalid upstream|upstream (?:error|failure|timeout)/i;

/**
 * The body saying the provider will not carry this content, whatever we do to the request.
 *
 * Only ever read on a 4xx: the same words in a tool result or in a page are just words.
 */
const POLICY_REFUSAL = /content exists risk|content[_ ]?(?:policy|filter|moderation)|flagged by|moderation|policy violation|prohibited content|safety (?:system|filter|policy)|usage policies/i;

/** A far-side fault: the request was fine, the provider was not. */
export function isOutageClass(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  const message = String((err as Error | undefined)?.message ?? err ?? "");
  if (UPSTREAM_FAULT.test(message)) return true;
  if (typeof status === "number") {
    if (OUTAGE_STATUSES.has(status) || (status >= 500 && status < 600)) return true;
    if (status === 401) return true;
    if (status === 403) return /auth|unauthori[sz]ed|credential|api[- ]?key|permission|forbidden/i.test(message);
    if (status === 404) return /model|endpoint|no endpoints|not found/i.test(message);
    return false;
  }
  return /LLM circuit breaker open|circuit breaker is open|timeout|timed out|stalled|stream.*closed|empty (?:response|completion)|no (?:content|output)|auth|unauthori[sz]ed|credential|api[- ]?key|no endpoints|model.*not found/i.test(message) || OUTAGE_TEXT.test(message);
}

/**
 * A quota or a balance spent. Rerouted like any outage, but never waited for: no wait inside a run
 * refills it, and the three waits it used to get cost the veille of 2026-09-29 four minutes per
 * volet before it moved on.
 *
 * The phrases are the ones the providers actually send, not the ones that sound right. Measured
 * 2026-10-27, both of these were read as an ordinary 429 and waited 30 s, 60 s and 120 s on a wall
 * that does not open inside a run, with the transport adding three requests of its own each time:
 *
 * - ChatGPT plan: `{"type":"usage_limit_reached","message":"The usage limit has been reached",
 *   "plan_type":"plus","resets_at":...}`
 * - OpenCode Go: `Go usage limit exceeded`
 * - Synthetic, measured 2026-10-28: `{"error":"You've exceeded your subscription rate limits.
 *   Upgrade, or try again later. You can view your usage at https://synthetic.new/billing"}`.
 *   It says "rate limits", but the plan is what ran out: `/quotas` answered with its weekly bar at
 *   100 % and a tick a couple of hours out. Read as a rate limit, it waited 30 s, 60 s and 120 s
 *   and opened the breaker on `https://api.synthetic.new/openai/v1`.
 *
 * A rate limit is deliberately *not* here: it clears on its own, which is exactly what a wait is
 * for. The distinction is the noun -- a **limit** of the plan, not a **rate**.
 */
const QUOTA_SPENT = /quota (?:exhausted|exceeded)|insufficient[_ ]quota|exceeded your current quota|insufficient (?:credits|balance|funds)|out of credits|credit balance is too low|can only afford|usage_limit_reached|usage limit (?:has been |was )?(?:exceeded|reached)|exceeded your subscription (?:rate )?limits?/i;

export function isQuotaSpent(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  const message = String((err as Error | undefined)?.message ?? err ?? "");
  return (status === undefined || status === 402 || status === 429) && QUOTA_SPENT.test(message);
}

/** A refusal the provider owns: the content, not the request. */
export function isPolicyRefusal(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  if (typeof status !== "number" || status < 400 || status >= 500) return false;
  return POLICY_REFUSAL.test(String((err as Error | undefined)?.message ?? err ?? ""));
}

/** Worth another provider. */
export function isProviderOutage(err: unknown): boolean {
  return isOutageClass(err) || isPolicyRefusal(err);
}

/**
 * Worth another provider, for a third reason: the model itself lacks a capability the request
 * needs, and said so by name.
 *
 * This is deliberately *not* a malformed request, which stays ours and must surface as itself.
 * A model that refuses `cache_control` or that cannot answer without the reasoning of the turns it
 * is shown is telling us what it *is*; another model is a legitimate answer, and the request has
 * already been repaired for this one before we get here (docs/llm-request-repair.md).
 *
 * Only the provider marks this, and only from a refusal the repair table recognised: an unknown
 * 400 keeps its old path.
 */
export function isCapabilityRefusal(err: unknown): boolean {
  const capability = (err as { capability?: string } | undefined)?.capability;
  return typeof capability === "string" && capability.length > 0;
}
