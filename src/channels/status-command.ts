import type { MyClawConfig } from "../core/config.ts";
import { resolveAgentLlm, tagNameOf } from "../core/config.ts";
import { chatModel } from "../llm/chat-model.ts";
import { leafModelId, resolveLlmConfig } from "../llm/resolver.ts";
import { promptSidePruned, pruneOldToolResults } from "../agent/context-pruning.ts";
import { resolveContextPruning } from "../core/config.ts";
import type { SessionData } from "../sessions/store.ts";
import { agentTypeOf } from "../sessions/store.ts";
import { sessionLogOf } from "../sessions/log-access.ts";
import { promptOf } from "../sessions/projection.ts";
import {
  getSessionModelUsage,
  getLastContextTokens,
  getSessionUsage,
  type SessionModelRow,
  type UsageSummary,
} from "../analytics/usage-db.ts";
import type { ModelPricing, CostBreakdown } from "../llm/pricing.ts";
import { estimateMessagesTokens } from "../llm/tokens.ts";

import { resolveAutoCompactThreshold, autoCompactEnabled } from "../core/config.ts";
import type { RunNode } from "../core/run-registry.ts";
import { resolveModelContextWindow, occupiedContextTokens, measurementFor } from "../llm/context-window.ts";
import { isSelfHosted } from "../llm/pricing.ts";
import type { ChatMessage } from "../llm/provider.ts";
import type { MyClawAppStatusPayload } from "./my-claw-app/types.ts";

/**
 * The engine a model resolves to, or undefined when the model is gone from the catalogue. Only
 * used to answer "does this prompt get pruned": a model whose provider vanished must not take a
 * read-only diagnostic down with it.
 */
function backendOf(config: MyClawConfig, modelId: string): string | undefined {
  try {
    return resolveLlmConfig(config.llm, modelId).backend;
  } catch {
    return undefined;
  }
}

/**
 * `/status` -- one screen, always the whole thing. See docs/status-command.md.
 *
 * The report is collected once into StatusData and rendered two ways: the text the chat channels
 * have always shown, and the structured payload the app draws as a fullscreen page. Both tell the
 * same story, so they share the collection step.
 */

export interface StatusParams {
  config: MyClawConfig;
  sessionId: string;
  session: SessionData | null | undefined;
  liveRuns: RunNode[];
  /** A /compact holds the session: work in progress with no run node of its own. */
  compacting?: boolean;
  pricing?: ModelPricing;
}

function short(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString("en-US");
}

function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function duration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;
}

interface PricedRow extends SessionModelRow {
  cost?: CostBreakdown;
}

function priceRows(rows: SessionModelRow[], pricing?: ModelPricing): PricedRow[] {
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
    }),
  }));
}

function totals(rows: PricedRow[]): { billed: number; reference: number; unpriced: number } {
  let billed = 0;
  let reference = 0;
  let unpriced = 0;
  for (const row of rows) {
    if (!row.cost) unpriced += 1;
    else if (row.cost.billed) billed += row.cost.usd;
    else reference += row.cost.usd;
  }
  return { billed, reference, unpriced };
}

interface StatusData {
  sessionId: string;
  session: SessionData | null;
  /** The model the API actually receives, resolved from the current identity at read time. */
  displayModel: string;
  /** Set when the current model is a `tag:` reference, naming the tag. */
  tag?: string;
  /** The configured default of the resolved agent, for the "config default" line. */
  configDefault?: string;
  live: string;
  contextLimit: number;
  contextNotes: string[];
  measured?: number;
  estimated: number;
  occupied: number;
  /** Turns in the log. `session.messages` used to stand in for this, and had been empty for weeks. */
  entryCount: number;
  autoCompactOn: boolean;
  autoCompactThresholdPct: number;
  autoCompactThresholdTokens: number;
  conversation: SessionData["tokenUsage"] | undefined;
  own: PricedRow[];
  ownCalls: number;
  ownErrors: number;
  ownTotals: { billed: number; reference: number; unpriced: number };
  rollup: UsageSummary | null;
  delegated: PricedRow[];
  verboseOff: boolean;
}

