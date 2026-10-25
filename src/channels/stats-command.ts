import type { MyClawConfig } from "../core/config.ts";
import { usageHorizon } from "../analytics/usage-db.ts";
import { toolStats } from "../analytics/tool-calls.ts";
import {
  filterNarrows,
  filterReachesRollup,
  reachesRollup,
  usageByCaller,
  usageByDay,
  usageByModel,
  usageBySession,
  usageFacets,
  NO_FOLDER,
  UNKNOWN_PROVIDER,
  type StatsFilter,
  type UsageGroup,
} from "../analytics/usage-stats.ts";
import { firstUserTextBySession } from "../conversations/store.ts";
import { stripLocationBlock, splitAttachmentBlock } from "../agent/preprocess.ts";
import { isOpenRouterBaseUrl } from "../llm/openrouter-endpoints.ts";
import { cachedOpenRouterAccount, openRouterLedgers, warmOpenRouterAccount } from "../llm/openrouter-account.ts";
import type { ModelPricing } from "../llm/pricing.ts";
import { providerLabels, routeOf, type ProviderLabel } from "./usage-route.ts";
import { MAX_TITLE_LENGTH } from "./my-claw-app/sessions.ts";
import type {
  MyClawAppStatsCache,
  MyClawAppStatsCallerRow,
  MyClawAppStatsDayRow,
  MyClawAppStatsFacetFolder,
  MyClawAppStatsFacets,
  MyClawAppStatsFacetSession,
  MyClawAppStatsFilter,
  MyClawAppStatsLabelSource,
  MyClawAppStatsModelRow,
  MyClawAppStatsPayload,
  MyClawAppStatsPeriod,
  MyClawAppStatsProviderKeyRow,
  MyClawAppStatsProviderRow,
  MyClawAppStatsReconciliation,
  MyClawAppStatsReliabilityRow,
  MyClawAppStatsSessionRow,
  MyClawAppStatsTools,
  MyClawAppStatsTotals,
} from "./my-claw-app/types.ts";

/**
 * The install-wide statistics page: everything this instance has ever spent, over one period.
 *
 * Deliberately not a conversation's report. `/status` answers "what is this chat doing and what has
 * it cost"; this answers "what has this install cost", which is a different question with different
 * scoping rules -- a provider bills a key, a session that was deleted still spent money, and a
 * ninety-day retention wall hides most of the history unless something survived it.
 *
 * See docs/stats-page.md.
 */

export interface StatsParams {
  config: MyClawConfig;
  period: MyClawAppStatsPeriod;
  /** What to narrow the report to. Absent is the whole window. */
  filter?: StatsFilter;
  pricing?: ModelPricing;
  /**
   * What the session store still holds for a session, or `undefined` when it holds nothing: the
   * analytics outlive the sessions by design, so "gone" is a normal answer and not an error.
   *
   * `title` is the name the owner gave it, and only that. A conversation he never renamed is a
   * live session with no title, which is answered here as `{}` and labelled from the archive like
   * a deleted one -- deriving it from the log instead would open one file per conversation, and
   * there are three hundred of them.
   */
  sessionInfo(sessionId: string): Promise<{ title?: string } | undefined>;
  /**
   * The owner's folders, so a `folder_id` on a row can be named. Read from the channel's store,
   * which is the only place the names live; an id whose folder is gone is labelled as such by the
   * report rather than dropped -- its rows still spent money.
   */
  folders: Array<{ id: string; name: string }>;
}

function emptyTotals(): MyClawAppStatsTotals {
  return {
    calls: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billedUsd: 0,
    referenceUsd: 0,
    unpriced: 0,
    durationMs: 0,
  };
}

function add(into: MyClawAppStatsTotals, more: MyClawAppStatsTotals): void {
  into.calls += more.calls;
  into.errors += more.errors;
  into.promptTokens += more.promptTokens;
  into.completionTokens += more.completionTokens;
  into.cacheReadTokens += more.cacheReadTokens;
  into.cacheWriteTokens += more.cacheWriteTokens;
  into.billedUsd += more.billedUsd;
  into.referenceUsd += more.referenceUsd;
  into.unpriced += more.unpriced;
  into.durationMs += more.durationMs;
}

