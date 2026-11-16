import type { AgentLlmConfig, MyClawConfig } from "../core/config.ts";
import { resolveAgentLlm, tagNameOf } from "../core/config.ts";
import { chatModel } from "../llm/chat-model.ts";
import { leafModelId, resolveAgentLlmConfig, effectiveEffort } from "../llm/resolver.ts";
import { tryResolveRunModel } from "../llm/run-model.ts";
import { availabilityWorld } from "../llm/world.ts";
import { describeTimeout, transportTimeoutDefault } from "../llm/request-timeout.ts";
import type { SessionData, SubAgentMeta } from "../sessions/store.ts";
import { agentTypeOf } from "../sessions/store.ts";
import { sessionLogOf } from "../sessions/log-access.ts";
import { promptOf } from "../sessions/projection.ts";
import {
  getSessionModelUsage,
  getLastContextTokens,
  getSessionUsage,
  getTreeModelUsage,
  usageHorizon,
  type SessionModelRow,
} from "../analytics/usage-db.ts";
import type { ModelPricing, CostBreakdown } from "../llm/pricing.ts";
import { estimateMessagesTokens } from "../llm/tokens.ts";
import { resolveAutoCompactThreshold, autoCompactEnabled } from "../core/config.ts";
import type { RunNode } from "../core/run-registry.ts";
import { resolveModelContextWindow, occupiedContextTokens } from "../llm/context-window.ts";
import { isSelfHosted } from "../llm/pricing.ts";
import type { ChatMessage } from "../llm/provider.ts";
import { providerLabels, routeOf, type ProviderLabel } from "./usage-route.ts";
import { UNKNOWN_PROVIDER } from "../analytics/usage-stats.ts";
import type {
  MyClawAppStatusPayload,
  MyClawAppUsageAgent,
  MyClawAppUsageModelRow,
  MyClawAppUsageTotals,
} from "./my-claw-app/types.ts";

/**
 * `/status` -- what this conversation is doing right now and what it has cost, as one structured
 * report the app draws as a page. See docs/status-command.md.
 */

export interface StatusParams {
  config: MyClawConfig;
  sessionId: string;
  session: SessionData | null | undefined;
  liveRuns: RunNode[];
  /** A /compact holds the session: work in progress with no run node of its own. */
  compacting?: boolean;
  pricing?: ModelPricing;
  /**
   * The sub-agent sessions this conversation drove, read for their names and types. Absent, the
   * agents are reported by id alone.
   */
  subAgentOf?: (sessionId: string) => Promise<SubAgentMeta | null>;
}

/** How deep the delegation tree is walked: a sub-agent's sub-agent, and one level of slack. */
const MAX_DELEGATION_DEPTH = 3;

interface PricedRow extends SessionModelRow {
  cost?: CostBreakdown;
}

function priceRows<R extends SessionModelRow>(rows: R[], pricing?: ModelPricing): Array<R & PricedRow> {
  return rows.map((row) => ({
    ...row,
    cost: pricing?.costOf({
      model: row.model,
      baseUrl: row.baseUrl,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      upstreamApiBase: row.upstreamApiBase ?? undefined,
      proxyCostUsd: row.proxyCostUsd ?? undefined,
      ...(row.pinnedCost === undefined ? {} : { pinned: row.pinnedCost }),
    }),
  }));
}

function totalsOf(rows: PricedRow[]): MyClawAppUsageTotals {
  const t: MyClawAppUsageTotals = {
    calls: 0,
    errors: 0,
    promptTokens: 0,
    cacheReadTokens: 0,
    completionTokens: 0,
    billedUsd: 0,
    referenceUsd: 0,
    unpriced: 0,
  };
  for (const row of rows) {
    t.calls += row.calls;
    t.errors += row.errorCount;
    t.promptTokens += row.promptTokens;
    t.cacheReadTokens += row.cacheReadTokens;
    t.completionTokens += row.completionTokens;
    if (!row.cost) t.unpriced += 1;
    else if (row.cost.billed) t.billedUsd += row.cost.usd;
    else t.referenceUsd += row.cost.usd;
  }
  return t;
}

