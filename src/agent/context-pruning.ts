import type { ChatMessage } from "../llm/provider.ts";

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