/**
 * One group's money.
 *
 * A **rolled-up month is settled**: the purge already applied the rule below, in the last moment
 * its rows existed, and wrote the result down. Re-pricing it here would charge tokens that were
 * already accounted for, and would restate a closed month every time the price table moves --
 * including on a month closed before any table was in hand, where it would invent a figure out of
 * tokens alone.
 *
 * A **live group** is priced now, and the rule is the same one the purge used:
 *
 * - every call frozen with a cost -> the frozen money is the answer, whatever the table says today.
 *   A provider raising its tariff must not restate a year of spend, which is why those columns
 *   exist, and it is the only rule under which a rolled-up month and a live row can be added.
 * - any call not frozen -> the group is priced from its tokens through the live ladder, and the
 *   frozen part is ignored rather than added to it: a partial sum plus a full estimate counts the
 *   same calls twice.
 * - the ladder cannot price it either -> the calls are kept and the money is not, which `unpriced`
 *   is there to say out loud.
 */
function pricedTotals(group: UsageGroup, pricing?: ModelPricing): MyClawAppStatsTotals {
  const totals: MyClawAppStatsTotals = {
    calls: group.calls,
    errors: group.errors,
    promptTokens: group.promptTokens,
    completionTokens: group.completionTokens,
    cacheReadTokens: group.cacheReadTokens,
    cacheWriteTokens: group.cacheWriteTokens,
    billedUsd: 0,
    referenceUsd: 0,
    unpriced: 0,
    durationMs: group.durationMs,
  };
  if (group.origin === "rollup" || group.unpricedCalls === 0) {
    totals.billedUsd = group.billedUsd;
    totals.referenceUsd = group.referenceUsd;
    totals.unpriced = group.unpricedCalls;
    return totals;
  }
  const cost = pricing?.costOf({
    model: group.model,
    baseUrl: group.baseUrl,
    promptTokens: group.promptTokens,
    completionTokens: group.completionTokens,
    cacheReadTokens: group.cacheReadTokens,
    cacheWriteTokens: group.cacheWriteTokens,
    ...(group.upstreamApiBase === null ? {} : { upstreamApiBase: group.upstreamApiBase }),
  });
  if (!cost) totals.unpriced = group.calls;
  else if (cost.billed) totals.billedUsd = cost.usd;
  else totals.referenceUsd = cost.usd;
  return totals;
}

/** A group and what it cost, so a view can fold either without pricing the same tokens twice. */
interface Priced<G extends UsageGroup> {
  group: G;
  totals: MyClawAppStatsTotals;
}

function price<G extends UsageGroup>(groups: G[], pricing?: ModelPricing): Array<Priced<G>> {
  return groups.map((group) => ({ group, totals: pricedTotals(group, pricing) }));
}

function foldInto<G extends UsageGroup>(rows: Array<Priced<G>>, keyOf: (g: G) => string): Map<string, { first: G; totals: MyClawAppStatsTotals }> {
  const out = new Map<string, { first: G; totals: MyClawAppStatsTotals }>();
  for (const row of rows) {
    const key = keyOf(row.group);
    const held = out.get(key);
    if (held) add(held.totals, row.totals);
    else out.set(key, { first: row.group, totals: { ...row.totals } });
  }
  return out;
}

function spend(t: MyClawAppStatsTotals): number {
  return t.billedUsd + t.referenceUsd;
}

/** Spend first, calls as the tie-break: two free models must not swap places between redraws. */
function bySpend(a: MyClawAppStatsTotals, b: MyClawAppStatsTotals): number {
  return spend(b) - spend(a) || b.calls - a.calls;
}

function modelRows(rows: Array<Priced<UsageGroup>>, labelOf: ProviderLabel): MyClawAppStatsModelRow[] {
  const folded = foldInto(rows, (g) => `${g.model}\u0000${routeOf(g.model, g.baseUrl).provider}\u0000${g.providerKey ?? ""}`);
  return [...folded.values()]
    .map(({ first, totals }) => ({
      model: first.model,
      providerKey: first.providerKey ?? UNKNOWN_PROVIDER,
      providerLabel: labelOf(first.providerKey),
      ...routeOf(first.model, first.baseUrl),
      ...totals,
    }))
    .sort(bySpend);
}

function providerKeyRows(rows: Array<Priced<UsageGroup>>, labelOf: ProviderLabel): MyClawAppStatsProviderKeyRow[] {
  const folded = foldInto(rows, (g) => g.providerKey ?? UNKNOWN_PROVIDER);
  return [...folded.values()]
    .map(({ first, totals }) => ({ providerKey: first.providerKey ?? UNKNOWN_PROVIDER, providerLabel: labelOf(first.providerKey), ...totals }))
    .sort(bySpend);
}

