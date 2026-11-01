import type { MyClawConfig, ResolvedLlmConfig } from "../../core/config.ts";
import { isQuotaSpent } from "../outage.ts";
import { quotaFor, quotaSourceOf } from "./index.ts";
import { needsQuotaOracle, spentWindowOf } from "./retry.ts";

/**
 * The wall predicate a call must carry so its transport does not retry a bar that will not move.
 *
 * Every transport asks this before retrying a 429 that says nothing decisive, but the predicate
 * lives on the config and only the agent loop used to attach it. The summarizer and memory
 * consolidation call `llmCompleteStream` directly, and they are exactly the calls that run while a
 * plan is already spent -- so a wall cost them their transport's three attempts each time.
 *
 * Forced, because the question is being asked now: a reading up to five minutes old (the claude
 * TTL) can predate the wall it is being asked about, and answering from it is what let a run pay
 * three attempts plus 30/60/120 s on a bar that had just filled (measured 2026-11-01).
 */
export function wallConfig(config: MyClawConfig, resolved: ResolvedLlmConfig): ResolvedLlmConfig {
  if (resolved.isWall) return resolved;
  const provider = resolved.provider;
  if (!provider || !quotaSourceOf(config.llm?.providers?.[provider])) return resolved;
  return {
    ...resolved,
    isWall: async (err: unknown) => {
      if (!needsQuotaOracle(err)) return isQuotaSpent(err);
      const outcome = await quotaFor(config, provider, { force: true }).catch(() => undefined);
      return outcome ? spentWindowOf(outcome) !== undefined : false;
    },
  };
}
