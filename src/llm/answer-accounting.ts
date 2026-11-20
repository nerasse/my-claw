import type { LlmUsage } from "./provider.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * Whether a chat-completions reply is the model's thinking, delivered in the answer channel.
 *
 * An OpenAI-compatible endpoint serves a reasoning model by splitting one token stream in two: the
 * thinking goes to `reasoning_content`, the rest to `content`, and the usage says how many of the
 * completion tokens were reasoning. When the model never closes its thinking, a serving stack can
 * still bill those tokens as reasoning yet stream them as `content`. The reader gets the draft, the
 * log keeps it, and every later request replays it until the next model copies the pattern.
 * Measured on Synthetic's DeepSeek V4.1 Flash (2026-11-19 and 20): 613 of 615 completion tokens
 * billed as reasoning, 2 042 characters of `content` that replayed the prompt's own scaffolding.
 *
 * The provider's accounting is the evidence, never the words: it billed `completion - reasoning`
 * tokens of answer, and a `content` several times that size is not the answer it billed. Only when
 * no reasoning text came through at all -- a model whose thinking arrived on its own channel was
 * split correctly. The margin is wide on purpose: replies of models whose reasoning stays hidden
 * land at 1.3x at most (63 of them, 2026-11), every malformed one measured sits at 2.7x or more.
 */
export function reasoningSentAsAnswer(content: string, reasoning: string, usage: LlmUsage | undefined): boolean {
  const thought = usage?.reasoningTokens ?? 0;
  if (thought === 0 || reasoning.length > 0 || content.trim().length === 0) return false;
  const billed = Math.max(0, (usage?.completionTokens ?? 0) - thought);
  return estimateTokens(content) > 2 * billed + 16;
}
