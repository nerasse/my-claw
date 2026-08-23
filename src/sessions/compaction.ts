import type { MyClawConfig } from "../core/config.ts";
import { chatCompletion } from "../llm/provider.ts";
import { resolveUtilityLlmConfig } from "../llm/utility-model.ts";
import { llmComplete } from "../llm/transport.ts";
import { tryResolveRunModel } from "../llm/run-model.ts";
import { availabilityWorld } from "../llm/world.ts";
import type { SessionData, SessionMessage } from "./store.ts";
import { agentTypeOf, attributionParent, promptMessages } from "./store.ts";
import { recordApiCall } from "../analytics/usage-db.ts";
import { hooks } from "../hooks/index.ts";
import { usageModelOf } from "../llm/model-ref.ts";

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

function alignTailBoundary(messages: SessionMessage[], tailStart: number): number {
  let idx = tailStart;
  if (idx <= 0) return 0;

  // Never start the tail inside a tool block. With parallel tool calls the tail can begin on the
  // 2nd/3rd tool result, whose predecessor is another tool (not the assistant) — walking back over
  // all contiguous tool results lands on their owning assistant, keeping the whole block together.
  while (idx > 0 && messages[idx]?.role === "tool") {
    idx -= 1;
  }
  return idx;
}

function serializeForCompaction(messages: SessionMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        parts.push(`User: ${msg.content}`);
        break;
      case "assistant": {
        let text = `Assistant: ${msg.content}`;
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          text += `\n[Tool calls: ${msg.toolCalls.map((tc) => tc.name).join(", ")}]`;
        }
        parts.push(text);
        break;
      }
      case "tool":
        parts.push(`Tool result (${msg.toolCallId}): ${msg.content.slice(0, 1200)}`);
        break;
    }
  }
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
  // The prompt side alone. Everything before the previous boundary is already inside an earlier
  // summary: re-reading it would summarise a summary and re-bill turns the model cannot see.
  const base = session.promptBase ?? 0;
  const messages = promptMessages(session);
  hooks.emit("session:compact:start", { sessionId: session.id, messageCount: messages.length });

  if (messages.length < MIN_MESSAGES_TO_COMPACT) {
    return {
      ok: false,
      reason: `Session too short to compact (${messages.length} messages, minimum ${MIN_MESSAGES_TO_COMPACT}).`,
      beforeCount: messages.length,
      afterCount: messages.length,
    };
  }

  // Everything but the last few turns is summarised. The old shape also kept the first turns
  // verbatim, which a boundary cannot express: the prompt is one contiguous window, and a head
  // held out of it would sit before the boundary and vanish from the prompt unsummarised. The
  // summariser is told to preserve the main task, which is what the head was there for.
  const tailStartRaw = Math.max(0, messages.length - TAIL_KEEP);
  const tailStart = alignTailBoundary(messages, tailStartRaw);

  if (tailStart <= 0) {
    return {
      ok: false,
      reason: "Not enough messages before the tail to compact.",
      beforeCount: messages.length,
      afterCount: messages.length,
    };
  }

  const middle = messages.slice(0, tailStart);
  const tail = messages.slice(tailStart);

  const serialized = serializeForCompaction(middle);
  const prompt = buildCompactionPrompt(serialized, instructions);

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
        beforeCount: messages.length,
        afterCount: messages.length,
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
        beforeCount: messages.length,
        afterCount: messages.length,
      };
    }

    const summaryMessage: SessionMessage = {
      role: "user",
      content: `${SUMMARY_OPEN}\n${summary}\n\n${SUMMARY_CLOSE}`,
      timestamp: new Date().toISOString(),
      summaryOf: middle.length,
    };

    // The summarised turns stay in `messages`; only the prompt window moves. The summary is spliced
    // in where they end, so the boundary lands on it and the model reads summary + tail, while the
    // app still replays every turn the owner wrote. `middle` is re-listed rather than left in place
    // because `alignTailBoundary` may have moved the cut, and the splice must rebuild exactly the
    // window the summary describes.
    session.messages = [...session.messages.slice(0, base), ...middle, summaryMessage, ...tail];
    session.promptBase = base + middle.length;
    session.lastActiveAt = new Date().toISOString();
    // Both counts are prompt-window sizes. `session.messages` only ever grows now, so reporting its
    // length against a `beforeCount` taken from the window would announce a compaction as
    // "12 -> 13 messages" -- the one number the command exists to make go down, going up.
    const afterCount = promptMessages(session).length;
    hooks.emit("session:compact:end", {
      sessionId: session.id,
      beforeCount: messages.length,
      afterCount,
      summaryLength: summary.length,
    });
    return {
      ok: true,
      beforeCount: messages.length,
      afterCount,
      summary,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    hooks.emit("session:compact:error", { sessionId: session.id, reason: errorMsg });
    return {
      ok: false,
      reason: `Compaction error: ${errorMsg}`,
      beforeCount: messages.length,
      afterCount: messages.length,
    };
  }
}
