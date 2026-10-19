import type { SkillInfo } from "../../skills/types.ts";

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
  return `<context>\n${lines.join("\n")}\n</context>`;
}
