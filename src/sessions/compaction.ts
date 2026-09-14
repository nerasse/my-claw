import type { MyClawConfig } from "../core/config.ts";
import { DEFAULT_COMPACTION_TAIL_TOKENS, resolveAutoCompactThreshold, resolveCompactionTailTokens } from "../core/config.ts";
import { resolveModelContextWindow } from "../llm/context-window.ts";
import { resolveUtilityLlmConfig } from "../llm/utility-model.ts";
import { llmCompleteStream } from "../llm/transport.ts";
import { tryResolveRunModel } from "../llm/run-model.ts";
import { availabilityWorld } from "../llm/world.ts";
import type { SessionData } from "./store.ts";
import { agentTypeOf, attributionParent } from "./store.ts";
import { recordApiCall } from "../analytics/usage-db.ts";
import { cacheAttributionOf } from "../llm/cache-policy.ts";
import { hooks } from "../hooks/index.ts";
import { usageModelOf } from "../llm/model-ref.ts";
import { sessionLogOf } from "./log-access.ts";
import { contextEntries } from "./projection.ts";
import type { Entry, PhaseEntry, ToolEntry, UserEntry, CompactionEntry } from "./log.ts";
import { estimateMessagesTokens } from "../llm/tokens.ts";
import { cutByOutputCeiling } from "../llm/truncation.ts";
import { messagesOf, promptOf } from "./projection.ts";
import { normalizeUntrusted } from "../agent/prompt/normalize-untrusted.ts";
import { firstSummaryPrompt, updateSummaryPrompt, SUMMARIZER_SYSTEM } from "./compaction-prompts.ts";
import { fileAnchorOf } from "./compaction-files.ts";
import type { SessionLog } from "./log.ts";
import { rethrowIfAborted } from "../core/aborted.ts";

const MIN_MESSAGES_TO_COMPACT = 10;

/**
 * How much of the end of the conversation survives a compaction verbatim.
 *
 * A token budget, not a count of entries. It used to be four entries, and an entry is a log unit
 * rather than a turn -- a `phase`, a `tool`, a `user` -- so four of them is routinely half of one
 * agent turn without the message that caused it, and the model restarted from the summary alone.
 * That is the worst place to stand: TRACE (arXiv:2608.06503, 4640 paired rollouts) measures plain
 * truncation *beating* LLM summarisation once the verbatim budget gets that tight.
 *
 * 20000 is the field's number: pi and oh-my-pi both keep exactly this, codex keeps 20000 of user
 * messages. Unlike codex's 64000 it covers tool results too, which is where the working state
 * actually lives.
 */
export const TAIL_BUDGET_TOKENS = DEFAULT_COMPACTION_TAIL_TOKENS;

/**
 * Why the summary carries no output cap.
 *
 * It used to. Codex's summarizer sends no `max_output_tokens` at all and lets the server own the
 * ceiling, and the cap we sent was the bug rather than the protection: `max_tokens` is one budget
 * for two things on a reasoning model, the thinking and the text, so no single value is right for
 * both. Measured on the session that would not compact (2026-09-10, opencode_go/deepseek-flash, a
 * 33k-token prompt rebuilt from that conversation): with a 16384 cap the call billed 14945 tokens
 * for a summary of about 7400 -- half the budget went to thinking, landing 9% under the cap. The
 * attempt before it crossed the cap and returned an empty `content`, which the app reported as
 * "the model returned an empty summary".
 *
 * Raising it only moves the line the thinking and the text fight over. Dropping it does not: the
 * model stops when it has finished writing, which is what it did before the cap existed (2000 to
 * 13000 tokens a summary across the month before). What protects the conversation is the gate, not
 * the cap: a truncated answer is still refused, on all three dialects.
 */

/** Tool output kept per call in the summarization prompt. */
const TOOL_OUTPUT_CHARS = 1200;

/**
 * The scaffolding around a stored summary. It is addressed to the model -- it tells it what the
 * block is and that the turn under it is the one to answer -- so it is written once, here, and
 * stripped once, by `summaryBodyOf`, rather than matched by hand wherever a channel replays it.
 */
const SUMMARY_OPEN = "[Prior context summarized]";
const SUMMARY_CLOSE = "[End of summary — respond to the message below]";

/**
 * The summary a boundary turn carries, without the instructions wrapped around it for the model.
 * A channel showing the raw content puts "respond to the message below" in the owner's thread,
 * addressed to nobody.
 */
export function summaryBodyOf(content: string): string {
  let body = content;
  if (body.startsWith(SUMMARY_OPEN)) body = body.slice(SUMMARY_OPEN.length);
  const close = body.lastIndexOf(SUMMARY_CLOSE);
  if (close !== -1) body = body.slice(0, close);
  return body.trim();
}

