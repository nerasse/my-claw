import type { MyClawConfig } from "../core/config.ts";
import { chatCompletion } from "../llm/provider.ts";
import { resolveOpenAiLlmConfig } from "../llm/resolver.ts";
import type { SessionData, SessionMessage } from "./store.ts";
import { recordApiCall } from "../analytics/usage-db.ts";
import { hooks } from "../hooks/index.ts";

const MIN_MESSAGES_TO_COMPACT = 10;
const HEAD_KEEP = 3;
const TAIL_KEEP = 4;
const MAX_SUMMARY_CHARS = 8000;

export interface CompactionResult {
  ok: boolean;
  reason?: string;
  beforeCount: number;
  afterCount: number;
  summary?: string;
}

function isToolPairStart(msg: SessionMessage, next: SessionMessage | undefined): boolean {
  return msg.role === "assistant" && (msg.toolCalls?.length ?? 0) > 0 && next !== undefined;
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

function alignHeadBoundary(messages: SessionMessage[], headEnd: number): number {
  let idx = headEnd;
  if (idx >= messages.length) return messages.length;

  // Walk forward to avoid splitting a tool pair
  while (idx < messages.length) {
    const prev = messages[idx - 1];
    const curr = messages[idx];
    if (prev && isToolPairStart(prev, curr)) {
      // prev is assistant with tool_calls, need to include tool results
      idx += 1;
      // Continue to include all tool results for this call
      while (idx < messages.length && messages[idx]?.role === "tool") {
        idx += 1;
      }
      continue;
    }
    break;
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
  const messages = session.messages;
  hooks.emit("session:compact:start", { sessionId: session.id, messageCount: messages.length });

  if (messages.length < MIN_MESSAGES_TO_COMPACT) {
    return {
      ok: false,
      reason: `Session too short to compact (${messages.length} messages, minimum ${MIN_MESSAGES_TO_COMPACT}).`,
      beforeCount: messages.length,
      afterCount: messages.length,
    };
  }

  const headEndRaw = Math.min(HEAD_KEEP, messages.length);
  const headEnd = alignHeadBoundary(messages, headEndRaw);
  const tailStartRaw = Math.max(headEnd, messages.length - TAIL_KEEP);
  const tailStart = alignTailBoundary(messages, tailStartRaw);

  if (tailStart <= headEnd) {
    return {
      ok: false,
      reason: "Not enough messages between head and tail to compact.",
      beforeCount: messages.length,
      afterCount: messages.length,
    };
  }

  const head = messages.slice(0, headEnd);
  const middle = messages.slice(headEnd, tailStart);
  const tail = messages.slice(tailStart);

  const serialized = serializeForCompaction(middle);
  const prompt = buildCompactionPrompt(serialized, instructions);

  const llmConfig = resolveOpenAiLlmConfig(config.llm, session.modelOverride);

  try {
    const compactionStartedAt = Date.now();
    const response = await chatCompletion(
      llmConfig,
      [
        { role: "system", content: "You are a conversational context compaction agent." },
        { role: "user", content: prompt },
      ],
      undefined,
    );
    recordApiCall({
      sessionId: session.id,
      platform: session.platform,
      model: llmConfig.model,
      baseUrl: llmConfig.baseUrl,
      streaming: false,
      caller: "compaction",
      promptTokens: response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completionTokens ?? 0,
      totalTokens: response.usage?.totalTokens ?? 0,
      toolCalls: 0,
      iteration: 0,
      durationMs: Date.now() - compactionStartedAt,
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
      content: `[Prior context summarized]\n${summary}\n\n[End of summary — respond to the message below]`,
      timestamp: new Date().toISOString(),
    };

    session.messages = [...head, summaryMessage, ...tail];
    session.lastActiveAt = new Date().toISOString();
    hooks.emit("session:compact:end", {
      sessionId: session.id,
      beforeCount: messages.length,
      afterCount: session.messages.length,
      summaryLength: summary.length,
    });
    return {
      ok: true,
      beforeCount: messages.length,
      afterCount: session.messages.length,
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