function addTotals(into: MyClawAppUsageTotals, more: MyClawAppUsageTotals): void {
  into.calls += more.calls;
  into.errors += more.errors;
  into.promptTokens += more.promptTokens;
  into.cacheReadTokens += more.cacheReadTokens;
  into.completionTokens += more.completionTokens;
  into.billedUsd += more.billedUsd;
  into.referenceUsd += more.referenceUsd;
  into.unpriced += more.unpriced;
}

function modelRow(row: PricedRow, labelOf: ProviderLabel): MyClawAppUsageModelRow {
  return {
    model: row.model,
    providerKey: row.providerKey ?? UNKNOWN_PROVIDER,
    providerLabel: labelOf(row.providerKey),
    ...routeOf(row.model, row.baseUrl),
    calls: row.calls,
    errors: row.errorCount,
    promptTokens: row.promptTokens,
    cacheReadTokens: row.cacheReadTokens,
    completionTokens: row.completionTokens,
    ...(row.cost
      ? { costUsd: row.cost.usd, costBilled: row.cost.billed, costApproximate: row.cost.approximate, costSource: row.cost.source }
      : { costBilled: false, costApproximate: false }),
  };
}

/**
 * The wall one request runs under, spelled for the report. Resolved through the same chain as a
 * run, because the transport default depends on the backend the model lands on and only the
 * resolver knows which one that is.
 *
 * A broken declaration (unknown provider, tag cycle) makes the resolver throw, and `/status` is
 * the screen the owner opens *because* something is broken: the line degrades to "unknown"
 * instead of taking the whole report down with it.
 */
function describeRequestTimeout(
  config: MyClawConfig,
  agentLlm: AgentLlmConfig | undefined,
  modelOverride: string | undefined,
): string {
  try {
    const resolved = resolveAgentLlmConfig(agentLlm, config.llm, modelOverride);
    return describeTimeout(resolved, transportTimeoutDefault(resolved.backend));
  } catch {
    return "unknown (model does not resolve)";
  }
}

/**
 * The sub-agents this conversation drove, depth-first, each with what it spent on the
 * conversation's behalf. A sub-agent's own sub-agents are billed to it, so the walk continues
 * under each one: the total the page leads with has to cover the grandchildren too, or a research
 * agent that spawned a coder would report a fraction of what the conversation caused.
 *
 * One recursive query answers the whole tree (`getTreeModelUsage`); this used to ask the ledger
 * once per node, which on a conversation with 190 sub-agents meant 190 statements per report, and
 * the status page is rebuilt on every change while it is open.
 */
async function delegatedAgents(p: StatusParams): Promise<MyClawAppUsageAgent[]> {
  const priced = priceRows(getTreeModelUsage(p.sessionId), p.pricing);
  if (priced.length === 0) return [];

  const bySession = new Map<string, PricedRow[]>();
  const parentOf = new Map<string, string | null>();
  for (const row of priced) {
    const rows = bySession.get(row.sessionId);
    if (rows) rows.push(row);
    else bySession.set(row.sessionId, [row]);
    const parent = row.parentSessionId ?? null;
    if (!parentOf.has(row.sessionId) && parent !== null) parentOf.set(row.sessionId, parent);
  }

  // Depth is the length of the chain back to the conversation. The query has no depth limit of its
  // own (the cron report wants the whole tree), so the one the page draws is applied here.
  const depthOf = (sessionId: string): number => {
    let depth = 1;
    let at = parentOf.get(sessionId) ?? null;
    const guard = new Set<string>([sessionId]);
    while (at !== null && at !== p.sessionId && depth <= MAX_DELEGATION_DEPTH) {
      if (guard.has(at)) return Number.POSITIVE_INFINITY;
      guard.add(at);
      depth++;
      at = parentOf.get(at) ?? null;
    }
    return depth;
  };

  const drawn = [...bySession].flatMap(([sessionId, rows]) => {
    const depth = depthOf(sessionId);
    return depth > MAX_DELEGATION_DEPTH ? [] : [{ sessionId, rows, depth }];
  });
  // Depth first, newest first inside a level: the order the per-level walk produced, which is how
  // the page has always listed them.
  drawn.sort((a, b) => a.depth - b.depth || (b.rows[0]!.lastUsedAt > a.rows[0]!.lastUsedAt ? 1 : -1));

  const labelOf = providerLabels(p.config);
  const metas = await Promise.all(drawn.map(({ sessionId }) => p.subAgentOf?.(sessionId) ?? Promise.resolve(null)));
  return drawn.map(({ sessionId, rows, depth }, index) => {
    const meta = metas[index] ?? null;
    const displayName = meta?.displayName ?? sessionId.slice(sessionId.lastIndexOf("/") + 1);
    return {
      sessionId,
      displayName,
      ...(meta ? { type: meta.type } : {}),
      depth,
      alive: meta !== null,
      running: meta !== null && p.liveRuns.some((r) => r.depth > 0 && r.label === meta.displayName),
      ...totalsOf(rows),
      rows: rows.map((row) => modelRow(row, labelOf)),
    };
  });
}