async function collectStatusData(p: StatusParams): Promise<StatusData> {
  const configured = resolveAgentLlm(p.config, "main");
  // The same chain the run uses, rather than a copy of it that happens to agree today.
  const currentModel = chatModel(p.config, p.session?.modelOverride) || "unknown";
  const tagName = tagNameOf(currentModel);
  const displayModel = leafModelId(p.config.llm, currentModel);
  const running = p.liveRuns.map((r) => (r.depth === 0 ? "main" : `${r.label}[${r.depth}]`));
  if (p.compacting) running.push("compaction");
  const live = running.length > 0 ? running.join(", ") : "none";
  const contextAgent = p.session ? agentTypeOf(p.session) : "main";
  const window = resolveModelContextWindow(p.config, currentModel, p.session?.contextOverride, contextAgent);
  // Every clause here is a reason the number can look wrong, so each one that applies is named.
  const contextNotes = [window.rawSource === "default" ? "default, not declared for this model" : window.rawSource];
  if (window.approximate) contextNotes.push("matched id");
  if (window.cappedFrom) contextNotes.push(`capped from ${window.cappedFrom.toLocaleString("en-US")}`);
  if (window.overridden) contextNotes.push("session override: full");

  // Two numbers, deliberately side by side: the measured one is exact, the estimate is what
  // actually decides when compaction fires. A wide gap means the trigger is mis-tuned.
  // The session's own figure first: it is the one the compaction gate uses, so showing anything
  // else here would let the two lines below contradict each other. Analytics is the fallback for
  // sessions that predate the field, but only while there is a history for it to describe: on an
  // empty one the last recorded call is not in this context any more, and reporting it as a share
  // of the window would be a straight falsehood.
  //
  // The estimate goes through the same helper the gate uses, and for the same reason: the loop
  // prunes old tool results out of the prompt before every call, so measuring the unpruned history
  // counts tokens that are never sent. That gap read 8.7x here and fired thirty compactions on a
  // session at nine percent of its window. Two numbers for one thing must not disagree.
  const backend = backendOf(p.config, currentModel);
  const pruning = promptSidePruned(p.config, backend);
  const pruningOpts = resolveContextPruning(p.config);
  const toChat = (msgs: readonly ChatMessage[]): ChatMessage[] => pruning ? pruneOldToolResults([...msgs], pruningOpts) : [...msgs];

  // Read prompt from the log (the source of truth), not session.messages
  let prompt: ChatMessage[] = [];
  let promptLength = 0;
  let entryCount = 0;
  if (p.session) {
    const log = await sessionLogOf(p.session.id);
    entryCount = log.entries().length;
    prompt = promptOf(log.entries(), log.leaf());
    promptLength = prompt.length;
  }
  const measured = p.session
    ? measurementFor(p.session.lastPrompt, pruning)?.tokens ?? (promptLength > 0 ? getLastContextTokens(p.sessionId)?.promptTokens : undefined)
    : undefined;
  const estimated = p.session ? estimateMessagesTokens(toChat(prompt)) : 0;
  // `measurementFor`: a size billed on the other prompt shape is not a floor for this one.
  const occupied = p.session
    ? occupiedContextTokens(
        prompt,
        toChat,
        measurementFor(p.session.lastPrompt, pruning),
        p.session.lastFixedTokens ?? 0,
      )
    : 0;
  const autoCompactOn = autoCompactEnabled(p.config);
  const threshold = resolveAutoCompactThreshold(p.config);
  const own = p.session ? priceRows(getSessionModelUsage(p.sessionId, "own"), p.pricing) : [];
  const delegated = p.session ? priceRows(getSessionModelUsage(p.sessionId, "delegated"), p.pricing) : [];

  return {
    sessionId: p.sessionId,
    session: p.session ?? null,
    entryCount,
    displayModel,
    ...(tagName ? { tag: tagName } : {}),
    ...(p.session?.modelOverride
      ? { configDefault: leafModelId(p.config.llm, configured?.defaultModel ?? p.config.llm.defaultModel ?? "") }
      : {}),
    live,
    contextLimit: window.effective,
    contextNotes,
    ...(measured ? { measured } : {}),
    estimated,
    occupied,
    autoCompactOn,
    autoCompactThresholdPct: Math.round(threshold * 100),
    autoCompactThresholdTokens: autoCompactOn ? Math.round(window.effective * threshold) : 0,
    conversation: p.session?.tokenUsage,
    own,
    ownCalls: own.reduce((s, r) => s + r.calls, 0),
    ownErrors: own.reduce((s, r) => s + r.errorCount, 0),
    ownTotals: own.length > 0 ? totals(own) : { billed: 0, reference: 0, unpriced: 0 },
    rollup: own.length > 0 ? getSessionUsage(p.sessionId) : null,
    delegated,
    verboseOff: p.session?.verbose === false,
  };
}

