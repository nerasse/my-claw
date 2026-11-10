import type { MyClawConfig, ResolvedLlmConfig } from "../core/config.ts";
import { DEFAULT_COMPACTION_TAIL_TOKENS, resolveAutoCompactThreshold, resolveCompactionTailTokens } from "../core/config.ts";
import { resolveFullContextWindow } from "../llm/context-window.ts";
import { resolveUtilityLlmConfig } from "../llm/utility-model.ts";
import { providerFallbackTargets } from "../llm/provider-fallback.ts";
import { isCapabilityRefusal, isProviderOutage, isQuotaSpent } from "../llm/outage.ts";
import { isQuotaFailure } from "../llm/quota/retry.ts";
import { waitsForQuotaOf } from "./siphon.ts";
import { llmCompleteStream } from "../llm/transport.ts";
import { wallConfig } from "../llm/quota/wall.ts";
import { tryResolveRunModel } from "../llm/run-model.ts";
import { availabilityWorld } from "../llm/world.ts";
import type { SessionData } from "./store.ts";
import { agentTypeOf, attributionParent, usageFolderOf, usageWorkspaceOf } from "./store.ts";
import { recordApiCall } from "../analytics/usage-db.ts";
import { indexCompactionArchive } from "../conversations/store.ts";
import { cacheAttributionOf } from "../llm/cache-policy.ts";
import { hooks } from "../hooks/index.ts";
import { usageModelOf } from "../llm/model-ref.ts";
import { sessionLogOf } from "./log-access.ts";
import { contextEntries } from "./projection.ts";
import type { Entry, PhaseEntry, ToolEntry, UserEntry, CompactionEntry, CompactionStoppedEntry } from "./log.ts";
import { estimateMessagesTokens, estimateTokens } from "../llm/tokens.ts";
import { cutByOutputCeiling } from "../llm/truncation.ts";
import type { ChatMessage, LlmResponse } from "../llm/provider.ts";
import { messagesOf, promptOf } from "./projection.ts";
import { normalizeUntrusted } from "../agent/prompt/normalize-untrusted.ts";
import { CONTINUE_SUMMARY, conversationSummaryPrompt, firstSummaryPrompt, splitSummaryOutput, updateSummaryPrompt, SUMMARIZER_SYSTEM } from "./compaction-prompts.ts";
import { fileAnchorOf } from "./compaction-files.ts";
import { newEntryId, type SessionLog } from "./log.ts";
import { isAbort, rethrowIfAborted } from "../core/aborted.ts";
import { log } from "../utils/logger.ts";

const MIN_MESSAGES_TO_COMPACT = 10;

/**
 * How much of the owner's own words survive a compaction verbatim -- codex's shape, taken whole
 * (owner, 2026-10-04: "vraiment la même chose").
 *
 * The prompt after a compaction is the owner's most recent messages, newest kept first until this
 * budget is spent and the oldest cut to fit, then the summary, then whatever the pass had to keep
 * whole to stay valid (the message being answered, or the turn whose tool results the run is about
 * to read). The assistant's prose and old tool results are not kept: the summary carries the state,
 * and a 64 000-token tail of everything made every summary re-describe what the tail already held.
 */
export const RETAINED_BUDGET_TOKENS = DEFAULT_COMPACTION_TAIL_TOKENS;

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
   * The pass died on a wall the conversation had asked to wait out (`quotaRetry.enabled`): the
   * caller arms the wait and the compaction runs when the plan reopens, instead of falling to the
   * next candidate the way an ordinary provider failure does -- docs/quota-retry.md.
   */
  retryableQuota?: boolean;
  /** What failed, for the wait to be decided on (the provider rides on it). */
  cause?: unknown;
  /** What the boundary archived, when it archived something (`CompactionEntry.archive`). */
  archive?: string;
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
 * Serialize entries for the compaction prompt.
 *
 * The previous boundary's kept messages lead: they are the owner's words the prompt still showed,
 * replayed before its summary, and the summarizer has to read them as the model did.
 */
