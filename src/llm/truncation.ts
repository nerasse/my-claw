/**
 * Whether a terminal reason means the answer was cut by the output ceiling.
 *
 * Three wire protocols, three spellings: the OpenAI-compatible one says `length`, the Anthropic
 * Messages API says `max_tokens`, and the Codex Responses API says `incomplete`. Three call sites
 * tested `=== "length"` in hard, and that is the OpenAI one: a truncated Anthropic answer carries
 * text and `finish_reason: "max_tokens"` with `incomplete: false`, so it read as a complete answer.
 * The compaction stored those summaries cut mid-sentence -- the exact failure the ceiling was added
 * to refuse.
 */
export function cutByOutputCeiling(finishReason: string | undefined): boolean {
  return finishReason === "length" || finishReason === "max_tokens" || finishReason === "incomplete";
}