function formatStatusText(d: StatusData): string {
  if (!d.session) {
    return [`Model: ${d.displayModel}${d.tag ? ` (tag ${d.tag})` : ""}`, "Session: none active", `Active run: ${d.live}`].join("\n");
  }
  const session = d.session;
  const lines: string[] = [];

  lines.push("**Session**");
  lines.push(`  id            \`${d.sessionId}\``);
  lines.push(`  platform      ${session.platform} - ${session.chatType}`);
  lines.push(`  created       ${session.createdAt.slice(0, 16).replace("T", " ")} (${ago(session.createdAt)})`);
  lines.push(`  last active   ${session.lastActiveAt.slice(0, 16).replace("T", " ")} (${ago(session.lastActiveAt)})`);
  lines.push(`  entries       ${d.entryCount}`);
  if (session.meta) {
    lines.push(`  sub-agent     ${session.meta.displayName} (${session.meta.type}, ${session.meta.visibility})`);
    lines.push(`  spawned by    \`${session.meta.parentSessionId}\``);
  }

  lines.push("");
  lines.push("**Model**");
  lines.push(`  current       ${d.displayModel}${d.tag ? ` (tag ${d.tag})` : ""}${session.modelOverride ? " (session override)" : ""}`);
  if (session.modelOverride) lines.push(`  config default ${d.configDefault ?? "-"}`);
  if (session.effortOverride) lines.push(`  effort        ${session.effortOverride}`);
  if (isSelfHosted(d.displayModel)) lines.push("  billing       self-hosted, no marginal cost");
  lines.push(`  context limit ${short(d.contextLimit)} (${d.contextNotes.join(", ")})`);

  const limit = d.contextLimit;
  lines.push("");
  lines.push("**Context**");
  if (d.measured) {
    lines.push(`  measured      ${short(d.measured)} on the last call - ${((d.measured / limit) * 100).toFixed(1)}% of the limit`);
  } else {
    lines.push("  measured      no call recorded yet");
  }
  lines.push(`  estimated     ${short(d.estimated)} (chars/4, under-counts)`);
  lines.push(`  occupied      ${short(d.occupied)} (measured prompt plus the turns since, drives auto-compaction)`);
  if (d.autoCompactOn) {
    lines.push(`  auto-compact  on, threshold ${d.autoCompactThresholdPct}% = ${short(d.autoCompactThresholdTokens)}`);
  } else {
    lines.push("  auto-compact  off");
  }

  // Same id, two very different numbers: the session counter covers this conversation while
  // analytics keeps accumulating under the room-derived id. Both are correct, so both are labelled.
  const u = session.tokenUsage;
  lines.push("");
  lines.push("**This conversation**");
  if (u) {
    const cached = u.cacheReadTokens ? ` - cached ${short(u.cacheReadTokens)}` : "";
    lines.push(`  ${u.apiCalls} calls - in ${short(u.promptTokens)}${cached} - out ${short(u.completionTokens)}`);
  } else {
    lines.push("  no calls yet");
  }

  if (d.own.length > 0) {
    const t = d.ownTotals;
    lines.push("");
    lines.push("**This session, 90 d** (analytics)");
    lines.push(`  ${d.ownCalls} calls - ${d.ownErrors} errors${d.rollup ? ` - ${duration(d.rollup.totalDurationMs)} of API time` : ""}`);
    if (t.billed > 0) lines.push(`  billed        ${money(t.billed)}`);
    if (t.reference > 0) lines.push(`  reference    *${money(t.reference)}   flat plans, subscriptions, self-hosted`);
    lines.push("```");
    for (const row of d.own) {
      lines.push(formatModelRow(row));
    }
    lines.push("```");
    lines.push("  `*` not a charge   `~` price of a matched model id");
    if (t.unpriced > 0) lines.push(`  ${t.unpriced} model(s) unpriced`);
  }

  if (d.delegated.length > 0) {
    const t = totals(d.delegated);
    const calls = d.delegated.reduce((s, r) => s + r.calls, 0);
    const tokens = d.delegated.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0);
    lines.push("");
    lines.push("**Delegated by this session** (sub-agents, browser)");
    lines.push(`  ${calls} calls - ${short(tokens)} tokens - billed ${money(t.billed)}${t.reference > 0 ? ` - reference *${money(t.reference)}` : ""}`);
  }

  lines.push("");
  lines.push("**Runtime**");
  lines.push(`  active run    ${d.live}`);
  lines.push(`  verbose       ${d.verboseOff ? "off" : "on"}`);
  if (session.approvedTools?.length) lines.push(`  approved      ${session.approvedTools.join(", ")}`);

  return lines.join("\n");
}

