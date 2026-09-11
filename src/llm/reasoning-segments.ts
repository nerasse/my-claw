/**
 * One phase of an answer as the reader saw it: what the model thought, then what it wrote. A
 * response that thinks twice produces two, because the second thought is about the words that
 * follow it and not about the ones already on screen -- docs/reasoning-visibility.md.
 */
export interface ReasoningSegment {
  reasoning?: string;
  /**
   * How long the thinking lasted, from its first delta to the text that followed it.
   *
   * Measured here because this is the only place that sees both ends of the span: a reopened
   * conversation used to keep the thought and lose its duration, so every replayed phase read as
   * an untimed aside while the one on screen had a counter.
   */
  reasoningMs?: number;
  content: string;
}

/**
 * Cuts one API response into the bubbles the channel streamed live. The rule is the streamer's
 * own (`MyClawAppStreamer.sealBeforeReasoning`): reasoning arriving after visible text opens the
 * next segment. Both have to agree, since one drives the live view and this one drives the replay
 * of it; `tests/channels/reasoning-segments.test.ts` pins them to the same event order.
 */
export class ReasoningSegmenter {
  private segments: Array<ReasoningSegment & { startedAt?: number }> = [];

  /** The clock, injected so a test can pin a span instead of racing it. */
  constructor(private readonly now: () => number = Date.now) {}

  reasoning(delta: string): void {
    if (!delta) return;
    const open = this.segments[this.segments.length - 1];
    if (!open || open.content.length > 0) {
      this.segments.push({ reasoning: delta, content: "", startedAt: this.now() });
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
    // The thought is over the moment prose starts: that is the span the reader waited through.
    this.close(open);
    open.content += delta;
  }

  /**
   * How long the turn spent thinking, across its phases.
   *
   * `list()` answers `undefined` for a single-segment turn -- one segment says what `content` and
   * `reasoning` already say, and the log stores those -- so the duration of that one thinking span
   * has no other way out.
   */
  thinkingMs(): number | undefined {
    for (const segment of this.segments) this.close(segment);
    const total = this.segments.reduce((sum, segment) => sum + (segment.reasoningMs ?? 0), 0);
    return total > 0 ? total : undefined;
  }

  /**
   * The phases, or nothing when the response only had one: a single segment says exactly what
   * `content` and `reasoning` already say, and storing it would double every turn on disk.
   */
  list(): ReasoningSegment[] | undefined {
    if (this.segments.length < 2) return undefined;
    return this.segments.map((segment) => this.published(segment));
  }

  /** Closes an open thinking span, once. A segment that already has its duration keeps it. */
  private close(segment: ReasoningSegment & { startedAt?: number }): void {
    if (segment.startedAt === undefined) return;
    const span = Math.max(0, this.now() - segment.startedAt);
    // A span of zero is not a span: it is what the same tick looks like, and writing it would put
    // a duration of nothing on every phase a test replays in one go.
    if (span > 0) segment.reasoningMs = span;
    delete segment.startedAt;
  }

  private published(segment: ReasoningSegment & { startedAt?: number }): ReasoningSegment {
    this.close(segment);
    const { startedAt: _startedAt, ...published } = segment;
    return published;
  }
}