function serializeEntriesForCompaction(entries: Entry[]): string {
  const parts: string[] = [];
  const previous = entries[0]?.type === "compaction" ? (entries[0] as CompactionEntry) : undefined;
  for (const text of previous?.retained ?? []) parts.push(`User: ${text}`);
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
  /**
   * Where the kept tail starts, when something has to be kept whole: the message being answered, or
   * the turn whose tool results the run is about to read. Absent when nothing is: the boundary then
   * resumes after itself, resolved at commit (`commitCompaction`) so turns added meanwhile survive.
   */
  firstKeptEntryId?: string;
  /** The owner's recent messages, replayed verbatim before the summary (`CompactionEntry.retained`). */
  retained: string[];
  /** The summary this one carries forward, when the branch already has a boundary. */
  previousSummary?: string;
  /**
   * The previous summary predates the archive and still holds the whole history: the commit
   * archives it as it is, and the summarizer is told not to rewrite that history.
   */
  previousIsLegacy?: boolean;
  tokensBefore: number;
  /** The leaf the plan was made against: a snapshot is only claimable while it still holds. */
  leafId: string | null;
}

export type CompactionPlanResult = { ok: true; plan: CompactionPlan } | { ok: false; reason: string; count: number };

/**
 * The conversation's own prefix, when the caller has it.
 *
 * A run builds the system prompt and the tool definitions before it can compact, so the summarizer
 * can send the exact prefix the conversation already warmed: same system bytes, same tools, then
 * the history and the summary instruction as the last user turn. Absent (a manual `/compact`, the
 * speculative pass), the summarizer falls back to its own system prompt and the serialized middle.
 */
export interface CompactionPrefix {
  systemPrompt: string;
  tools: unknown[];
}

/** A message cut to `tokens`, its head and its end kept, the middle named rather than lost. */
function cutToTokens(text: string, tokens: number): string {
  const chars = Math.max(0, tokens * 4);
  if (text.length <= chars) return text;
  const half = Math.floor(chars / 2);
  return `${text.slice(0, half)}\n[... ${text.length - chars} characters cut ...]\n${text.slice(text.length - half)}`;
}

/**
 * The owner's words a boundary keeps: newest first until the budget is spent, the one that crosses
 * it cut to what is left, returned oldest first -- codex's `build_compacted_history`. The candidates
 * are the previous boundary's kept messages, then every owner turn it did not cover.
 */
export function retainedMessages(candidates: readonly string[], budget: number): string[] {
  const kept: string[] = [];
  let left = budget;
  for (let i = candidates.length - 1; i >= 0 && left > 0; i--) {
    const text = candidates[i]!;
    if (!text.trim()) continue;
    const cost = estimateTokens(text);
    if (cost <= left) {
      kept.push(text);
      left -= cost;
    } else {
      kept.push(cutToTokens(text, left));
      left = 0;
    }
  }
  return kept.reverse();
}

/**
 * Where the kept tail starts, or `entries.length` when nothing has to stay whole.
 *
 * Two cases keep something, and both are about validity, not memory. A branch ending on the owner's
 * message is a run about to answer it: that message must follow the summary. A branch ending on tool
 * results is a run between two iterations: the turn that called them must stay with them, or the next
 * call reads results whose call it never saw -- unless that turn alone is over the budget, in which
 * case the summary, which saw it, carries it. Anything else (a finished answer, a `/compact` at
 * rest) keeps nothing, as codex does.
 */
function keptTailStart(entries: Entry[], budget: number): number {
  const last = entries[entries.length - 1];
  if (!last) return 0;
  if (last.type === "user") return entries.length - 1;
  if (last.type === "tool") {
    const turnStart = alignEntryTailBoundary(entries, entries.length - 1);
    if (entriesPromptTokens(entries.slice(turnStart)) <= budget) return turnStart;
  }
  return entries.length;
}

