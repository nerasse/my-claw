import type { ChatMessage } from "./provider.ts";
import { log } from "../utils/logger.ts";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;
const SAFETY_MARGIN = 1.15;
const DEFAULT_CONTEXT_TOKENS = 128_000;
const HEAD_KEEP = 3;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function messageTokens(msg: ChatMessage): number {
  let chars = 0;

  if (typeof msg.content === "string") {
    chars += msg.content.length;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") chars += part.text.length;
      else if (part.type === "image_url") chars += 6400;
    }
  }

  if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      chars += tc.function.name.length + tc.function.arguments.length;
    }
  }

  return Math.ceil(chars / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += messageTokens(msg);
  }
  return Math.ceil(total * SAFETY_MARGIN);
}

function isAssistantWithToolCalls(msg: ChatMessage): boolean {
  return msg.role === "assistant" && "tool_calls" in msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

function getToolCallIds(msg: ChatMessage): Set<string> {
  if (msg.role === "assistant" && "tool_calls" in msg && Array.isArray(msg.tool_calls)) {
    return new Set(msg.tool_calls.map((tc) => tc.id));
  }
  return new Set();
}

export function trimToContextWindow(
  messages: ChatMessage[],
  contextTokens: number | undefined,
  toolSchemaTokens: number = 0,
): ChatMessage[] {
  const budget = contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const available = budget - toolSchemaTokens;
  const estimated = estimateMessagesTokens(messages);

  if (estimated <= available) return messages;

  void log("warn", `Context window exceeded: ~${estimated} tokens estimated, budget ${available}. Trimming old messages.`);

  // messages[0] is always the system prompt — never drop it
  // Keep HEAD_KEEP session messages after system (first user + first exchange)
  // Keep the tail (recent messages)
  // Drop from the middle, respecting tool-call/result pairs

  const system = messages[0]!;
  const rest = messages.slice(1);
  const minHead = Math.min(HEAD_KEEP, rest.length);

  // Find a safe head boundary (don't split tool pairs)
  let headEnd = minHead;
  while (headEnd < rest.length) {
    const msg = rest[headEnd - 1];
    if (msg && isAssistantWithToolCalls(msg)) {
      const ids = getToolCallIds(msg);
      while (headEnd < rest.length && rest[headEnd]?.role === "tool") {
        const toolMsg = rest[headEnd] as { role: "tool"; tool_call_id: string; content: string };
        if (ids.has(toolMsg.tool_call_id)) {
          headEnd++;
        } else {
          break;
        }
      }
      continue;
    }
    break;
  }

  // Binary-search from the middle to find how many to drop
  const head = rest.slice(0, headEnd);
  const candidates = rest.slice(headEnd);

  // Try progressively larger drops from the front of candidates
  let dropCount = 0;
  for (let i = 0; i < candidates.length; i++) {
    const trial = [system, ...head, ...candidates.slice(i)];
    if (estimateMessagesTokens(trial) <= available) {
      dropCount = i;
      break;
    }
    dropCount = i + 1;
  }

  // Align drop boundary: don't drop a tool result without its assistant call
  while (dropCount < candidates.length) {
    const firstKept = candidates[dropCount];
    if (firstKept?.role === "tool") {
      dropCount++;
      continue;
    }
    break;
  }

  // Also don't keep an assistant with tool_calls if its results were dropped
  if (dropCount > 0 && dropCount < candidates.length) {
    const firstKept = candidates[dropCount];
    if (firstKept && isAssistantWithToolCalls(firstKept)) {
      const ids = getToolCallIds(firstKept);
      let hasAllResults = true;
      for (const id of ids) {
        if (!candidates.slice(dropCount + 1).some((m) => m.role === "tool" && "tool_call_id" in m && (m as { tool_call_id: string }).tool_call_id === id)) {
          hasAllResults = false;
          break;
        }
      }
      if (!hasAllResults) dropCount++;
    }
  }

  const trimmed = [system, ...head, ...candidates.slice(dropCount)];
  const afterTokens = estimateMessagesTokens(trimmed);
  const dropped = rest.length - head.length - (candidates.length - dropCount);

  void log("info", `Trimmed ${dropped} messages: ~${estimated} -> ~${afterTokens} tokens (budget: ${available})`);

  return trimmed;
}
