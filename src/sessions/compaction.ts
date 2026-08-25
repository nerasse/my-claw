import type { MyClawConfig } from "../core/config.ts";
import { resolveUtilityLlmConfig } from "../llm/utility-model.ts";
import { llmComplete } from "../llm/transport.ts";
import { tryResolveRunModel } from "../llm/run-model.ts";
import { availabilityWorld } from "../llm/world.ts";
import type { SessionData } from "./store.ts";
import { agentTypeOf, attributionParent } from "./store.ts";
import { recordApiCall } from "../analytics/usage-db.ts";
import { hooks } from "../hooks/index.ts";
import { usageModelOf } from "../llm/model-ref.ts";
import { sessionLogOf } from "./log-access.ts";
import { contextEntries } from "./projection.ts";
import type { Entry, PhaseEntry, ToolEntry, UserEntry, CompactionEntry } from "./log.ts";
import { estimateMessagesTokens } from "../llm/tokens.ts";
import { promptOf } from "./projection.ts";

const MIN_MESSAGES_TO_COMPACT = 10;
const TAIL_KEEP = 4;
const MAX_SUMMARY_CHARS = 8000;

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
      parts.push(`Tool result (${tool.callId}): ${tool.output.slice(0, 1200)}`);
    } else if (entry.type === "compaction") {
      // Skip existing compaction entries in the serialization
    }
  }
  flushAssistant();

  return parts.join("\n\n---\n\n");
}

function buildCompactionPrompt(serialized: string, instructions?: string): string {
  const focus = instructions ? `Specific focus: ${instructions}` : "Summarize key facts, decisions made, technical state, and ongoing tasks.";
  return [
    "You are a context compaction agent. Summarize the conversation below into a structured and concise summary.",
    "",
    focus,
    "",
    "Guidelines:",
    "- Write in the same language as the original conversation",
    "- Preserve: the main task, key decisions, technical state (modified files, branches, etc.), errors encountered, remaining work",
    "- Ignore: greetings, thanks, generic confirmations, meta-commentary",
    "- NEVER include API keys, tokens, passwords, or secrets",
    "- Format: continuous text, no complex markdown",
    "",
    "Conversation to summarize:",
    "=== START ===",
    serialized,
    "=== END ===",
    "",
    "Summary:",
  ].join("\n");
}

export async function compactSession(
  config: MyClawConfig,
  session: SessionData,
  instructions?: string,
): Promise<CompactionResult> {
  // Get the log and context entries
  const log = await sessionLogOf(session.id);
  const entries = contextEntries(log.entries(), log.leaf());
  hooks.emit("session:compact:start", { sessionId: session.id, messageCount: entries.length });

  if (entries.length < MIN_MESSAGES_TO_COMPACT) {
    return {
      ok: false,
      reason: `Session too short to compact (${entries.length} entries, minimum ${MIN_MESSAGES_TO_COMPACT}).`,
      beforeCount: entries.length,
      afterCount: entries.length,
    };
  }

  // Everything but the last few turns is summarised. The boundary must land on a clean entry.
  const tailStartRaw = Math.max(0, entries.length - TAIL_KEEP);
  const tailStart = alignEntryTailBoundary(entries, tailStartRaw);

  if (tailStart <= 0) {
    return {
      ok: false,
      reason: "Not enough entries before the tail to compact.",
      beforeCount: entries.length,
      afterCount: entries.length,
    };
  }

  const middle = entries.slice(0, tailStart);
  const tail = entries.slice(tailStart);
  const firstKeptEntry = tail[0];
  if (!firstKeptEntry) {
    return {
      ok: false,
      reason: "No entries in tail after boundary alignment.",
      beforeCount: entries.length,
      afterCount: entries.length,
    };
  }

  const serialized = serializeEntriesForCompaction(middle);
  const prompt = buildCompactionPrompt(serialized, instructions);
  const tokensBefore = estimateMessagesTokens(promptOf(log.entries(), log.leaf()));

  // The model the session actually runs, agent pin and tag included -- not the raw session override,
  // which is absent on every chat that inherits a pin and made the summarizer resolve the global
  // default while the conversation ran something else. The agent comes from the session, so a
  // sub-agent or a cron job is summarized by its own model rather than the orchestrator's. The
  // dispatch in `llmComplete` accepts any wire protocol, so the session's own model summarizes it.
  const runModel = tryResolveRunModel(
    config,
    { agent: agentTypeOf(session), ...(session.modelOverride ? { sessionModel: session.modelOverride } : {}) },
    availabilityWorld(),
  );
  const llmConfig = resolveUtilityLlmConfig(config.llm, runModel?.apiModel ?? runModel?.model ?? session.modelOverride);

  try {
    const compactionStartedAt = Date.now();
    const response = await llmComplete(
      llmConfig,
      [
        { role: "system", content: "You are a conversational context compaction agent." },
        { role: "user", content: prompt },
      ],
      undefined,
    );
    recordApiCall({
      sessionId: session.id,
      // Compaction is maintenance on a session, not work delegated by another one, so it bills
      // to the session it is compacting.
      parentSessionId: attributionParent(session),
      platform: session.platform,
      model: usageModelOf(llmConfig),
      baseUrl: llmConfig.baseUrl,
      streaming: false,
      caller: "compaction",
      promptTokens: response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completionTokens ?? 0,
      totalTokens: response.usage?.totalTokens ?? 0,
      cacheReadTokens: response.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: response.usage?.cacheWriteTokens ?? 0,
      toolCalls: 0,
      iteration: 0,
      durationMs: Date.now() - compactionStartedAt,
      proxyCostUsd: response.proxyCostUsd,
      upstreamApiBase: response.upstreamApiBase,
    });

    const summary = response.content.slice(0, MAX_SUMMARY_CHARS).trim();
    if (!summary || summary.length < 50) {
      return {
        ok: false,
        reason: summary ? "The model returned a summary that is too short." : "The model returned an empty summary.",
        beforeCount: entries.length,
        afterCount: entries.length,
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
    if (REFUSAL_PATTERNS.some((p) => p.test(summary))) {
      return {
        ok: false,
        reason: "The model refused to generate a summary.",
        beforeCount: entries.length,
        afterCount: entries.length,
      };
    }

    // Write the compaction entry to the log
    log.append<CompactionEntry>({
      type: "compaction",
      prompt: true,
      summary,
      firstKeptEntryId: firstKeptEntry.id,
      tokensBefore,
      count: middle.length,
    });
    await log.flush();

    session.lastActiveAt = new Date().toISOString();
    // Recalculate context entries after compaction
    const afterEntries = contextEntries(log.entries(), log.leaf());
    const afterCount = afterEntries.length;
    hooks.emit("session:compact:end", {
      sessionId: session.id,
      beforeCount: entries.length,
      afterCount,
      summaryLength: summary.length,
    });
    return {
      ok: true,
      beforeCount: entries.length,
      afterCount,
      summary,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    hooks.emit("session:compact:error", { sessionId: session.id, reason: errorMsg });
    return {
      ok: false,
      reason: `Compaction error: ${errorMsg}`,
      beforeCount: entries.length,
      afterCount: entries.length,
    };
  }
}
