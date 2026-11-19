/**
 * What a model says when its chat template was never applied: the conversation's own markup, in
 * the answer box.
 *
 * Measured 2026-11-19 on `synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017`: the endpoint serving
 * it does not format tools for it, so the model writes the format itself. It emits
 * `assistant to=functions.bash` followed by the arguments, and `<function_results>` followed by the
 * tool's output, as prose. It also continues the transcript instead of answering: the injected
 * `<context>` and `<memory-context>` blocks come back at the head of its reply, with the owner's
 * own question after them.
 *
 * None of this is a stream we produced: no frame of either repository ever writes those strings.
 * It is the model, and letting it through costs twice -- the reader gets a wall of markup, and the
 * log keeps it, so every later request replays it and the next model copies the pattern.
 *
 * Deliberately narrow: a leading block of our own scaffolding, or the markup of a chat template.
 * A model discussing that markup in an answer is a legitimate answer, and the patterns below only
 * match it at the head of the reply or as a template token.
 */
const LEAKS: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  // Our own per-turn scaffolding, echoed. It is only ever injected into a prompt we build.
  { what: "the turn context, echoed", pattern: /^\s*<context>[\s\S]{0,2000}?<\/context>/i },
  { what: "the memory block, echoed", pattern: /^\s*<memory-context>[\s\S]{0,4000}?<\/memory-context>/i },
  // Tool results rendered by a template that my-claw never sends as text. Three dialects seen on
  // the same lane: Harmony's `<function_results>`, and the XML-shaped `<result><name>…</name>
  // <output>…</output></result>` / `<tool_call>` blocks other templates emit.
  { what: "its tool results, as markup", pattern: /(?:^|\n)[ \t]*<?function_results>/i },
  { what: "its tool results, as markup", pattern: /(?:^|\n)[ \t]*<result>[ \t]*\n?[ \t]*<name>/i },
  { what: "its tool calls, as markup", pattern: /(?:^|\n)[ \t]*<tool_(?:call|response|result)>/i },
  // A tool call spelled out in the model's own format, at the head of a line.
  { what: "a tool call, as markup", pattern: /(?:^|\n)\s*(?:assistant\s+to=|to=functions\.)/i },
  // Raw control tokens of a chat template, which no answer of ours ever contains.
  { what: "raw template tokens", pattern: /(?:^|\n)[ \t]*<\|(?:im_start|im_end|endoftext)\|>|<\|tool[^|\n]{0,20}\|>/i },
];

/** What the answer leaks, or `undefined` when it is a plain answer. */
export function protocolLeakIn(text: string): string | undefined {
  if (!text.trim()) return undefined;
  return LEAKS.find(leak => leak.pattern.test(text))?.what;
}
