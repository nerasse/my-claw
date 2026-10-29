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
import { sessionLogOf } from "../sessions/log-access.ts";
import { pathOf, type ToolEntry } from "../sessions/log.ts";

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
  /**
   * What the run had actually done when it stopped, rebuilt from its own tool entries.
   *
   * Deliberately not a model's summary: the run may have no quota left to write one, and a summary
   * produced *by* the model that failed is not evidence about what it did. These are the settled
   * calls, their real exit state, and the paths the log already names.
   */
  handoff?: Handoff;
  nextActions: Array<"resume" | "resume_with_allowed_config" | "wait" | "inspect" | "fix_auth">;
}

/** One settled tool call, as the log records it. */
export interface HandoffCall {
  name: string;
  ok: boolean;
  /** Milliseconds the call took, when the log carries it. */
  durationMs?: number;
  /** The call was still running when the run ended: its effect is unknown, not absent. */
  uncertain?: true;
}

/**
 * What a successor needs to know before touching the same work.
 *
 * Built from records only, so a run that cannot answer again still hands off. Undefined when the
 * log kept nothing -- an empty handoff would read as "nothing happened", which is the one claim
 * this is not allowed to make.
 */
export interface Handoff {
  /** The settled calls, oldest first, capped: a roll of forty tools is not a handoff. */
  calls: HandoffCall[];
  /** How many calls the run made in total, so a capped list admits what it left out. */
  callCount: number;
  /** The last call that failed, which is usually where the next run should look first. */
  lastFailure?: HandoffCall;
}

export function blockedReportOf(input: {
  agentId: string;
  err: unknown;
  /** Whether the failed run wrote any tool entry, read from its log by the caller. */
  toolsRan: boolean;
  /** The run's tool entries, so the report can say what it did instead of only that it did something. */
  calls?: HandoffCall[];
  now?: number;
}): BlockedReport {
  const reason = classifyProviderFailure(input.err) ?? "provider_error";
  const hint = quotaHintOf(input.err, input.now);
  const target = input.err as { model?: unknown; provider?: unknown } | undefined;
  const requested = {
    ...(typeof target?.model === "string" && target.model ? { model: target.model } : {}),
    ...(typeof target?.provider === "string" && target.provider ? { provider: target.provider } : {}),
  };
  const handoff = input.calls ? handoffOf(input.calls) : undefined;
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
    ...(handoff ? { handoff } : {}),
    nextActions,
  };
}

/** The cap: enough to see the shape of the work, few enough to stay a handoff. */
const HANDOFF_CALLS = 12;

function handoffOf(calls: HandoffCall[]): Handoff | undefined {
  if (calls.length === 0) return undefined;
  const lastFailure = [...calls].reverse().find((call) => !call.ok);
  return {
    calls: calls.slice(-HANDOFF_CALLS),
    callCount: calls.length,
    ...(lastFailure ? { lastFailure } : {}),
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
  return `${sentenceOf(report)}. ${detail.trim()}\n\n${work}${handoffLine(report.handoff)} Its session and history are kept: send(id: "${report.agentId}") with no message resumes it where it stopped.${when}\n\nblocked: ${JSON.stringify(report)}`;
}

/** What the run got done, in the receipt a successor reads before touching the same work. */
function handoffLine(handoff: Handoff | undefined): string {
  if (!handoff) return "";
  const shown = handoff.calls.map((call) => `${call.name}${call.ok ? "" : " (failed)"}${call.uncertain ? " (did not settle)" : ""}`);
  const omitted = handoff.callCount - handoff.calls.length;
  const first = handoff.lastFailure
    ? ` The last one to fail was ${handoff.lastFailure.name}, so start there.`
    : "";
  return ` It got through ${handoff.callCount} tool call${handoff.callCount === 1 ? "" : "s"}: ${shown.join(", ")}${omitted > 0 ? ` (and ${omitted} earlier)` : ""}.${first}`;
}

/**
 * The tool calls the agent settled since its last user turn, as the log recorded them.
 *
 * This is the handoff, and it is deliberately a read: the run may have no quota left to write a
 * summary, and a summary written by the model that failed is not evidence of what it did. An empty
 * answer only ever lowers the report to `unknown` -- `blockedReportOf` never says `none`, because a
 * call cut off mid-flight leaves no entry and a parent told "nothing happened" redoes work already
 * done.
 */
export async function handoffCallsIn(id: string): Promise<HandoffCall[]> {
  // No existence guard on purpose: the log is the evidence, and a session whose meta never landed
  // (the run died before its first persist) is exactly the case a handoff matters most in.
  try {
    const log = await sessionLogOf(id);
    const path = pathOf(log.entries(), log.leaf());
    let lastUser = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i]!.type === "user") {
        lastUser = i;
        break;
      }
    }
    return path
      .slice(lastUser + 1)
      .filter((entry): entry is ToolEntry => entry.type === "tool")
      .map((entry) => ({
        name: entry.name,
        ok: entry.ok,
        ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
        ...(entry.interrupted ? { uncertain: true as const } : {}),
      }));
  } catch {
    return [];
  }
}
