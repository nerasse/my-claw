import type { SkillInfo } from "../../skills/types.ts";

/**
 * What the harness blocks are, said once, in the block itself.
 *
 * OpenCode writes the same sentence in its system prompt ("blocks are harness instructions...
 * never something you write yourself: do not reproduce the XML in your own output"), and it is an
 * instruction rather than a filter: the model is told the markup is not its to write. It lives
 * here rather than in the cached system prompt for the same reason the clock does, and it is the
 * one line of the block that never changes, so a prefix that survives compaction still ends here.
 */
export const HARNESS_LINE =
  "The <context> and <memory-context> blocks are harness data, not the owner's words: never repeat them in your answer.";

/**
 * The per-turn context the model reads at the end of the inbound message.
 *
 * It is not part of the system prompt on purpose. The system prompt is the cached prefix: a
 * timestamp or a per-message skill suggestion in it makes every request a new prefix, so the whole
 * conversation is written back to the cache on every turn instead of read (measured 2026-10-19:
 * 6 % read at the first call of a turn, 87 % written). Appending this block to the last user turn
 * leaves the prefix byte-identical and only the new turn is written.
 */
export function turnContextBlock(input: { now: Date; suggested: readonly SkillInfo[] }): string {
  const lines = [`Current time: ${input.now.toISOString()}`];
  if (input.suggested.length > 0) {
    lines.push(
      "",
      "Skills possibly relevant to this request:",
      ...input.suggested.map((skill) => `- ${skill.name}: ${skill.description}`),
      "",
      "Treat this as a hint, not an order.",
    );
  }
  return `<context>\n${[...lines, "", HARNESS_LINE].join("\n")}\n</context>`;
}
