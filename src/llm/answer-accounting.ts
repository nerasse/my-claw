import type { LlmUsage } from "./provider.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * How a reply fails to add up to what its own usage says it could be, if it does.
 *
 * An OpenAI-compatible endpoint splits one token stream in two: the thinking goes to
 * `reasoning_content`, the rest to `content`, and the usage says how many of the completion tokens
 * were thinking. When a serving stack loses that split, the reply arrives with no reasoning text
 * and an answer the billing does not support. Two shapes have been measured, both on Synthetic's
 * DeepSeek V4.1 Flash on 2026-11-21:
 *
 * - `draft`: 613 of 615 completion tokens billed as reasoning beside 2,042 characters of answer
 *   that replayed the prompt's own scaffolding.
 * - `stub`: 7 of 8 billed as reasoning beside 21 characters -- `docs/oss-pipeline.md>`, a fragment
 *   with no sentence in it, which the reader got as the whole answer (thread `4d5775e7`, seq 55060).
 *   One token was billed as answer and the reply carried six, so the wide margin below could not
 *   see it: a 16-token cushion is larger than the entire reply.
 *
 * The provider's accounting is the evidence, never the words. A model whose thinking arrived on its
 * own channel was split correctly, and nothing here second-guesses it.
 *
 * Nothing is scoped to one provider or one model. The rule is the wire's own arithmetic, so it
 * holds wherever an endpoint publishes a reasoning split.
 */
export type AccountingMismatch = "stub" | "draft";

/** A reply this short cannot spend the cushion the draft rule allows, so it is judged with none. */
const STUB_MAX_TOKENS = 16;

/**
 * How much bigger the answer is than the answer budget, beyond any estimate's own error.
 *
 * The same 2x ratio the draft rule uses: replies of models whose reasoning stays hidden land at
 * 1.3x at most (63 of them, 2026-11), and every malformed one measured sits at 2.7x or more.
 */
function exceedsBudget(written: number, billed: number, cushion: number): boolean {
  return written > 2 * billed + cushion;
}

export function replyAccountingMismatch(
  content: string,
  reasoning: string,
  usage: LlmUsage | undefined,
): AccountingMismatch | undefined {
  if (!usage || reasoning) return undefined;
  const text = content.trim();
  if (!text) return undefined;
  const { completionTokens, reasoningTokens = 0 } = usage;
  if (
    !Number.isSafeInteger(completionTokens) ||
    !Number.isSafeInteger(reasoningTokens) ||
    reasoningTokens <= 0 ||
    reasoningTokens > completionTokens
  ) {
    return undefined;
  }
  const written = estimateTokens(text);
  const billed = completionTokens - reasoningTokens;
  // The draft rule's 16-token cushion is larger than such a reply altogether, so an answer billed
  // as one token and written as six sat under it. This one asks for the ratio and nothing else.
  if (written <= STUB_MAX_TOKENS) return exceedsBudget(written, billed, 2) ? "stub" : undefined;
  return exceedsBudget(written, billed, 16) ? "draft" : undefined;
}