function providerRows(rows: Array<Priced<UsageGroup>>): MyClawAppStatsProviderRow[] {
  const folded = foldInto(rows, (g) => routeOf(g.model, g.baseUrl).provider);
  return [...folded.values()]
    .map(({ first, totals }) => {
      const route = routeOf(first.model, first.baseUrl);
      return { provider: route.provider, ...(route.providerName === undefined ? {} : { providerName: route.providerName }), ...totals };
    })
    .sort(bySpend);
}

/**
 * Error rate and mean latency, per model and per endpoint.
 *
 * Both halves come from the same groups as the money, so a model that cost nothing still has a
 * reliability row: a free endpoint timing out is exactly the failure this table exists to show.
 * Sorted by error rate, and by calls underneath it, so a single failed call on a one-call model
 * does not outrank a route that fails all day.
 */
function reliabilityRows(rows: Array<Priced<UsageGroup>>): MyClawAppStatsReliabilityRow[] {
  const build = (folded: Map<string, { first: UsageGroup; totals: MyClawAppStatsTotals }>, kind: "model" | "provider", keyOf: (g: UsageGroup) => string): MyClawAppStatsReliabilityRow[] =>
    [...folded.values()]
      .map(({ first, totals }) => ({
        key: keyOf(first),
        kind,
        calls: totals.calls,
        errors: totals.errors,
        errorRatePct: totals.calls > 0 ? (totals.errors / totals.calls) * 100 : 0,
        avgDurationMs: totals.calls > 0 ? Math.round(totals.durationMs / totals.calls) : 0,
      }))
      .sort((a, b) => b.errorRatePct - a.errorRatePct || b.calls - a.calls);
  return [
    ...build(foldInto(rows, (g) => g.model), "model", (g) => g.model),
    ...build(foldInto(rows, (g) => routeOf(g.model, g.baseUrl).provider), "provider", (g) => routeOf(g.model, g.baseUrl).provider),
  ];
}

function cacheOf(totals: MyClawAppStatsTotals): MyClawAppStatsCache {
  const base = totals.promptTokens;
  return {
    promptTokens: base,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    readSharePct: base > 0 ? (totals.cacheReadTokens / base) * 100 : 0,
    writeSharePct: base > 0 ? (totals.cacheWriteTokens / base) * 100 : 0,
  };
}

function callerRows(rows: Array<Priced<UsageGroup & { caller: string }>>): MyClawAppStatsCallerRow[] {
  const folded = foldInto(rows, (g) => g.caller);
  return [...folded.values()].map(({ first, totals }) => ({ caller: first.caller, ...totals })).sort((a, b) => b.calls - a.calls);
}

function dayRows(rows: Array<Priced<UsageGroup & { date: string }>>): MyClawAppStatsDayRow[] {
  const folded = foldInto(rows, (g) => g.date);
  return [...folded.values()].map(({ first, totals }) => ({ date: first.date, ...totals })).sort((a, b) => a.date.localeCompare(b.date));
}

/** The opening message of a conversation, read as a title the same way the thread drawer reads it. */
function labelFromMessage(raw: string): string {
  return stripLocationBlock(splitAttachmentBlock(raw).text).trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_LENGTH);
}

/** One conversation's name, and where it came from. */
interface SessionLabel {
  label: string;
  labelSource: MyClawAppStatsLabelSource;
  deleted: boolean;
}
/**
 * What each conversation is called, and where the name came from: the title the owner gave it, the
 * opening message the archive still holds, or -- when both are gone -- the bare session id.
 *
 * Split out of the ranking so the filter sheet can name a conversation without pricing a report it
 * is never going to show. One read per session either way, and the archive is asked once for all
 * the unnamed ones together.
 */
async function labelsOf(sessionIds: string[], infoOf: StatsParams["sessionInfo"]): Promise<Map<string, SessionLabel>> {
  const info = new Map<string, { title?: string } | undefined>();
  for (const sessionId of sessionIds) info.set(sessionId, await infoOf(sessionId));
  const unnamed = [...info].filter(([, held]) => !held?.title).map(([sessionId]) => sessionId);
  const archived = firstUserTextBySession(unnamed);

  const out = new Map<string, SessionLabel>();
  for (const [sessionId, stored] of info) {
    const title = stored?.title?.trim() ?? "";
    const opening = title ? "" : labelFromMessage(archived.get(sessionId) ?? "");
    out.set(sessionId, {
      label: title || opening || sessionId,
      labelSource: title ? "title" : opening ? "first-message" : "id",
      deleted: stored === undefined,
    });
  }
  return out;
}