function statusPayload(d: StatusData): MyClawAppStatusPayload {
  const session = d.session;
  const limit = d.contextLimit;
  return {
    session: session
      ? {
          id: d.sessionId,
          platform: session.platform,
          chatType: session.chatType,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          messages: d.entryCount,
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
      current: d.displayModel,
      ...(d.tag ? { tag: d.tag } : {}),
      ...(session?.modelOverride ? { configDefault: d.configDefault } : {}),
      ...(session?.effortOverride ? { effort: session.effortOverride } : {}),
      selfHosted: isSelfHosted(d.displayModel),
      contextLimit: limit,
      contextNotes: d.contextNotes,
    },
    context: {
      ...(d.measured ? { measured: { tokens: d.measured, pctOfLimit: (d.measured / limit) * 100 } } : {}),
      estimated: d.estimated,
      occupied: d.occupied,
      autoCompactOn: d.autoCompactOn,
      autoCompactThresholdPct: d.autoCompactThresholdPct,
      autoCompactThresholdTokens: d.autoCompactThresholdTokens,
    },
    conversation: session?.tokenUsage
      ? {
          calls: session.tokenUsage.apiCalls,
          promptTokens: session.tokenUsage.promptTokens,
          cacheReadTokens: session.tokenUsage.cacheReadTokens ?? 0,
          completionTokens: session.tokenUsage.completionTokens,
        }
      : null,
    analytics: d.own.length > 0
      ? {
          calls: d.ownCalls,
          errors: d.ownErrors,
          ...(d.rollup ? { durationMs: d.rollup.totalDurationMs } : {}),
          billedUsd: d.ownTotals.billed,
          referenceUsd: d.ownTotals.reference,
          unpriced: d.ownTotals.unpriced,
          rows: d.own.map((row) => ({
            model: row.model,
            calls: row.calls,
            promptTokens: row.promptTokens,
            cacheReadTokens: row.cacheReadTokens,
            completionTokens: row.completionTokens,
            ...(row.cost
              ? { costUsd: row.cost.usd, costBilled: row.cost.billed, costApproximate: row.cost.approximate }
              : { costBilled: false, costApproximate: false }),
          })),
        }
      : null,
    delegated: d.delegated.length > 0
      ? {
          calls: d.delegated.reduce((s, r) => s + r.calls, 0),
          tokens: d.delegated.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0),
          billedUsd: totals(d.delegated).billed,
          referenceUsd: totals(d.delegated).reference,
        }
      : null,
    runtime: {
      activeRun: d.live,
      verbose: !d.verboseOff,
      approvedTools: session?.approvedTools ?? [],
    },
  };
}

export async function handleStatusCommand(p: StatusParams): Promise<string> {
  return formatStatusText(await collectStatusData(p));
}

/**
 * The same report twice: the chat text and the structured payload the app page draws.
 * The field is named `status` and required on purpose -- this object IS the app channel's
 * command output, whose `status` is optional, so a rename here would otherwise be swallowed
 * by the optional field and only surface at runtime as "status unavailable".
 */
export async function statusReport(p: StatusParams): Promise<{ text: string; status: MyClawAppStatusPayload }> {
  const data = await collectStatusData(p);
  return { text: formatStatusText(data), status: statusPayload(data) };
}

function formatModelRow(row: PricedRow): string {
  const cost = row.cost ? `${row.cost.billed ? " " : "*"}${row.cost.approximate ? "~" : ""}${money(row.cost.usd)}` : "  -";
  const cached = row.cacheReadTokens > 0 ? short(row.cacheReadTokens) : "-";
  return [
    row.model.split("/").pop()!.slice(0, 24).padEnd(24),
    String(row.calls).padStart(5),
    short(row.promptTokens).padStart(8),
    cached.padStart(8),
    short(row.completionTokens).padStart(8),
    cost.padStart(9),
  ].join(" ");
}