async function collectStatus(p: StatusParams): Promise<MyClawAppStatusPayload> {
  const configured = resolveAgentLlm(p.config, "main");
  // The same chain the run uses, rather than a copy of it that happens to agree today.
  const currentModel = chatModel(p.config, p.session?.modelOverride) || "unknown";
  const tagName = tagNameOf(currentModel);
  // The tag's identity answers two questions the leaf cannot: which tag was picked, and -- through
  // `effectiveEffort` -- which rung it pins. `chatModel` already reports the reference (the tag)
  // while `displayModel` names the model the API receives, and the two are only the same for a
  // plain pick. Reading effort off the leaf reported the global `max` on a conversation whose tag
  // pins `xhigh` on Opus: the tag's own rung is only reachable from the tag (2026-11-14).
  const displayModel = leafModelId(p.config.llm, currentModel);
  // Which of the three picks it, from the resolver itself: reading `override ?? default` here is
  // how a screen came to name the global default while every run went to the agent's own pin
  // (docs/model-resolution.md).
  const run = tryResolveRunModel(
    p.config,
    { agent: "main", ...(p.session?.modelOverride ? { sessionModel: p.session.modelOverride } : {}) },
    availabilityWorld(),
  );
  // Session > tag > agent > global > what the API or the provider does on its own. The level alone
  // cannot be drawn: "high" pinned here and "high" inherited are the same string. Asked of the
  // reference, not of the leaf: a tag carries its own rung and only its own name reaches it.
  const effort = effectiveEffort(p.config.llm, currentModel, p.session?.effortOverride, configured?.effort);
  const contextAgent = p.session ? agentTypeOf(p.session) : "main";
  const window = resolveModelContextWindow(p.config, currentModel, p.session?.contextOverride, contextAgent);
  // Every clause here is a reason the number can look wrong, so each one that applies is named.
  const contextNotes = [window.rawSource === "default" ? "default, not declared for this model" : window.rawSource];
  if (window.approximate) contextNotes.push("matched id");
  if (window.cappedFrom) contextNotes.push(`capped from ${window.cappedFrom.toLocaleString("en-US")}`);
  if (window.overridden) contextNotes.push("session override: full");

  let prompt: ChatMessage[] = [];
  let turns = 0;
  if (p.session) {
    const log = await sessionLogOf(p.session.id);
    turns = log.count();
    prompt = promptOf(await log.context(), log.leaf());
  }
  const measured = p.session
    ? p.session.lastPrompt?.tokens ?? (prompt.length > 0 ? getLastContextTokens(p.sessionId)?.promptTokens : undefined)
    : undefined;
  const estimated = p.session ? estimateMessagesTokens(prompt) : 0;
  const occupied = p.session
    ? occupiedContextTokens(prompt, (msgs) => [...msgs], p.session.lastPrompt, p.session.lastFixedTokens ?? 0)
    : 0;
  const autoCompactOn = autoCompactEnabled(p.config);
  const threshold = resolveAutoCompactThreshold(p.config);
  const limit = window.effective;

  const own = p.session ? priceRows(getSessionModelUsage(p.sessionId, "own"), p.pricing) : [];
  const agents = p.session ? await delegatedAgents(p) : [];
  let usage: MyClawAppStatusPayload["usage"] = null;
  if (own.length > 0 || agents.length > 0) {
    const ownTotals = totalsOf(own);
    const total = { ...ownTotals };
    for (const agent of agents) addTotals(total, agent);
    // The rows the analytics still hold, which is what this report can answer for. Nothing sweeps
    // them any more, so this is the first recorded call, not a retention wall (docs/stats-page.md).
    const detailSince = usageHorizon().detailSince;
    const createdAt = p.session ? Date.parse(p.session.createdAt) : NaN;
    usage = {
      total,
      own: {
        ...ownTotals,
        durationMs: own.length > 0 ? getSessionUsage(p.sessionId)?.totalDurationMs ?? 0 : 0,
        rows: own.map((row) => modelRow(row, providerLabels(p.config))),
      },
      agents,
      ...(Number.isFinite(createdAt) && detailSince !== undefined && Date.parse(detailSince) > createdAt ? { since: detailSince } : {}),
    };
  }

  const session = p.session ?? null;
  return {
    session: session
      ? {
          id: p.sessionId,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          turns,
          ...(session.meta
            ? {
                subAgent: {
                  displayName: session.meta.displayName,
                  type: session.meta.type,
                  visibility: session.meta.visibility,
                  parentSessionId: session.meta.parentSessionId,
                },
              }
            : {}),
        }
      : null,
    model: {
      current: displayModel,
      ...(tagName ? { tag: tagName } : {}),
      ...(run ? { source: run.source } : {}),
      defaultModel: leafModelId(p.config.llm, configured?.defaultModel ?? p.config.llm.defaultModel ?? ""),
      effort: effort.source === "unsupported" ? "" : effort.level ?? "",
      effortSource: effort.source,
      selfHosted: isSelfHosted(displayModel),
      contextLimit: limit,
      contextNotes,
      timeout: describeRequestTimeout(p.config, configured, session?.modelOverride),
    },
    context: {
      ...(measured ? { measured: { tokens: measured, pctOfLimit: (measured / limit) * 100 } } : {}),
      estimated,
      occupied,
      autoCompactOn,
      autoCompactThresholdPct: Math.round(threshold * 100),
      autoCompactThresholdTokens: autoCompactOn ? Math.round(limit * threshold) : 0,
    },
    usage,
    runtime: {
      runs: p.liveRuns.map((r) => ({
        label: r.label,
        depth: r.depth,
        startedAt: new Date(r.startedAt).toISOString(),
        ...(r.model ? { model: r.model } : {}),
        // The rung that node is asked for. A route's candidates each carry their own, so the
        // conversation's effort is not the running one's, and a row that named one level while the
        // request carried another is exactly the mismatch this field removes.
        ...(r.effort ? { effort: r.effort } : {}),
      })),
      compacting: p.compacting === true,
      verbose: session?.verbose !== false,
      approvedTools: session?.approvedTools ?? [],
    },
  };
}