/**
 * Every conversation that spent something, the ones that no longer exist included.
 *
 * A deleted session keeps its rows, so dropping it would make the ranking add up to less than the
 * total printed above it. Its label comes from the message archive, which is a second database:
 * the join is done here, in TypeScript, because the two files are attached to nothing in common
 * and a cross-database query would tie the analytics to an archive that can be absent. An archive
 * that has nothing leaves the id standing -- an invented title is worse than an ugly one.
 */
async function sessionRows(rows: Array<Priced<UsageGroup & { sessionId: string; parentSessionId: string; firstAt: string; lastAt: string }>>, infoOf: StatsParams["sessionInfo"]): Promise<MyClawAppStatsSessionRow[]> {
  const folded = new Map<string, { totals: MyClawAppStatsTotals; firstAt: string; lastAt: string; delegated: boolean }>();
  for (const row of rows) {
    const held = folded.get(row.group.sessionId);
    if (!held) {
      folded.set(row.group.sessionId, {
        totals: { ...row.totals },
        firstAt: row.group.firstAt,
        lastAt: row.group.lastAt,
        delegated: row.group.parentSessionId !== row.group.sessionId,
      });
      continue;
    }
    add(held.totals, row.totals);
    if (row.group.parentSessionId !== row.group.sessionId) held.delegated = true;
    if (row.group.firstAt < held.firstAt) held.firstAt = row.group.firstAt;
    if (row.group.lastAt > held.lastAt) held.lastAt = row.group.lastAt;
  }

  const labels = await labelsOf([...folded.keys()], infoOf);
  const out: MyClawAppStatsSessionRow[] = [];
  for (const [sessionId, held] of folded) {
    const named = labels.get(sessionId);
    if (named === undefined) continue;
    out.push({ sessionId, ...named, delegated: held.delegated, firstAt: held.firstAt, lastAt: held.lastAt, ...held.totals });
  }
  return out.sort(bySpend);
}

/**
 * What OpenRouter says each key spent, beside what we recorded for it.
 *
 * One entry per API key, because OpenRouter is the only configured provider that publishes a
 * ledger and a ledger belongs to a key: two OpenRouter accounts are two entries, each set against
 * the calls its own providers made. None at all when no key is configured: a single number wearing
 * the label of a comparison is worse than no comparison.
 *
 * Calls recorded before they named their provider (`provider_key` NULL) are counted only when
 * there is one ledger to give them to; with two, they cannot be split, and stay under `(unknown)`.
 *
 * The provider's half is read from a cache and never waited on. A page may not hang on a third
 * party nor fail with it, so a cold cache and an unreachable API both leave the entry standing
 * with the recorded sum alone; the refresh started here answers the next request.
 */
function reconciliationRows(config: MyClawConfig, rows: Array<Priced<UsageGroup>>, labelOf: ProviderLabel): MyClawAppStatsReconciliation[] {
  const ledgers = openRouterLedgers(config.llm.providers);
  const onOpenRouter = rows.filter((row) => isOpenRouterBaseUrl(row.group.baseUrl));
  return ledgers.map(({ apiKey, providerKeys }) => {
    warmOpenRouterAccount(apiKey);
    const ours = onOpenRouter.filter((row) =>
      row.group.providerKey === null ? ledgers.length === 1 : providerKeys.includes(row.group.providerKey),
    );
    const recordedUsd = ours.reduce((sum, row) => sum + spend(row.totals), 0);
    const account = cachedOpenRouterAccount(apiKey);
    return {
      provider: "openrouter.ai",
      providerKeys,
      providerLabel: providerKeys.map((key) => labelOf(key)).join(" + "),
      recordedUsd,
      calls: ours.reduce((sum, row) => sum + row.totals.calls, 0),
      ...(account === undefined
        ? { providerUnread: true }
        : {
            providerUnread: false,
            providerUsd: account.usageUsd,
            deltaUsd: account.usageUsd - recordedUsd,
            ...(account.balanceUsd === undefined ? {} : { balanceUsd: account.balanceUsd }),
          }),
    };
  });
}

