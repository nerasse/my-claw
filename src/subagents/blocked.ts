/**
 * What a caller is told when a sub-agent's run stopped on its provider, in terms it can act on.
 *
 * A run that fails on a spent quota has usually already worked: it edited files, ran tests, or
 * started a build. The old answer was `String(err)`, which left the parent to read prose and to
 * guess whether anything had happened -- and a guess in either direction is expensive. "Nothing
 * happened" makes it start over on work already done; "it finished" makes it trust tests nobody ran.
 *
 * Three claims, and each is derived rather than inferred:
 *
 * - the **class** of failure comes from `classifyProviderFailure`, the same predicates the
 *   fallback and the retry schedule read;
 * - **progress** is read off the log: a tool entry means tools ran. No entry does not mean nothing
 *   happened -- a call cut off mid-flight settles nothing -- so it says `unknown`, never `none`;
 * - the **wait**, when the provider named one, comes from its own payload. Nothing is invented:
 *   an invented recovery time parks a task on a wall that never opens.
 *
 * docs/provider-failures.md.
 */

import { classifyProviderFailure, quotaHintOf, type ProviderFailure } from "../llm/outage.ts";

export interface BlockedReport {
  status: "blocked";
  agentId: string;
  /** Why the provider refused, or `provider_error` when it failed for a reason we do not name. */
  reason: ProviderFailure | "provider_error";
  /** What the failing call was addressed to: the model, and the provider entry that owns it. */
  requested?: { model?: string; provider?: string };
  /** `possible` once a tool settled; `unknown` otherwise, because a cut-off call settles nothing. */
  partialWork: "possible" | "unknown";
  historyPreserved: true;
  resumable: true;
  /** The provider's own re-opening time, when its payload carried one. */
  retry: { eligibleAt?: string; source: "provider_hint" | "none" };
  nextActions: Array<"resume" | "resume_with_allowed_config" | "wait" | "inspect" | "fix_auth">;
}

export function blockedReportOf(input: {
  agentId: string;
  err: unknown;
  /** Whether the failed run wrote any tool entry, read from its log by the caller. */
  toolsRan: boolean;
  now?: number;
}): BlockedReport {
  const reason = classifyProviderFailure(input.err) ?? "provider_error";
  const hint = quotaHintOf(input.err, input.now);
  const target = input.err as { model?: unknown; provider?: unknown } | undefined;
  const requested = {
    ...(typeof target?.model === "string" && target.model ? { model: target.model } : {}),
    ...(typeof target?.provider === "string" && target.provider ? { provider: target.provider } : {}),
  };
  const nextActions: BlockedReport["nextActions"] = reason === "auth"
    ? ["fix_auth", "inspect"]
    : [
        "resume_with_allowed_config",
        ...(hint.eligibleAt ? (["wait"] as const) : []),
        "resume",
        "inspect",
      ];
  return {
    status: "blocked",
    agentId: input.agentId,
    reason,
    ...(Object.keys(requested).length > 0 ? { requested } : {}),
    partialWork: input.toolsRan ? "possible" : "unknown",
    historyPreserved: true,
    resumable: true,
    retry: hint,
    nextActions,
  };
}

/** The failure as one sentence: what happened, on what, and what it means for the work. */
function sentenceOf(report: BlockedReport): string {
  const on = report.requested?.model
    ? ` on ${report.requested.model}${report.requested.provider ? ` (${report.requested.provider})` : ""}`
    : "";
  switch (report.reason) {
    case "quota_exhausted":
      return `sub-agent ${report.agentId} hit a spent quota${on}`;
    case "rate_limited":
      return `sub-agent ${report.agentId} was rate limited${on}`;
    case "auth":
      return `sub-agent ${report.agentId} could not sign in to its provider${on}`;
    case "capability":
      return `sub-agent ${report.agentId} asked for something its model cannot do${on}`;
    case "policy_refusal":
      return `the provider refused the content of sub-agent ${report.agentId}'s run${on}`;
    case "invalid_request":
      return `the request sub-agent ${report.agentId} sent was refused${on}`;
    case "transport":
      return `sub-agent ${report.agentId} lost its provider${on}`;
    default:
      return `sub-agent ${report.agentId} failed${on}`;
  }
}

/**
 * The report as a caller reads it: one sentence, what survived, what to do, then the same report
 * as one JSON object so a parent that wants fields does not have to parse the sentence.
 */
export function describeBlocked(report: BlockedReport, detail: string): string {
  const work = report.partialWork === "possible"
    ? "Tools already ran, so files or processes may have changed: inspect before you redo anything."
    : "No tool settled before it stopped, and a call cut off mid-flight settles nothing: treat the work as unknown rather than absent.";
  const when = report.retry.eligibleAt ? ` The provider says the limit reopens at ${report.retry.eligibleAt}.` : "";
  return `${sentenceOf(report)}. ${detail.trim()}\n\n${work} Its session and history are kept: send(id: "${report.agentId}") with no message resumes it where it stopped.${when}\n\nblocked: ${JSON.stringify(report)}`;
}
