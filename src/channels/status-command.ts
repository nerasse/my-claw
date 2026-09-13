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
  getDelegatedModelUsage,
  getSessionModelUsage,
  getLastContextTokens,
  getSessionUsage,
  RETENTION_DAYS,
  type SessionModelRow,
} from "../analytics/usage-db.ts";
import type { ModelPricing, CostBreakdown } from "../llm/pricing.ts";
import { estimateMessagesTokens } from "../llm/tokens.ts";
import { resolveAutoCompactThreshold, autoCompactEnabled } from "../core/config.ts";
import type { RunNode } from "../core/run-registry.ts";
import { resolveModelContextWindow, occupiedContextTokens } from "../llm/context-window.ts";
import { isSelfHosted } from "../llm/pricing.ts";
import type { ChatMessage } from "../llm/provider.ts";
import { routeOf } from "./usage-route.ts";
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

function modelRow(row: PricedRow): MyClawAppUsageModelRow {
  return {
    model: row.model,
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
 */
async function delegatedAgents(p: StatusParams): Promise<MyClawAppUsageAgent[]> {
  const agents: MyClawAppUsageAgent[] = [];
  const seen = new Set<string>([p.sessionId]);
  const walk = async (parent: string, depth: number): Promise<void> => {
    if (depth > MAX_DELEGATION_DEPTH) return;
    const bySession = new Map<string, PricedRow[]>();
    for (const row of priceRows(getDelegatedModelUsage(parent), p.pricing)) {
      const rows = bySession.get(row.sessionId);
      if (rows) rows.push(row);
      else bySession.set(row.sessionId, [row]);
    }
    for (const [sessionId, rows] of bySession) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      const meta = (await p.subAgentOf?.(sessionId)) ?? null;
      const displayName = meta?.displayName ?? sessionId.slice(sessionId.lastIndexOf("/") + 1);
      agents.push({
        sessionId,
        displayName,
        ...(meta ? { type: meta.type } : {}),
        depth,
        alive: meta !== null,
        running: meta !== null && p.liveRuns.some((r) => r.depth > 0 && r.label === meta.displayName),
        ...totalsOf(rows),
        rows: rows.map(modelRow),
      });
      await walk(sessionId, depth + 1);
    }
  };
  await walk(p.sessionId, 1);
  return agents;
}

async function collectStatus(p: StatusParams): Promise<MyClawAppStatusPayload> {
  const configured = resolveAgentLlm(p.config, "main");
  // The same chain the run uses, rather than a copy of it that happens to agree today.
  const currentModel = chatModel(p.config, p.session?.modelOverride) || "unknown";
  const tagName = tagNameOf(currentModel);
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
  // cannot be drawn: "high" pinned here and "high" inherited are the same string.
  const effort = effectiveEffort(p.config.llm, displayModel, p.session?.effortOverride, configured?.effort);
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
    turns = log.entries().length;
    prompt = promptOf(log.entries(), log.leaf());
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
    const horizon = Date.now() - RETENTION_DAYS * 86_400_000;
    const createdAt = p.session ? Date.parse(p.session.createdAt) : NaN;
    usage = {
      total,
      own: {
        ...ownTotals,
        durationMs: own.length > 0 ? getSessionUsage(p.sessionId)?.totalDurationMs ?? 0 : 0,
        rows: own.map(modelRow),
      },
      agents,
      ...(Number.isFinite(createdAt) && createdAt < horizon ? { since: new Date(horizon).toISOString() } : {}),
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
      runs: p.liveRuns.map((r) => ({ label: r.label, depth: r.depth, startedAt: new Date(r.startedAt).toISOString() })),
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
    if (status.usage) parts.push(`${status.usage.total.calls} calls`, money(status.usage.total.billedUsd + status.usage.total.referenceUsd));
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