export interface CompactionResult {
  ok: boolean;
  reason?: string;
  beforeCount: number;
  afterCount: number;
  summary?: string;
  /**
   * The boundary that was written, when one was.
   *
   * The id is the entry's, so a channel that draws the boundary live and the same channel
   * replaying the history name the same thing and the device can drop the duplicate. `count` is
   * the turns the summary stands for, which is what the boundary says and is not derivable from
   * `beforeCount - afterCount` (the tail and the summary itself are in neither).
   */
  boundary?: { entryId: string; count: number; compactionMs?: number };
}

/**
 * Align tail boundary for entries. Never start the tail inside a tool block or mid-turn.
 * The boundary must land on a user entry or the start of a new model turn (first phase of a runId).
 */
function alignEntryTailBoundary(entries: Entry[], tailStart: number): number {
  let idx = tailStart;
  if (idx <= 0) return 0;

  // Walk back over tool entries
  while (idx > 0 && entries[idx]?.type === "tool") {
    idx -= 1;
  }
  // Walk back over phase entries that share a runId with the previous one (same model turn)
  while (idx > 0 && entries[idx]?.type === "phase") {
    const current = entries[idx] as PhaseEntry;
    const prev = entries[idx - 1];
    if (prev?.type === "phase" && (prev as PhaseEntry).runId === current.runId) {
      idx -= 1;
    } else {
      break;
    }
  }
  return idx;
}

/**
 * What a contiguous slice of a branch weighs as prompt.
 *
 * Measured through the projection rather than by summing entry texts, because the projection is
 * what decides the weight: phases of one turn fold into a single message, tool calls ride on it,
 * and `estimateMessagesTokens` adds the per-message overhead and the safety margin. `messagesOf`
 * and not `promptOf`: a slice of an already-resolved branch cannot be resolved again.
 *
 * The log carries no `providerMeta`, so replayed reasoning is invisible here. That makes this a
 * floor of what the live prompt weighs, which is the direction every other reader of occupancy
 * already errs in (docs/reasoning-replay.md).
 */
export function entriesPromptTokens(slice: readonly Entry[]): number {
  if (slice.length === 0) return 0;
  return estimateMessagesTokens(messagesOf(slice));
}

/**
 * The first index of the tail: walk back from the end until the budget is spent, then align.
 *
 * Aligning can only move the boundary earlier, so the tail can exceed the budget by the size of the
 * turn it had to keep whole. Splitting a tool block instead would hand the provider a result whose
 * call it never saw.
 */
function tailStartFor(entries: Entry[], budget: number): number {
  let start = entries.length;
  while (start > 0) {
    const candidate = entries.slice(start - 1);
    if (entriesPromptTokens(candidate) > budget) break;
    start -= 1;
  }
  // Never an empty tail: the turn the model is answering has to be in the prompt.
  if (start >= entries.length) start = entries.length - 1;
  return alignEntryTailBoundary(entries, start);
}

/** Serialize entries for the compaction prompt. */
function serializeEntriesForCompaction(entries: Entry[]): string {
  const parts: string[] = [];
  let currentRunId: string | undefined;
  let currentAssistantText = "";
  let currentToolNames: string[] = [];

  const flushAssistant = () => {
    if (currentAssistantText) {
      let text = `Assistant: ${currentAssistantText}`;
      if (currentToolNames.length > 0) {
        text += `\n[Tool calls: ${currentToolNames.join(", ")}]`;
      }
      parts.push(text);
      currentAssistantText = "";
      currentToolNames = [];
    }
  };

  for (const entry of entries) {
    if (entry.type === "user") {
      flushAssistant();
      currentRunId = undefined;
      parts.push(`User: ${(entry as UserEntry).text}`);
    } else if (entry.type === "phase") {
      const phase = entry as PhaseEntry;
      if (phase.runId !== currentRunId) {
        flushAssistant();
        currentRunId = phase.runId;
      }
      if (currentAssistantText) currentAssistantText += "\n";
      currentAssistantText += phase.text;
    } else if (entry.type === "tool") {
      const tool = entry as ToolEntry;
      currentToolNames.push(tool.name);
      parts.push(`Tool result (${tool.callId}): ${tool.output.slice(0, TOOL_OUTPUT_CHARS)}`);
    } else if (entry.type === "compaction") {
      // The previous summary is carried by `updateSummaryPrompt`, in its own block. Serialising it
      // here as well would hand the model the same text twice, once labelled as conversation.
    }
  }
  flushAssistant();

  // Everything above is the model's own transcript except the tool results, which are whatever a
  // page, a file or a command printed. This is normalisation, not a boundary (docs/untrusted-content.md):
  // what bounds the damage is SUMMARIZER_SYSTEM telling the model this block is data.
  return normalizeUntrusted(parts.join("\n\n---\n\n"), "compaction transcript");
}

