/**
 * One phase of an answer as the reader saw it: what the model thought, then what it wrote. A
 * response that thinks twice produces two, because the second thought is about the words that
 * follow it and not about the ones already on screen -- docs/reasoning-visibility.md.
 */
export interface ReasoningSegment {
  reasoning?: string;
  content: string;
}

/**
 * Cuts one API response into the bubbles the channel streamed live. The rule is the streamer's
 * own (`MyClawAppStreamer.sealBeforeReasoning`): reasoning arriving after visible text opens the
 * next segment. Both have to agree, since one drives the live view and this one drives the replay
 * of it; `tests/channels/reasoning-segments.test.ts` pins them to the same event order.
 */
export class ReasoningSegmenter {
  private segments: ReasoningSegment[] = [];

  reasoning(delta: string): void {
    if (!delta) return;
    const open = this.segments[this.segments.length - 1];
    if (!open || open.content.length > 0) {
      this.segments.push({ reasoning: delta, content: "" });
      return;
    }
    open.reasoning = (open.reasoning ?? "") + delta;
  }

  text(delta: string): void {
    if (!delta) return;
    const open = this.segments[this.segments.length - 1];
    if (!open) {
      this.segments.push({ content: delta });
      return;
    }
    open.content += delta;
  }

  /**
   * The phases, or nothing when the response only had one: a single segment says exactly what
   * `content` and `reasoning` already say, and storing it would double every turn on disk.
   */
  list(): ReasoningSegment[] | undefined {
    if (this.segments.length < 2) return undefined;
    return this.segments.map((segment) => ({ ...segment }));
  }
}
