import { createHash } from "node:crypto";

/**
 * Measures how much new information a run's tool calls are actually producing. It reports and does
 * nothing else.
 *
 * A stagnation *detector* was the obvious next move after the wandering was diagnosed, and 141 runs
 * of real history say it does not work yet. Duplicate tool calls were already known to be near zero
 * on the models that wander; duplicate tool *results* looked far more promising, at a 47.6 % median
 * on runs past 120 results against 0-4.7 % below that. But measured through the sliding window a
 * detector would actually use, the two populations overlap and in places invert: a healthy 8-result
 * run saturated the barren-result count at 8 and finished fine, while the second-longest run in the
 * corpus peaked at 4. Any threshold would have fired hardest on the shortest runs and missed one
 * pathological run in four -- and with only four long runs in the corpus, the sample cannot settle
 * it either.
 *
 * So this collects the signal on real traffic instead of guessing a constant. When there are enough
 * long runs to separate the populations, the threshold comes from the data. See
 * docs/context-pruning.md.
 */

/** The window a detector would plausibly use, and the one the corpus was scored with. */
const WINDOW = 10;

/**
 * Results that answer "nothing here". Deliberately broad: the point is to count how often a run
 * learns nothing, not to classify failures precisely.
 */
const BARREN = /^\s*$|no matches|no files matching|^error:|not found|no such file|command failed|exit [1-9]/i;

function isBarren(result: string): boolean {
  return result.trim().length === 0 || BARREN.test(result.slice(0, 200));
}

export interface StagnationReport {
  toolResults: number;
  distinctResults: number;
  /** Most occurrences of one identical result inside any `WINDOW` consecutive results. */
  maxRepeatInWindow: number;
  /** Most barren results inside any `WINDOW` consecutive results. */
  maxBarrenInWindow: number;
  /** Times the single most repeated result came back, across the whole run. */
  topRepeat: number;
}

export class StagnationMeter {
  private counts = new Map<string, number>();
  private recent: Array<{ hash: string; barren: boolean }> = [];
  private total = 0;
  private maxRepeat = 0;
  private maxBarren = 0;
  private top = 0;

  observe(result: string): void {
    const hash = createHash("sha256").update(result).digest("hex").slice(0, 16);
    this.total += 1;
    const seen = (this.counts.get(hash) ?? 0) + 1;
    this.counts.set(hash, seen);
    if (seen > this.top) this.top = seen;

    this.recent.push({ hash, barren: isBarren(result) });
    if (this.recent.length > WINDOW) this.recent.shift();

    let repeat = 0;
    let barren = 0;
    for (const entry of this.recent) {
      if (entry.hash === hash) repeat += 1;
      if (entry.barren) barren += 1;
    }
    if (repeat > this.maxRepeat) this.maxRepeat = repeat;
    if (barren > this.maxBarren) this.maxBarren = barren;
  }

  report(): StagnationReport {
    return {
      toolResults: this.total,
      distinctResults: this.counts.size,
      maxRepeatInWindow: this.maxRepeat,
      maxBarrenInWindow: this.maxBarren,
      topRepeat: this.top,
    };
  }
}
