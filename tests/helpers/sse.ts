/**
 * A chat-completions answer in the shape the streaming transports actually read.
 *
 * The compaction summarizer streams since 2026-09-12 (docs/compaction.md): a budget is "time with
 * not one byte received", and a one-shot call turned it into a hard ceiling on the whole
 * operation. A mock that answers a finished JSON body is therefore answered a null stream, and the
 * compaction reports an empty summary -- which is how these tests failed, not a real regression.
 *
 * The text is cut into pieces so the stream is a stream: a progress emitter that batches on size
 * needs more than one chunk to have anything to report.
 */

/** Pieces the content is delivered in. Small enough to exercise batching, big enough to be fast. */
const CHUNK_CHARS = 48;

interface CompletionLike {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: Record<string, number>;
}

export function sseFromCompletion(completion: CompletionLike): Response {
  const choice = completion.choices?.[0];
  const content = choice?.message?.content ?? "";
  const finishReason = choice?.finish_reason ?? "stop";
  return sseResponse(content, { finishReason, ...(completion.usage ? { usage: completion.usage } : {}) });
}

export function sseResponse(
  content: string,
  extra?: { finishReason?: string; usage?: Record<string, number> },
): Response {
  const frames: string[] = [];
  for (const piece of content.match(new RegExp(`[\\s\\S]{1,${CHUNK_CHARS}}`, "g")) ?? []) {
    frames.push(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  // The reason has to be on a delta of its own: the transport reads it off `choices[0]`, and a
  // chunk carrying content would work too but reads as if the text ended early.
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: extra?.finishReason ?? "stop" }] })}\n\n`);
  if (extra?.usage) frames.push(`data: ${JSON.stringify({ choices: [], usage: extra.usage })}\n\n`);
  frames.push("data: [DONE]\n\n");
  return new Response(frames.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
