import { analyticsDb } from "../../src/analytics/usage-db.ts";

/**
 * The state the retired retention policy left behind: rows folded into the monthly rollup and gone
 * from `api_calls`.
 *
 * Nothing deletes a call any more (2026-09-17: every row stays forever), so the purge is not a
 * writer a test may call. But every reader that has to survive a rolled month -- the totals that add
 * `rollup + live`, the views that stop at `detailSince` -- still needs that state to be reachable,
 * so it is sown directly here, from the same rows the old purge would have condemned.
 *
 * Frozen money is split the way the rollup holds it (charged apart from reference), and the calls
 * that carry no cost are counted unpriced: what the live ladder would have priced at purge time is
 * the one thing this cannot reproduce, and no test needs it.
 */
export function foldBefore(cutoff: string): void {
  const db = analyticsDb();
  db.prepare(`
    INSERT INTO usage_monthly (
      month, model, base_url, platform, caller,
      calls, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
      billed_usd, reference_usd, unpriced_calls, errors, duration_ms
    )
    SELECT
      substr(timestamp, 1, 7), model, base_url, platform, caller,
      COUNT(*),
      COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0),
      COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0),
      COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_billed = 1 THEN cost_usd ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL AND cost_billed <> 1 THEN cost_usd ELSE 0 END), 0),
      SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END),
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END),
      COALESCE(SUM(duration_ms), 0)
    FROM api_calls WHERE timestamp < $cutoff
    GROUP BY substr(timestamp, 1, 7), model, base_url, platform, caller
    ON CONFLICT (month, model, base_url, platform, caller) DO UPDATE SET
      calls              = calls + excluded.calls,
      prompt_tokens      = prompt_tokens + excluded.prompt_tokens,
      completion_tokens  = completion_tokens + excluded.completion_tokens,
      cache_read_tokens  = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      billed_usd         = billed_usd + excluded.billed_usd,
      reference_usd      = reference_usd + excluded.reference_usd,
      unpriced_calls     = unpriced_calls + excluded.unpriced_calls,
      errors             = errors + excluded.errors,
      duration_ms        = duration_ms + excluded.duration_ms
  `).run({ $cutoff: cutoff });
  db.run("DELETE FROM api_calls WHERE timestamp < ?", [cutoff]);
}