/**
 * A compaction, decided but not yet performed.
 *
 * Splitting the decision from the LLM call is what lets the speculative path
 * (`compaction-speculative.ts`) run the expensive half early against a snapshot and commit it
 * later, with the blocking path taking the same three steps in a row.
 */
export interface CompactionPlan {
  /** Context entries as they stood when the plan was made. */
  entries: Entry[];
  /** What the summary stands for. */
  middle: Entry[];
  /** Where the verbatim tail starts. */
  firstKeptEntryId: string;
  /** The summary this one carries forward, when the branch already has a boundary. */
  previousSummary?: string;
  tokensBefore: number;
  /** The leaf the plan was made against: a snapshot is only claimable while it still holds. */
  leafId: string | null;
}

export type CompactionPlanResult = { ok: true; plan: CompactionPlan } | { ok: false; reason: string; count: number };

export function planCompaction(log: SessionLog, tailBudget: number = TAIL_BUDGET_TOKENS): CompactionPlanResult {
  const entries = contextEntries(log.entries(), log.leaf());
  if (entries.length < MIN_MESSAGES_TO_COMPACT) {
    return {
      ok: false,
      reason: `Session too short to compact (${entries.length} entries, minimum ${MIN_MESSAGES_TO_COMPACT}).`,
      count: entries.length,
    };
  }

  const tailStart = tailStartFor(entries, tailBudget);
  if (tailStart <= 0) {
    // Not a failure of the summarizer: the conversation is smaller than the slice a compaction
    // would have kept verbatim anyway, so there is nothing a summary could stand for.
    return {
      ok: false,
      reason: `Nothing to compact: the whole conversation fits in the ${tailBudget}-token verbatim tail.`,
      count: entries.length,
    };
  }

  const middle = entries.slice(0, tailStart);
  const firstKeptEntry = entries[tailStart];
  if (!firstKeptEntry) {
    return { ok: false, reason: "No entries in tail after boundary alignment.", count: entries.length };
  }

  // `contextEntries` puts the branch's last boundary first, so this is the summary the new one has
  // to carry forward rather than replace.
  const previous = entries[0]?.type === "compaction" ? (entries[0] as CompactionEntry).summary : undefined;

  return {
    ok: true,
    plan: {
      entries,
      middle,
      firstKeptEntryId: firstKeptEntry.id,
      ...(previous ? { previousSummary: previous } : {}),
      tokensBefore: estimateMessagesTokens(promptOf(log.entries(), log.leaf())),
      leafId: log.leaf(),
    },
  };
}

/**
 * The live mouth of a running summary.
 *
 * Fragments are batched before they leave: the summarizer streams a token at a time, and one hook
 * per token would be one frame per token on the wire for a wall of text the owner may not even be
 * looking at. A batch goes out when it is big enough to be worth a frame, or when the last one is
 * old enough that a silent pause would read as a stall.
 */
const PROGRESS_BATCH_CHARS = 240;
const PROGRESS_BATCH_MS = 400;

function compactionProgress(
  sessionId: string,
  event: "session:compact:progress" | "session:compact:reasoning" = "session:compact:progress",
): { push: (chunk: string) => void; flush: () => void } {
  let pending = "";
  let lastAt = Date.now();
  const send = (): void => {
    if (!pending) return;
    hooks.emit(event, { sessionId, text: pending });
    pending = "";
    lastAt = Date.now();
  };
  return {
    push: (chunk: string) => {
      pending += chunk;
      if (pending.length >= PROGRESS_BATCH_CHARS || Date.now() - lastAt >= PROGRESS_BATCH_MS) send();
    },
    flush: send,
  };
}

