import type { ChatMessage } from "../llm/provider.ts";
import type { MyClawConfig } from "../core/config.ts";
import { contextPruningEnabled, resolveContextPruning } from "../core/config.ts";
import type { SessionMessage } from "../sessions/store.ts";
import { dropLeadingOrphanToolMessages } from "../sessions/store.ts";
import { toOpenAiToolCalls } from "../llm/openai-format.ts";

export interface PruningOptions {
  keepLastAssistantTurns: number;
  headChars: number;
}

// Stubbing a short result would grow the prompt instead of shrinking it: only prune
// when the cut saves at least this much beyond the kept head.
const MIN_SAVINGS_CHARS = 256;

export function pruneMarker(prunedChars: number): string {
  return `\n[... ${prunedChars} chars of old tool output pruned to save context — re-run the tool if you need the full output]`;
}

/**
 * Replaces tool results older than the last `keepLastAssistantTurns` assistant turns with a
 * head-plus-marker stub. Prompt-side only: callers must never persist the returned array.
 * Returns the input array untouched (same reference) when nothing qualifies, so callers can
 * cheaply detect no-ops.
 */
export function pruneOldToolResults(messages: ChatMessage[], opts: PruningOptions): ChatMessage[] {
  // Everything strictly before the Nth-from-last assistant message is prunable; the window
  // from that assistant onward is the "recent turns" the model may still be reasoning over.
  let seen = 0;
  let boundary = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      seen++;
      if (seen >= opts.keepLastAssistantTurns) {
        boundary = i;
        break;
      }
    }
  }
  if (boundary <= 0) return messages;

  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= boundary || m.role !== "tool") return m;
    const content = m.content;
    if (content.length <= opts.headChars + MIN_SAVINGS_CHARS) return m;
    changed = true;
    return { ...m, content: content.slice(0, opts.headChars) + pruneMarker(content.length - opts.headChars) };
  });
  return changed ? out : messages;
}

/**
 * Session turns as the chat API takes them. One mapper, exported, because three places measure
 * how full the window is -- the compaction gate, `/status` and the app's header -- and a private
 * copy in each is how they came to disagree by a factor of eight about the same conversation.
 */
export function sessionChatMessages(messages: readonly SessionMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // Defense in depth: a session loaded from disk may start with orphan tool messages; emitting
  // them verbatim makes the LLM API reject the whole request.
  for (const msg of dropLeadingOrphanToolMessages([...messages])) {
    switch (msg.role) {
      case "user":
        out.push({ role: "user", content: msg.content });
        break;
      case "assistant":
        if (msg.toolCalls?.length) {
          out.push({ role: "assistant", content: msg.content, tool_calls: toOpenAiToolCalls(msg.toolCalls) });
        } else {
          out.push({ role: "assistant", content: msg.content });
        }
        break;
      case "tool":
        out.push({ role: "tool", tool_call_id: msg.toolCallId, content: msg.content });
        break;
    }
  }
  return out;
}

/**
 * The history as the prompt actually carries it, which is the only thing an occupancy reading may
 * measure.
 *
 * `session.messages` holds every tool result in full; the prompt does not, because the loop runs
 * `pruneOldToolResults` over it before every call. Estimating the untouched history counts tokens
 * that are never sent: on a long agentic run the gap reached 8.7x on this install (410k estimated
 * against 47k billed) and fired thirty compactions on a session using nine percent of its window.
 * Pruning is prompt-side, so the measure of the prompt has to be too.
 *
 * `backend` is the resolved engine. Anthropic never prunes -- its cache is a prefix, so the loop
 * leaves the prompt whole -- and measuring it as pruned would under-read the one gate that must not.
 */
export function promptSideChat(
  messages: readonly SessionMessage[],
  config: MyClawConfig,
  backend?: string,
): ChatMessage[] {
  const chat = sessionChatMessages(messages);
  if (backend === "anthropic" || !contextPruningEnabled(config)) return chat;
  // Applied to whatever slice the occupancy asks for, never to the whole history behind its back:
  // the measurement pairs a billed number with the turns it covered, and the delta it needs is the
  // newest turns alone. A slice keeps its own last assistants, so it can only over-count, and an
  // over-count is the side a compaction gate is allowed to err on.
  return pruneOldToolResults(chat, resolveContextPruning(config));
}