function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/**
 * The one line a chat surface shows for a `/status` the page has already drawn: the command
 * result carries text by contract, and the page carries the report.
 */
function statusLine(status: MyClawAppStatusPayload): string {
  const parts = [`Status: ${status.model.current}${status.model.tag ? ` (tag ${status.model.tag})` : ""}`];
  if (status.session) {
    const pct = status.model.contextLimit > 0 ? ((status.context.occupied / status.model.contextLimit) * 100).toFixed(1) : "0.0";
    parts.push(`context ${pct}%`);
    if (status.usage) {
      parts.push(`${status.usage.total.calls} calls`, money(status.usage.total.billedUsd + status.usage.total.referenceUsd));
      const total = status.usage.total;
      if (total.promptTokens > 0) parts.push(`cache ${((total.cacheReadTokens / total.promptTokens) * 100).toFixed(1)}%`);
    }
  } else {
    parts.push("no session yet");
  }
  if (status.runtime.runs.length > 0) parts.push(`running: ${status.runtime.runs.map((r) => r.label).join(", ")}`);
  if (status.runtime.compacting) parts.push("compacting");
  return parts.join(" · ");
}

/**
 * The report as the app channel's command output. The field is named `status` and required on
 * purpose -- this object IS the channel's command output, whose `status` is optional, so a rename
 * here would otherwise be swallowed by the optional field and only surface at runtime as "status
 * unavailable".
 */
export async function statusReport(p: StatusParams): Promise<{ text: string; status: MyClawAppStatusPayload }> {
  const status = await collectStatus(p);
  return { text: statusLine(status), status };
}
