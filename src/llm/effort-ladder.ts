import { EFFORT_ORDER, type EffortLevel } from "../core/config.ts";
import { log } from "../utils/logger.ts";
import { TtlSet } from "../utils/lru-map.ts";

/**
 * Clamps already reported. Keyed by the model and the two rungs, so a level pinned once is
 * explained once instead of on every menu render: `effectiveEffort` resolves through the same
 * helper as the run, and the pickers call it on every keystroke.
 *
 * A TTL rather than a plain Set: the pair is worth remembering for a while, not forever, and a
 * config edit that fixes the pin should eventually be able to warn again if it comes back.
 */
const warned = new TtlSet<string>(60 * 60 * 1000, 1_000);

/**
 * The level a model actually receives, given the ladder it publishes.
 *
 * A pin follows the scope it lives on -- a tag, an agent, the global default -- while the model
 * under it changes, so a level that existed when it was written may not exist now. Clamping to the
 * nearest rung keeps the run going and keeps the intent ("more" stays high, "less" stays low),
 * where sending the level verbatim earns a 400 from providers that validate it, and dropping it
 * silently lands on the provider's own default -- often the opposite of what was asked.
 *
 * Ties go **down**: at equal distance, spending less than asked is a smaller surprise than
 * spending more. Only a published ladder clamps; an unknown one is no evidence at all, so the
 * level passes through untouched (docs/model-metadata.md).
 */
export function clampEffortToLadder(
  level: EffortLevel,
  ladder: readonly EffortLevel[] | undefined,
  modelId: string,
): EffortLevel {
  if (!ladder || ladder.length === 0 || ladder.includes(level)) return level;
  const want = EFFORT_ORDER.indexOf(level);
  if (want < 0) return level;

  let best: EffortLevel | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const rung of ladder) {
    const at = EFFORT_ORDER.indexOf(rung);
    if (at < 0) continue;
    const distance = Math.abs(at - want);
    // `<` alone would keep the first rung met at that distance, which depends on the order the
    // provider published; comparing the rungs themselves is what makes the tie deterministic.
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && at < EFFORT_ORDER.indexOf(best))) {
      best = rung;
      bestDistance = distance;
    }
  }
  if (best === undefined || best === level) return level;

  const key = `${modelId}:${level}>${best}`;
  if (!warned.has(key)) {
    warned.add(key);
    void log("warn", "effort level is not on this model's ladder, clamping", {
      model: modelId,
      effort: level,
      clamped: best,
      ladder: [...ladder],
    });
  }
  return best;
}

/** Test seam: the set is module state shared by every test file. */
export function resetEffortClampNotices(): void {
  warned.clear();
}