const REFUSAL_PATTERNS = [
  /^i (?:cannot|can't|won't|am unable to)/i,
  /^sorry,? (?:i|but)/i,
  /^as an ai/i,
  /^je (?:ne peux pas|ne pas|suis (?:incapable|désolé)|refuse)/i,
  /^désolé,? (?:je|mais)/i,
  /^en tant qu('|e )ia/i,
];

export type SummaryResult =
  | { ok: true; summary: string; elapsedMs: number }
  | { ok: false; reason: string };

/**
 * Run the summarizer for a plan.
 *
 * The model is the one the session actually runs, agent pin and tag included -- not the raw session
 * override, which is absent on every chat that inherits a pin and made the summarizer resolve the
 * global default while the conversation ran something else. The agent comes from the session, so a
 * sub-agent or a cron job is summarized by its own model rather than the orchestrator's. The
 * dispatch in `llmComplete` accepts any wire protocol, so the session's own model summarizes it.
 */
export async function summarizeForCompaction(
  config: MyClawConfig,
  session: SessionData,
  plan: CompactionPlan,
  instructions?: string,
  signal?: AbortSignal,
  caller: "compaction" | "compaction-speculative" = "compaction",
  now: () => number = Date.now,
): Promise<SummaryResult> {
  const serialized = serializeEntriesForCompaction(plan.middle);
  const prompt = plan.previousSummary
    ? updateSummaryPrompt(serialized, plan.previousSummary, instructions)
    : firstSummaryPrompt(serialized, instructions);

  const runModel = tryResolveRunModel(
    config,
    { agent: agentTypeOf(session), ...(session.modelOverride ? { sessionModel: session.modelOverride } : {}) },
    availabilityWorld(),
  );
  const resolved = resolveUtilityLlmConfig(config.llm, runModel?.apiModel ?? runModel?.model ?? session.modelOverride);
  // `max_tokens` on the wire comes from `limit.output`, so bounding the answer is a matter of
  // handing the transport a narrower limit rather than a new parameter on every transport.
  // `limit.output` is what the transport turns into `max_tokens`, so dropping it is how the summary
  // goes uncapped. Anthropic requires the field: its transport falls back to the model's own
  // declared ceiling, which is the same thing codex gets from leaving it out.
  const { output: _uncapped, ...limit } = resolved.limit ?? {};
  const llmConfig = {
    ...resolved,
    limit,
    // Maintenance on a conversation is still that conversation: the prompt it sends is that
    // conversation's own prefix, and a gateway routing on the session key refuses a call without
    // one -- docs/session-affinity.md.
    cacheKey: resolved.cacheKey ?? session.id,
  };

  const startedAt = now();
  // Streamed, not a single blocking call. The budget a transport enforces is "time with not one
  // byte received": a stream rearms it at every chunk and measures silence, while a one-shot call
  // turns it into a hard ceiling on the whole operation -- prompt prefill plus a 20k-token summary.
  // The OpenAI-compatible default of 120 s made that ceiling real: a compaction of this very
  // conversation timed out at 23:36 on 2026-09-11 and the same work took 85 s two minutes later,
  // while every Anthropic compaction in the history ran 180-360 s and only survived because that
  // transport allows 600. Streaming also gives the summary a live mouth: the fragments go out as
  // they arrive, so a window can watch it being written -- docs/compaction.md.
  const progress = compactionProgress(session.id);
  // The thinking goes out too, batched the same way. A summarizer inheriting the session's effort
  // spends that time before its first word, and the rule with a counter was the only thing on
  // screen for it -- docs/compaction.md.
  const thinking = compactionProgress(session.id, "session:compact:reasoning");
  const response = await llmCompleteStream(
    llmConfig,
    [
      { role: "system", content: SUMMARIZER_SYSTEM },
      { role: "user", content: prompt },
    ],
    (chunk: string) => progress.push(chunk),
    undefined,
    signal,
    { onText: async (delta: string) => void thinking.push(delta) },
  );
  progress.flush();
  thinking.flush();
  recordApiCall({
    sessionId: session.id,
    // Compaction is maintenance on a session, not work delegated by another one, so it bills
    // to the session it is compacting.
    parentSessionId: attributionParent(session),
    platform: session.platform,
    model: usageModelOf(llmConfig),
    baseUrl: llmConfig.baseUrl,
    streaming: false,
    caller,
    promptTokens: response.usage?.promptTokens ?? 0,
    completionTokens: response.usage?.completionTokens ?? 0,
    totalTokens: response.usage?.totalTokens ?? 0,
    cacheReadTokens: response.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: response.usage?.cacheWriteTokens ?? 0,
    toolCalls: 0,
    iteration: 0,
    durationMs: Date.now() - startedAt,
    proxyCostUsd: response.proxyCostUsd,
    upstreamApiBase: response.upstreamApiBase,
    ...cacheAttributionOf(llmConfig),
  });

  // Tested before the content, because the two are one event on a reasoning model: the reasoning
  // shares `max_tokens` with the text, so a model that thinks past the ceiling comes back with an
  // empty `content` and `finish_reason: "length"`. Calling that an empty summary named the symptom
  // and hid the cause. A summary that hit the ceiling is not a shorter summary either, it is a
  // summary missing its end -- and what it is missing is Next Steps, the section the next turn
  // needs most.
  if (response.incomplete || cutByOutputCeiling(response.finishReason)) {
    return { ok: false, reason: "The summary hit the output ceiling and is incomplete." };
  }
  const summary = response.content.trim();
  if (!summary) return { ok: false, reason: "The model returned an empty summary." };
  if (summary.length < 50) return { ok: false, reason: "The model returned a summary that is too short." };
  if (REFUSAL_PATTERNS.some((pattern) => pattern.test(summary))) {
    return { ok: false, reason: "The model refused to generate a summary." };
  }

  // The anchor is computed over the whole branch, not over `middle`: a path the tail still shows is
  // one the next turn is most likely to need, and naming it twice costs a line.
  const anchor = fileAnchorOf(plan.entries);
  return { ok: true, summary: anchor ? `${summary}\n\n${anchor}` : summary, elapsedMs: now() - startedAt };
}

/** Append the boundary. The turns it stands for stay on disk and stay on screen. */
export async function commitCompaction(
  log: SessionLog,
  plan: CompactionPlan,
  summary: string,
  compactionMs?: number,
): Promise<CompactionEntry> {
  const entry = log.append<CompactionEntry>({
    type: "compaction",
    prompt: true,
    summary,
    firstKeptEntryId: plan.firstKeptEntryId,
    tokensBefore: plan.tokensBefore,
    count: plan.middle.length,
    ...(compactionMs !== undefined ? { compactionMs } : {}),
  });
  await log.flush();
  return entry;
}

/**
 * The verbatim tail this session may keep, scaled to the window it actually runs in.
 *
 * Resolved from the session rather than handed down by the caller so `/compact` and the automatic
 * gates cannot end up computing two different tails for one conversation. The model is the one the
 * session runs (agent pin and tag included), the same resolution the summarizer uses.
 */
export function tailBudgetFor(config: MyClawConfig, session: SessionData): number {
  const agent = agentTypeOf(session);
  const runModel = tryResolveRunModel(
    config,
    { agent, ...(session.modelOverride ? { sessionModel: session.modelOverride } : {}) },
    availabilityWorld(),
  );
  const modelId = runModel?.model ?? session.modelOverride ?? config.llm?.defaultModel ?? config.llm?.model;
  if (!modelId) return resolveCompactionTailTokens(config);
  const window = resolveModelContextWindow(config, modelId, session.contextOverride, agent);
  return resolveCompactionTailTokens(config, window.effective * resolveAutoCompactThreshold(config, window.effective));
}

export async function compactSession(
  config: MyClawConfig,
  session: SessionData,
  instructions?: string,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<CompactionResult> {
  const log = await sessionLogOf(session.id);
  const planned = planCompaction(log, tailBudgetFor(config, session));
  hooks.emit("session:compact:start", {
    sessionId: session.id,
    messageCount: planned.ok ? planned.plan.entries.length : planned.count,
  });

  // Paired with the start above on every path, including the two that give up before summarizing
  // and the abort that rethrows: whoever showed the operation must be told it is over.
  try {
    if (!planned.ok) {
      return { ok: false, reason: planned.reason, beforeCount: planned.count, afterCount: planned.count };
    }
    const plan = planned.plan;
    const beforeCount = plan.entries.length;

    try {
      const summarized = await summarizeForCompaction(config, session, plan, instructions, signal, "compaction", now);
      if (!summarized.ok) {
        return { ok: false, reason: summarized.reason, beforeCount, afterCount: beforeCount };
      }
      const boundary = await commitCompaction(log, plan, summarized.summary, summarized.elapsedMs);
      session.lastActiveAt = new Date().toISOString();
      const afterCount = contextEntries(log.entries(), log.leaf()).length;
      hooks.emit("session:compact:end", {
        sessionId: session.id,
        beforeCount,
        afterCount,
        summaryLength: summarized.summary.length,
      });
      return {
        ok: true,
        beforeCount,
        afterCount,
        summary: summarized.summary,
        boundary: { entryId: boundary.id, count: boundary.count, compactionMs: summarized.elapsedMs },
      };
    } catch (err) {
      // An abort is the owner stopping the run, not a compaction that failed on its own terms.
      rethrowIfAborted(err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      hooks.emit("session:compact:error", { sessionId: session.id, reason: errorMsg });
      return { ok: false, reason: `Compaction error: ${errorMsg}`, beforeCount, afterCount: beforeCount };
    }
  } finally {
    hooks.emit("session:compact:settled", { sessionId: session.id });
  }
}
