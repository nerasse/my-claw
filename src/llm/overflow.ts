import type { LlmUsage } from "./provider.ts";

/**
 * Recognising a context overflow, whatever shape the provider gave it -- docs/compaction.md.
 *
 * The compaction gate is an estimate over an estimate: `chars/4` for the history, a measured
 * figure for the last prompt, and nothing at all for the tool result that is about to be appended.
 * It is therefore possible to walk into the wall with the gate reading "fine", and until now the
 * only thing behind the gate was `trimToContextWindow`, which keeps the request legal by dropping
 * the oldest turns out of the prompt for that call. The conversation loses its beginning without
 * anything having been summarised, which is precisely what compaction exists to prevent.
 *
 * Ported from pi's `packages/ai/src/utils/overflow.ts`, which is the most thorough version of this
 * in the field: a message denylist per provider family, plus the two shapes that carry no error at
 * all.
 */

/**
 * Substrings that mean "your input was too long", lowercased.
 *
 * Deliberately about the *input*: "max_tokens is too large" is a request-shape bug and compacting
 * would not fix it.
 */
const OVERFLOW_PATTERNS = [
  "context_length_exceeded",
  "context length exceeded",
  "maximum context length",
  "reduce the length of the messages",
  "prompt is too long",
  "input is too long",
  "input length exceeds",
  "too many tokens",
  "token limit exceeded",
  "exceeds the maximum number of tokens",
  "exceeds context window",
  "context window is exceeded",
  "request too large for",
  "please reduce the length",
  "the input or output tokens must be reduced",
  "string too long",
  "kv cache is full",
  "context size exceeded",
  "exceeds model context",
];

/**
 * Phrasings that contain a length word but are not an overflow.
 *
 * A rate limit that mentions tokens per minute is the classic false positive, and compacting in
 * answer to it burns a summarizer call and then hits the same limit.
 */
const NOT_OVERFLOW_PATTERNS = [
  "rate limit",
  "rate_limit",
  "tokens per min",
  "tokens per day",
  "quota",
  "throttl",
  "too many requests",
  "insufficient balance",
];

export function isOverflowMessage(message: string | undefined): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  if (NOT_OVERFLOW_PATTERNS.some((pattern) => text.includes(pattern))) return false;
  return OVERFLOW_PATTERNS.some((pattern) => text.includes(pattern));
}

export function isOverflowError(err: unknown): boolean {
  if (err instanceof Error) return isOverflowMessage(err.message);
  return isOverflowMessage(typeof err === "string" ? err : undefined);
}

/**
 * An overflow the provider never named.
 *
 * Two shapes, both measured by pi against real providers and both silent:
 *
 * - the endpoint accepts a prompt past its own window and answers normally, so the only evidence is
 *   that the input it billed does not fit the window it advertises;
 * - the endpoint truncates server-side and reports `length` with an empty completion, which reads
 *   as "the model chose to stop" unless the emptiness is noticed.
 *
 * `contextTokens` is the window we believe in, so a wrong window here reads as an overflow. That
 * error is self-correcting: a compaction happens, the next call is smaller, and the ratio test
 * (99%) keeps it from firing on a prompt that merely came close.
 */
export function isSilentOverflow(
  usage: LlmUsage | undefined,
  finishReason: string | undefined,
  contextTokens: number | undefined,
): boolean {
  if (!usage || !contextTokens || contextTokens <= 0) return false;
  // `promptTokens` is every input token the call read, cache buckets included: all three
  // transports normalise to that (docs/compaction.md). Adding `cacheReadTokens` on top read a
  // fully cached prompt as twice its size and fired this guard at half the window.
  const read = usage.promptTokens;
  if (read > contextTokens) return true;
  const truncatedEmpty = finishReason === "length" && usage.completionTokens === 0;
  return truncatedEmpty && read >= Math.floor(contextTokens * 0.99);
}