export async function statsReport(p: StatsParams): Promise<MyClawAppStatsPayload> {
  const filter: MyClawAppStatsFilter = p.filter ?? {};
  const labelOf = providerLabels(p.config);
  const models = price(usageByModel(p.period, filter), p.pricing);
  const totals = emptyTotals();
  for (const row of models) add(totals, row.totals);

  const sessions = await sessionRows(price(usageBySession(p.period, filter), p.pricing), p.sessionInfo);
  const callers = callerRows(price(usageByCaller(p.period, filter), p.pricing));
  const horizon = usageHorizon();
  const facets = await facetsOf(p, filter, models, sessions, callers);

  return {
    period: p.period,
    filter,
    ...horizon,
    // A filter that cannot be asked of a monthly fold drops it (see filterReachesRollup), and the
    // flag goes false with it: the page's horizon note must not promise months this answer left out.
    rollupIncluded: reachesRollup(p.period) && filterReachesRollup(filter) && horizon.totalsSince !== undefined,
    totals,
    models: modelRows(models, labelOf),
    providerKeys: providerKeyRows(models, labelOf),
    providers: providerRows(models),
    sessions,
    daily: dayRows(price(usageByDay(p.period, filter), p.pricing)),
    reliability: reliabilityRows(models),
    cache: cacheOf(totals),
    callers,
    reconciliation: reconciliationRows(p.config, models, labelOf),
    facets,
    tools: toolsOf(p.period, filter),
  };
}

function toolsOf(period: MyClawAppStatsPeriod, filter: MyClawAppStatsFilter): MyClawAppStatsTools {
  const { sessionId, caller, ...rest } = filter;
  const filterApplied = !Object.values(rest).some((value) => value !== undefined && value !== false);
  const stats = toolStats(period, filterApplied ? { ...(sessionId ? { sessionId } : {}), ...(caller ? { caller } : {}) } : {});
  return { ...stats, filterApplied };
}

function sortedKeys(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function facetSession(row: MyClawAppStatsSessionRow): MyClawAppStatsFacetSession {
  return { sessionId: row.sessionId, label: row.label, labelSource: row.labelSource, deleted: row.deleted };
}

/**
 * The values the filter sheet offers, taken from a pass that ignores the filter on screen.
 *
 * With nothing narrowed they come from the rows the report is already made of, at no extra cost.
 * With something narrowed they come from `usageFacets`, four `DISTINCT`s over the window: an option
 * list that had shrunk to the one value already chosen would leave no way back to the others, and
 * that is the price of a filter that can be undone -- about a fifth of one unfiltered aggregate.
 */
async function facetsOf(
  p: StatsParams,
  filter: StatsFilter,
  models: Array<Priced<UsageGroup>>,
  sessions: MyClawAppStatsSessionRow[],
  callers: MyClawAppStatsCallerRow[],
): Promise<MyClawAppStatsFacets> {
  // The two new dimensions are never folded from the rows above: a UsageGroup carries no workspace
  // and no folder, and adding one to every aggregate would weigh down queries that never ask for
  // them. The two DISTINCTs are indexed and cost about a fifth of one aggregate (see the note on
  // `usageFacets`), and they are needed whatever the filter, so they are read unconditionally.
  const all = usageFacets(p.period);
  const folderLabel = new Map(p.folders.map((folder) => [folder.id, folder.name]));
  const folders: MyClawAppStatsFacetFolder[] = all.folderIds
    .map((folderId) => ({ folderId, label: folderId === NO_FOLDER ? NO_FOLDER : folderLabel.get(folderId) ?? "(deleted)" }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const labelOf = providerLabels(p.config);
  const withLabels = (keys: string[]) => ({ providers: keys, providerLabels: Object.fromEntries(keys.map((key) => [key, labelOf(key)])) });
  const scopes = { workspaces: all.workspaces, folders };
  if (!filterNarrows(filter)) {
    return {
      models: sortedKeys(models.map((row) => row.group.model)),
      // The rollup's groups carry no provider: they are not a value the filter can be set to.
      ...withLabels(sortedKeys(models.filter((row) => row.group.origin === "live").map((row) => row.group.providerKey ?? UNKNOWN_PROVIDER))),
      callers: sortedKeys(callers.map((row) => row.caller)),
      sessions: sessions.map(facetSession).sort((a, b) => a.label.localeCompare(b.label)),
      ...scopes,
    };
  }
  const labels = await labelsOf(all.sessionIds, p.sessionInfo);
  return {
    models: all.models,
    ...withLabels(all.providers),
    callers: all.callers,
    sessions: all.sessionIds.flatMap((sessionId) => {
      const named = labels.get(sessionId);
      return named === undefined ? [] : [{ sessionId, ...named }];
    }),
    ...scopes,
  };
}
