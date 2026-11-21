/**
 * A reply that carries the conversation's scaffolding instead of answering.
 *
 * Two things land here, and they have one cause: the endpoint did not apply the model's chat
 * template, so the model writes the format itself and continues the transcript rather than
 * answering. Measured on `synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017` (2026-11-19 and
 * 2026-11-20) and on `opencode_go/deepseek-v4.1-flash` (2026-11-17):
 *
 * - **Our own turn scaffolding comes back**, with an earlier question behind it. The model retypes
 *   `<context>` and the `[Audio]: "…"` line of a turn that is already in the history.
 * - **Another harness's control markup appears**, which no frame of ours writes: `<budget:
 *   token_budget>200000</budget:token_budget>`, `<|im_start|>`, `assistant to=functions.bash`,
 *   `<function_results>`, `ds_safety`.
 *
 * Letting one through costs twice, and the second cost is the one that compounds: the reader gets
 * a wall of markup, and the text is journalled, so every later request replays it and the next
 * model copies the shape.
 *
 * The first version of this check matched a marker anywhere in the text, and it refused a
 * legitimate Opus answer that quoted `<ds_safety>` while explaining it (2026-11-20). That is why it
 * was deleted in favour of protocol-level checks, and why the protocol checks could not replace it:
 * a reply that echoes a prompt ends with a valid finish reason and ordinary usage, so it is a
 * well-formed stream carrying garbage. Every pattern below therefore asks for what a *template*
 * emits and prose does not: the clock behind our block, a figure inside a gauge, a delimiter at the
 * start of a line. Nothing matches inside a fence, which is how an answer quotes the thing it is
 * explaining.
 *
 * One shape is not a marker at all, because the leak does not always carry one: the reply simply
 * **continues a text that was already begun**. A chat template ends on the assistant header, so the
 * first character a model generates is the first character of its answer -- a space in front of it
 * means the model is mid-way through somebody else's sentence. Measured over the whole corpus on
 * 2026-11-21 (48 587 phases of every thread): nine replies open on whitespace, and all nine are
 * fragments -- ` reward\n2 / 2`, ` adipiscing\nLet me give him a straight answer`, ` growing the
 * team and expanding into new areas.` behind another answer's tail. Not one legitimate answer opens
 * on a space. Newlines are left alone: a reply that begins with a blank line is ordinary
 * formatting, a reply that begins *inside a line* is not.
 */
const FENCE = /^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1.*$/gm;

const ECHOES: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: "the turn context", pattern: /(?:^|\n)[ \t]*<context>[\s\S]{0,4000}?(?:Current time[:=]|Current date[:=])/i },
  // The turn envelope our own channel writes, which is the same leak one layer lower: the model
  // continues the transcript it was handed instead of answering. `[Audio]: "…"` is what the
  // preprocessor puts in front of a voice note's words, so a line of it is never prose -- the
  // header above has promised this pattern since it was written, and the table never held it.
  // Measured 2026-11-21, thread d1b09fdd seq 9530: the reply opened ` growing the team and
  // expanding into new areas.` (a fragment of another answer) then a `[Audio]: " Attends, attends…"`
  // line the owner never recorded, then went on as if it were his turn. Two earlier replies died
  // the same way (`水煎服` on 2026-11-20). Line-anchored with the opening quote, so an answer that
  // names the marker mid-sentence, or quotes it in a fence, stays an answer.
  // Every form `preprocess.ts` writes after the label: the words in quotes, or one of its four
  // bracket notices (no STT configured, an unavailable file, a failed transcription, a failed
  // frame extraction). A label followed by anything else is prose.
  { what: "the transcript line of a turn", pattern: /(?:^|\n)[ \t]*\[(?:Audio(?: \d+)?|Video)\]:[ \t]*(?:["«]|\[(?:voice\/STT|unavailable|Transcription|Frame extraction))/i },
  // The other half of that envelope: the block the same writer appends, recognised by the media
  // file its first line names. Narrowed to recordings on purpose. `[Audio]`/`[Video]` is the
  // transcript envelope and no answer writes it; an `- image: /path.png` bullet is something an
  // agent legitimately reports when it says what it received, and the owner asked exactly that
  // ("tu as eu quoi aux messages précédents de ma part ?"), so an image listing stays an answer.
  { what: "the attachment block of a turn", pattern: /(?:^|\n)[ \t]*\[Attachments\][ \t]*\n[ \t]*- (?:audio|video): [^\n]{0,300}?\.(?:weba|m4a|mp3|ogg|opus|wav|flac|mp4|mov|webm)\b/i },
  { what: "the memory block", pattern: /(?:^|\n)[ \t]*<memory-context>[\s\S]{0,6000}?<\/memory-context>/i },
  // A budget gauge with its figure: the harness that writes it caps it at a round number.
  { what: "a harness token gauge", pattern: /(?:^|\n)[ \t]*<budget:[a-z_]{1,24}>[ \t]*\d{2,8}[ \t]*<\//i },
  // Tool results rendered by a template that my-claw never sends as text. Three dialects seen on
  // the same lanes: Harmony's `<function_results>`, and the XML-shaped `<result><name>…</name>` /
  // `<tool_call>` blocks other templates emit.
  { what: "its tool results as markup", pattern: /(?:^|\n)[ \t]*<?function_results>/i },
  { what: "its tool results as markup", pattern: /(?:^|\n)[ \t]*<result>[ \t]*\n?[ \t]*<name>/i },
  { what: "its tool calls as markup", pattern: /(?:^|\n)[ \t]*<tool_(?:call|response|result)>/i },
  // A tool call spelled out in the model's own format, at the head of a line.
  { what: "a tool call as markup", pattern: /(?:^|\n)[ \t]*(?:assistant\s+to=|to=functions\.)/i },
  // Raw control tokens of a chat template. A template delimiter at the edge of a line, never prose.
  { what: "raw chat-template tokens", pattern: /(?:^|\n)[ \t]*<\|(?:im_start|im_end|endoftext|eot_id|start_header_id|end_header_id)\|>|<\|tool[^|\n]{0,20}\|>/i },
  // The safety classifier of the same model family, printed as its own verdict in the reply box:
  // `«<ds_safety>[用户未成年]否</ds_safety>Safe`, then `#<ds_safety>Safe` one turn later
  // (2026-11-20). Line-anchored, with the stray punctuation the model puts in front of it, so a
  // sentence that quotes the tag mid-line stays an answer.
  { what: "its safety classifier", pattern: /(?:^|\n)[ \t]*[«»#'#›|]{0,2}[ \t]*<\/?ds_safety>/i },
];

/**
 * What the reply carries of a prompt rather than an answer, or `undefined` when it carries none.
 *
 * Fed the answer text only: thinking is allowed to discuss the prompt, and routinely does.
 */
export function promptEchoIn(text: string): string | undefined {
  if (!text.trim()) return undefined;
  const bare = text.replace(FENCE, "");
  // The named shapes first: one that says *what* was retyped is a better diagnosis than the
  // generic one, and every fixture that carries both is a named leak that happens to open on a
  // space (` maggiore\n\n<context>`). The continuation rule is the net for the ones with no marker.
  const named = ECHOES.find((echo) => echo.pattern.test(bare))?.what;
  if (named) return named;
  // Never inside a fence: this is about where the reply starts.
  return /^[ \t]+\S/.test(text) ? "a continuation of a text it had already begun" : undefined;
}