export async function planCompaction(log: SessionLog, retainedBudget: number = RETAINED_BUDGET_TOKENS): Promise<CompactionPlanResult> {
  // From the last boundary down: what a prompt would carry, which is all this plan can change.
  const context = await log.context();
  const entries = contextEntries(context, log.leaf());
  if (entries.length < MIN_MESSAGES_TO_COMPACT) {
    return {
      ok: false,
      reason: `Session too short to compact (${entries.length} entries, minimum ${MIN_MESSAGES_TO_COMPACT}).`,
      count: entries.length,
    };
  }

  const tailStart = keptTailStart(entries, retainedBudget);
  // `contextEntries` puts the branch's last boundary first, so this is the summary the new one has
  // to carry forward rather than replace.
  const previous = entries[0]?.type === "compaction" ? (entries[0] as CompactionEntry) : undefined;
  const middle = entries.slice(0, tailStart);
  if (middle.filter((entry) => entry.type !== "compaction").length === 0) {
    // Not a failure of the summarizer: everything after the last boundary has to stay whole anyway,
    // so there is nothing a new summary could stand for.
    return { ok: false, reason: "Nothing to compact: everything since the last summary has to stay as it is.", count: entries.length };
  }

  const candidates = [
    ...(previous?.retained ?? []),
    ...middle.filter((entry): entry is UserEntry => entry.type === "user").map((entry) => entry.text),
  ];

  return {
    ok: true,
    plan: {
      entries,
      middle,
      ...(tailStart < entries.length ? { firstKeptEntryId: entries[tailStart]!.id } : {}),
      retained: retainedMessages(candidates, retainedBudget),
      ...(previous ? { previousSummary: previous.summary, ...(previous.archive === undefined ? { previousIsLegacy: true } : {}) } : {}),
      tokensBefore: estimateMessagesTokens(promptOf(context, log.leaf())),
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
  | { ok: true; summary: string; archive: string; elapsedMs: number }
  | { ok: false; reason: string; retryableQuota?: boolean; cause?: unknown };

/** One summarizer pass, before the retry decision. `retryable` is what earns the one retry. */
type SummaryAttempt =
  | { ok: true; summary: string; elapsedMs: number }
  | { ok: false; reason: string; retryable: boolean };

/**
 * How many times a summary the output ceiling cut is asked for its rest. A bound against a model
 * that keeps writing past every ceiling, not a size: each continuation carries on from the text,
 * and a summary that still has not ended after this many is not converging.
 */
const MAX_CONTINUATIONS = 3;

/**
 * What one call actually came back with, and what to call it.
 *
 * The ceiling is named only when it is established: a truncation `finish_reason` AND output that
 * came out -- text, or tokens the provider billed for. Before this, `incomplete` alone was enough,
 * and `incomplete` is just `finish_reason !== "stop"` on an answer with no text: a gateway that
 * streamed nothing at all was announced as "the summary hit the output ceiling and is incomplete",
 * which is false and sent the owner hunting a limit that was not there. Measured on
 * `opencode_go/deepseek-flash` behind opencode zen (2026-09-19): two compactions, 0 tokens in and
 * 0 out, 39 s and 78 s, and the guard called both a ceiling.
 *
 * A summary that hit the ceiling for real is not a shorter summary either, it is a summary missing
 * its end -- what it is missing is Next Steps, the section the next turn needs most.
 */
function classifySummaryResponse(
  response: LlmResponse,
): { ok: true; summary: string } | { ok: false; reason: string; retryable: boolean } {
  const summary = response.content.trim();
  const completionTokens = response.usage?.completionTokens ?? 0;
  const finishReason = response.finishReason ?? "none";

  if (cutByOutputCeiling(response.finishReason) && (summary.length > 0 || completionTokens > 0)) {
    return {
      ok: false,
      reason: `The summary hit the output ceiling and is incomplete (finish_reason: ${finishReason}).`,
      retryable: false,
    };
  }

  /**
   * The provider concluded the response, or the stream was cut. That is the question, and it
   * replaces "did anything come out of it": `finish_reason` is the only thing on the wire that
   * says the model stopped writing on purpose, and a stream that ends without one died where it
   * was -- whatever fragments it carried before the socket closed, reasoning being what it carries
   * most.
   *
   * Measured 2026-09-20 (`opencode_go/deepseek-v4.1-flash` behind opencode zen): one /compact came
   * back with 2.4 MB of `reasoning_content`, no finish chunk, no `[DONE]`, 40 s in -- the model was
   * still thinking when the connection dropped -- and was announced as *the model returned an empty
   * summary*, which skipped the one retry that would have saved it. The next attempt wrote a
   * 59 694-character summary in 124 s.
   *
   * It also closes the silent half: a cut that lands after some text used to pass the gate and be
   * stored, so the conversation's floor became a summary missing its end -- the exact thing the
   * ceiling guard refuses when the provider says why it stopped.
   */
  if (response.finishReason === undefined) {
    return {
      ok: false,
      reason: "The provider closed the stream before the summary was written (no finish_reason).",
      retryable: true,
    };
  }

  if (!summary) {
    // A clean `stop` with no text is the model's own answer. A non-stop reason with no fragment, no
    // usage and no text at all is a gateway that rendered nothing -- an aléa too, its own wording,
    // and the caller retries it once.
    if (response.usage === undefined && !response.reasoning && response.finishReason !== "stop") {
      return {
        ok: false,
        reason: `The provider returned an empty stream (no content, no usage, finish_reason: ${finishReason}).`,
        retryable: true,
      };
    }
    return { ok: false, reason: `The model returned an empty summary (finish_reason: ${finishReason}).`, retryable: false };
  }
  if (summary.length < 50) return { ok: false, reason: "The model returned a summary that is too short.", retryable: false };
  if (REFUSAL_PATTERNS.some((pattern) => pattern.test(summary))) {
    return { ok: false, reason: "The model refused to generate a summary.", retryable: false };
  }
  return { ok: true, summary };
}

/**
 * The opening of the first turn the boundary keeps verbatim, short enough to name it in one line.
 * The summarizer reads the whole history above; this tells it where to stop, since the kept tail is
 * beside the summary rather than inside it.
 */
function keptTurnText(plan: CompactionPlan): string | undefined {
  if (!plan.firstKeptEntryId) return undefined;
  const entry = plan.entries.find((candidate) => candidate.id === plan.firstKeptEntryId);
  if (!entry || (entry.type !== "user" && entry.type !== "phase")) return undefined;
  const text = entry.text.trim();
  if (!text) return undefined;
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

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
  prefix?: CompactionPrefix,
): Promise<SummaryResult> {
  const serialized = prefix ? undefined : serializeEntriesForCompaction(plan.middle);
  const keptTurn = prefix ? keptTurnText(plan) : undefined;
  const prompt = prefix
    ? conversationSummaryPrompt({
        update: plan.previousSummary !== undefined,
        ...(plan.previousIsLegacy === true ? { legacy: true } : {}),
        ...(instructions ? { instructions } : {}),
        ...(keptTurn ? { keptTurn } : {}),
      })
    : plan.previousSummary
      ? updateSummaryPrompt(serialized!, plan.previousSummary, instructions, plan.previousIsLegacy === true)
      : firstSummaryPrompt(serialized!, instructions);

  const runModel = tryResolveRunModel(
    config,
    { agent: agentTypeOf(session), ...(session.modelOverride ? { sessionModel: session.modelOverride } : {}) },
    availabilityWorld(),
  );
  // Keep the provider-qualified model id. `apiModel` is the wire id only; resolving it again
  // would send a session to the default provider and can yield a misleading protocol 400.
  const resolved = resolveUtilityLlmConfig(config.llm, runModel?.model ?? session.modelOverride ?? runModel?.apiModel);
  // `max_tokens` on the wire comes from `limit.output`, so bounding the answer is a matter of
  // handing the transport a narrower limit rather than a new parameter on every transport.
  // `limit.output` is what the transport turns into `max_tokens`, so dropping it is how the summary
  // goes uncapped. Anthropic requires the field: its transport falls back to the model's own
  // declared ceiling, which is the same thing codex gets from leaving it out.
  const { output: _uncapped, ...limit } = resolved.limit ?? {};
  const summarizerConfig = (from: ResolvedLlmConfig): ResolvedLlmConfig =>
    wallConfig(config, {
      ...from,
      limit,
      // Maintenance on a conversation is still that conversation: the prompt it sends is that
      // conversation's own prefix, and a gateway routing on the session key refuses a call without
      // one -- docs/session-affinity.md.
      cacheKey: from.cacheKey ?? session.id,
    });

  /**
   * The models this pass may use, best first: the one the session runs, then the rest of the chain
   * it is on -- the tag's other candidates, and the tag's global default when it asked for it.
   *
   * The summarizer used to resolve exactly one model and call it once, so a tag whose first
   * account was out of quota turned every summary into an HTTP 429 while the second account sat
   * idle, where the same run would have answered on it (2026-11-02). A run walks
   * `providerFallbackTargets` on a provider failure; this is the same walk, from the same list.
   */
  const candidates: ResolvedLlmConfig[] = [summarizerConfig(resolved)];
  for (const target of providerFallbackTargets({
    config,
    agent: agentTypeOf(session),
    ...(runModel?.route ? { route: runModel.route } : {}),
    ...(session.modelOverride ? { tagRef: session.modelOverride } : {}),
    current: { model: resolved.model, ...(resolved.provider ? { provider: resolved.provider } : {}) },
    // A compaction prompt carries the conversation and its instructions, never an image: asking
    // for a vision candidate would be asking for the wrong half of the route.
    hasImages: false,
    attempted: new Set([resolved.model]),
  })) {
    candidates.push(summarizerConfig(target.config));
  }

  /**
   * One summarizer call: the stream, its accounting, and what the response turned out to be.
   *
   * Streamed, not a single blocking call. The budget a transport enforces is "time with not one
   * byte received": a stream rearms it at every chunk and measures silence, while a one-shot call
   * turns it into a hard ceiling on the whole operation -- prompt prefill plus a 20k-token summary.
   * The OpenAI-compatible default of 120 s made that ceiling real: a compaction of this very
   * conversation timed out at 23:36 on 2026-09-11 and the same work took 85 s two minutes later,
   * while every Anthropic compaction in the history ran 180-360 s and only survived because that
   * transport allows 600. Streaming also gives the summary a live mouth: the fragments go out as
   * they arrive, so a window can watch it being written -- docs/compaction.md.
   */
  const callOnce = async (llmConfig: ResolvedLlmConfig, messages: ChatMessage[]): Promise<LlmResponse> => {
    const callStartedAt = Date.now();
    const progress = compactionProgress(session.id);
    // The thinking goes out too, batched the same way. A summarizer inheriting the session's effort
    // spends that time before its first word, and the rule with a counter was the only thing on
    // screen for it -- docs/compaction.md.
    const thinking = compactionProgress(session.id, "session:compact:reasoning");
    const response = await llmCompleteStream(
      llmConfig,
      messages,
      (chunk: string) => progress.push(chunk),
      prefix?.tools,
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
      providerKey: llmConfig.provider,
      streaming: false,
      caller,
      workspace: usageWorkspaceOf(config, session),
      folderId: usageFolderOf(session),
      promptTokens: response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completionTokens ?? 0,
      totalTokens: response.usage?.totalTokens ?? 0,
      cacheReadTokens: response.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: response.usage?.cacheWriteTokens ?? 0,
      toolCalls: 0,
      iteration: 0,
      durationMs: Date.now() - callStartedAt,
      proxyCostUsd: response.proxyCostUsd,
      upstreamApiBase: response.upstreamApiBase,
      ...cacheAttributionOf(llmConfig),
    });
    return response;
  };

  /**
   * One summary, continued while the ceiling cuts it.
   *
   * A cut answer used to be refused and thrown away: the owner paid twice for 128 000 tokens of a
   * summary missing its end (2026-10-04). It is now kept and asked for its rest in a new turn, over
   * the same prompt, so the provider serves the prefix from cache and only the rest is written. The
   * gate still holds: a summary that has not ended after `MAX_CONTINUATIONS` is refused, never
   * stored incomplete.
   */
  const attemptOnce = async (llmConfig: ResolvedLlmConfig): Promise<SummaryAttempt> => {
    const attemptStartedAt = now();
    const base: ChatMessage[] = prefix
      ? [
          { role: "system", content: prefix.systemPrompt },
          ...messagesOf(plan.entries),
          { role: "user", content: `${SUMMARIZER_SYSTEM}\n\n${prompt}` },
        ]
      : [
          { role: "system", content: SUMMARIZER_SYSTEM },
          { role: "user", content: prompt },
        ];
    let response = await callOnce(llmConfig, base);
    let written = response.content;
    for (let round = 0; round < MAX_CONTINUATIONS && cutAfterWriting(response); round++) {
      response = await callOnce(llmConfig, [
        ...base,
        { role: "assistant", content: written },
        { role: "user", content: CONTINUE_SUMMARY },
      ]);
      written += response.content;
    }
    const classified = classifySummaryResponse({ ...response, content: written });
    return classified.ok ? { ok: true, summary: classified.summary, elapsedMs: now() - attemptStartedAt } : classified;
  };

  // One retry, and one only, earned by a stream that never concluded. Decided here, where the
  // failure is seen, and not a transport policy: the transports already retry statuses and
  // transients, and a 200 that is cut mid-stream is neither. The aléa is measured -- 4 empty
  // streams in 18 deepseek-flash compactions behind opencode zen, the same call answering 6 689
  // tokens 30 s later, and two more cut mid-reasoning on 2026-09-20, one of which the retry landed.
  const attemptOn = async (llmConfig: ResolvedLlmConfig): Promise<SummaryAttempt> => {
    const first = await attemptOnce(llmConfig);
    if (!first.ok && first.retryable) return await attemptOnce(llmConfig);
    return first;
  };

  let attempt: SummaryAttempt | undefined;
  for (let index = 0; index < candidates.length; index++) {
    const llmConfig = candidates[index]!;
    try {
      attempt = await attemptOn(llmConfig);
      // A model answered or refused on its own terms (an empty or incomplete summary): another
      // model would write the same absence, so the chain stops here. Only a provider failure, which
      // is a throw, moves to the next candidate.
      break;
    } catch (err) {
      rethrowIfAborted(err, signal);
      const next = candidates[index + 1];
      // The owner's decision outranks the chain, exactly as it does for a run: a conversation with
      // the quota switch on waits the wall out instead of quietly answering on another model.
      if (next && waitsForQuotaOf(session) && isQuotaFailure(err)) {
        return {
          ok: false,
          reason: `Compaction error: ${err instanceof Error ? err.message : String(err)}`,
          retryableQuota: true,
          cause: withProvider(err, llmConfig),
        };
      }
      if (!next || !(isProviderOutage(err) || isQuotaSpent(err) || isCapabilityRefusal(err))) throw err;
      const reason = String((err as Error | undefined)?.message ?? err).slice(0, 200);
      void log("warn", "compaction provider fallback", {
        sessionId: session.id,
        failedModel: llmConfig.model,
        provider: llmConfig.provider,
        targetModel: next.model,
        reason,
      });
    }
  }
  if (!attempt) return { ok: false, reason: "Compaction error: no model could summarize this session" };
  if (!attempt.ok) return { ok: false, reason: attempt.reason };

  const { summary, archive } = splitSummaryOutput(attempt.summary);
  if (summary.length < 50) return { ok: false, reason: "The model returned a summary that is too short." };
  // The anchor is computed over the whole branch, not over `middle`: a path the tail still shows is
  // one the next turn is most likely to need, and naming it twice costs a line.
  const anchor = fileAnchorOf(plan.entries);
  return { ok: true, summary: anchor ? `${summary}\n\n${anchor}` : summary, archive, elapsedMs: attempt.elapsedMs };
}

/** An answer the output ceiling stopped after it had started writing: the one worth continuing. */
function cutAfterWriting(response: LlmResponse): boolean {
  return cutByOutputCeiling(response.finishReason) && response.content.trim().length > 0;
}

/**
 * The failure, stamped with the provider that produced it.
 *
 * The quota oracle is asked per provider (`docs/quota-retry.md`), and by the time the error reaches
 * the channel only the error is left. A summarizer that walked three candidates has no other record
 * of which one refused.
 */
function withProvider(err: unknown, from: ResolvedLlmConfig): unknown {
  if (typeof err !== "object" || err === null) return err;
  return Object.assign(err as object, { provider: from.provider, model: from.model });
}

/**
 * What a boundary archives: what the summarizer says finished, preceded -- once, on the first pass
 * since the archive exists -- by the previous summary as it was, since that one still holds the
 * whole history the new summary no longer carries. Nothing is rewritten by a model to get there.
 */
export function archiveOf(plan: CompactionPlan, archived: string): string {
  if (!plan.previousIsLegacy || !plan.previousSummary) return archived;
  const legacy = `## Summary before the archive\n\n${plan.previousSummary}`;
  return archived ? `${legacy}\n\n## Finished since\n\n${archived}` : legacy;
}

/**
 * Where the prompt resumes after this boundary, decided now rather than when the plan was made.
 *
 * A plan that keeps nothing still has to keep what landed after it was made: a background summary
 * is committed minutes later, and the turns added meanwhile are not in it. They become the kept
 * tail. With none, the boundary resumes after itself.
 */
async function firstKeptAtCommit(log: SessionLog, plan: CompactionPlan, ownId: string): Promise<string> {
  if (plan.firstKeptEntryId) return plan.firstKeptEntryId;
  const plannedLast = plan.entries[plan.entries.length - 1]?.id;
  const context = await log.context();
  const path = contextEntries(context, log.leaf());
  const at = path.findIndex((entry) => entry.id === plannedLast);
  return (at >= 0 ? path[at + 1]?.id : undefined) ?? ownId;
}

/** Append the boundary. The turns it stands for stay on disk and stay on screen. */
export async function commitCompaction(
  log: SessionLog,
  plan: CompactionPlan,
  summary: string,
  archived: string,
  compactionMs?: number,
): Promise<CompactionEntry> {
  const id = newEntryId();
  const entry = log.append<CompactionEntry>({
    type: "compaction",
    prompt: true,
    summary,
    firstKeptEntryId: await firstKeptAtCommit(log, plan, id),
    tokensBefore: plan.tokensBefore,
    count: plan.middle.length,
    ...(plan.retained.length > 0 ? { retained: plan.retained } : {}),
    archive: archiveOf(plan, archived),
    ...(compactionMs !== undefined ? { compactionMs } : {}),
  }, id);
  await log.flush();
  return entry;
}

/**
 * The trace a stopped compaction leaves -- docs/stop.md.
 *
 * `kept` is the count a boundary would have carried for the same plan (`plan.middle`, the slice
 * the summary stood for), and every one of those entries is still on the branch: nothing was
 * folded, so the stopped rule speaks about the same turns as the boundary it never became, under
 * the other label. `prompt: false` is what keeps it out of the prompt: the projection reads
 * `entry.type === "compaction"` for its floor, and an entry of its own type cannot be mistaken
 * for a ceiling, so a stopped pass can never move the boundary.
 */
export async function commitCompactionStopped(
  log: SessionLog,
  plan: CompactionPlan,
  compactionMs?: number,
): Promise<CompactionStoppedEntry> {
  const entry = log.append<CompactionStoppedEntry>({
    type: "compaction_stopped",
    prompt: false,
    kept: plan.middle.length,
    ...(compactionMs !== undefined ? { compactionMs } : {}),
  });
  await log.flush();
  return entry;
}

/**
 * The verbatim tail every compaction pass keeps: sized on the model's declared window, whole.
 *
 * One policy for both paths -- the automatic gates and `/compact` read this same function
 * (docs/compaction.md). The ceilings a session can carry -- its Context choice, a tag route's
 * cap, the standing cap, an exemption -- size the *trigger*: they are what decides when a run
 * compacts, and they must not decide how much verbatim survives, or a split made through a
 * capped window folds turns the model could have kept. `llm.limit.context` stays the
 * last-resort window for a model that declares none, never a ceiling over one.
 *
 * The model is the one the session runs (agent pin and tag included), the same resolution the
 * summarizer uses.
 */
export function retainedBudgetFor(config: MyClawConfig, session: SessionData): number {
  const modelId = sessionRunModelId(config, session);
  if (!modelId) return resolveCompactionTailTokens(config);
  const window = resolveFullContextWindow(config, modelId);
  return resolveCompactionTailTokens(config, window.effective * resolveAutoCompactThreshold(config, window.effective));
}

/** The model the session runs, by the chain the summarizer resolves: whose window sizes a tail.
 *  `undefined` means there is nothing configured to run. */
function sessionRunModelId(config: MyClawConfig, session: SessionData): string | undefined {
  const runModel = tryResolveRunModel(
    config,
    { agent: agentTypeOf(session), ...(session.modelOverride ? { sessionModel: session.modelOverride } : {}) },
    availabilityWorld(),
  );
  return runModel?.model ?? session.modelOverride ?? config.llm?.defaultModel ?? config.llm?.model;
}

/**
 * A compaction pass, whoever asked for it: the automatic gates (`AgentBridge.runCompaction`)
 * and `/compact` (`channels/compact-command.ts`). Both size their split the same way --
 * `retainedBudgetFor` -- and differ only in what the caller brings: a hold, a signal, instructions.
 */
export async function compactSession(
  config: MyClawConfig,
  session: SessionData,
  instructions?: string,
  signal?: AbortSignal,
  now: () => number = Date.now,
  prefix?: CompactionPrefix,
): Promise<CompactionResult> {
  return await runCompactionPass(config, session, retainedBudgetFor(config, session), instructions, signal, now, prefix);
}

async function runCompactionPass(
  config: MyClawConfig,
  session: SessionData,
  tailBudget: number,
  instructions?: string,
  signal?: AbortSignal,
  now: () => number = Date.now,
  prefix?: CompactionPrefix,
): Promise<CompactionResult> {
  const log = await sessionLogOf(session.id);
  const planned = await planCompaction(log, tailBudget);
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

    const passStartedAt = now();
    try {
      const summarized = await summarizeForCompaction(config, session, plan, instructions, signal, "compaction", now, prefix);
      if (!summarized.ok) {
        return {
          ok: false,
          reason: summarized.reason,
          beforeCount,
          afterCount: beforeCount,
          ...(summarized.retryableQuota === true ? { retryableQuota: true, cause: summarized.cause } : {}),
        };
      }
      const boundary = await commitCompaction(log, plan, summarized.summary, summarized.archive, summarized.elapsedMs);
      indexCompactionArchive(session, boundary);
      session.lastActiveAt = new Date().toISOString();
      const afterCount = contextEntries(await log.context(), log.leaf()).length;
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
        ...(boundary.archive ? { archive: boundary.archive } : {}),
        boundary: { entryId: boundary.id, count: boundary.count, compactionMs: summarized.elapsedMs },
      };
    } catch (err) {
      // An abort is the owner stopping the run, not a compaction that failed on its own terms.
      // It is also the one outcome that used to leave no trace at all -- a boundary speaks only
      // for a summary that landed -- so the trace is written here, before the rethrow: this catch
      // is the last place the plan is still in hand (docs/stop.md).
      if (isAbort(err, signal)) await commitCompactionStopped(log, plan, now() - passStartedAt);
      rethrowIfAborted(err, signal);
      const errorMsg = err instanceof Error ? err.message : String(err);
      hooks.emit("session:compact:error", { sessionId: session.id, reason: errorMsg });
      return { ok: false, reason: `Compaction error: ${errorMsg}`, beforeCount, afterCount: beforeCount };
    }
  } finally {
    hooks.emit("session:compact:settled", { sessionId: session.id });
  }
}
