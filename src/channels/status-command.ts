import type { MyClawConfig } from "../core/config.ts";
import { resolveAgentLlm } from "../core/config.ts";
import type { SessionData, SessionMessage } from "../sessions/store.ts";
import { getSessionModelUsage, getLastContextTokens, getSessionUsage, type SessionModelRow } from "../analytics/usage-db.ts";
import type { ModelPricing, CostBreakdown } from "../llm/pricing.ts";
import { estimateMessagesTokens } from "../llm/tokens.ts";

import { resolveAutoCompactThreshold, autoCompactEnabled } from "../core/config.ts";
import type { RunNode } from "../core/run-registry.ts";
import { resolveContextWindow, occupiedContextTokens } from "../llm/context-window.ts";
import { isSelfHosted } from "../llm/pricing.ts";
import type { ChatMessage } from "../llm/provider.ts";

/**
 * `/status` -- one screen, always the whole thing. See docs/status-command.md.
 *
 * Shared by both channels because the two bodies were byte-identical copies, and this one is three
 * times the size.
 */

export interface StatusParams {
  config: MyClawConfig;
  sessionId: string;
  session: SessionData | null | undefined;
  liveRuns: RunNode[];
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

export function handleStatusCommand(p: StatusParams): string {
  const lines: string[] = [];
  const configured = resolveAgentLlm(p.config, "main");
  const currentModel = p.session?.modelOverride ?? configured?.defaultModel ?? p.config.llm.defaultModel ?? p.config.llm.model ?? "unknown";
  const live = p.liveRuns.length > 0 ? p.liveRuns.map((r) => (r.depth === 0 ? "main" : `${r.label}[${r.depth}]`)).join(", ") : "none";

  if (!p.session) {
    return [`Model: ${currentModel}`, "Session: none active", `Active run: ${live}`].join("\n");
  }
  const session = p.session;

  lines.push("**Session**");
  lines.push(`  id            \`${p.sessionId}\``);
  lines.push(`  platform      ${session.platform} - ${session.chatType}`);
  lines.push(`  created       ${session.createdAt.slice(0, 16).replace("T", " ")} (${ago(session.createdAt)})`);
  lines.push(`  last active   ${session.lastActiveAt.slice(0, 16).replace("T", " ")} (${ago(session.lastActiveAt)})`);
  lines.push(`  messages      ${session.messages.length}`);
  if (session.meta) {
    lines.push(`  sub-agent     ${session.meta.displayName} (${session.meta.type}, ${session.meta.visibility})`);
    lines.push(`  spawned by    \`${session.meta.parentSessionId}\``);
  }

  const model = p.config.llm.models?.find((m) => m.id === currentModel);
  const window = resolveContextWindow({
    model: currentModel,
    config: p.config,
    declared: model?.limit?.context,
    declaredSource: model?.contextFrom,
    sessionOverride: session.contextOverride,
  });
  lines.push("");
  lines.push("**Model**");
  lines.push(`  current       ${currentModel}${session.modelOverride ? " (session override)" : ""}`);
  if (session.modelOverride) lines.push(`  config default ${configured?.defaultModel ?? p.config.llm.defaultModel ?? "-"}`);
  if (session.effortOverride) lines.push(`  effort        ${session.effortOverride}`);
  if (isSelfHosted(currentModel)) lines.push("  billing       self-hosted, no marginal cost");
  // Every clause here is a reason the number can look wrong, so each one that applies is named.
  const notes = [window.rawSource === "default" ? "default, not declared for this model" : window.rawSource];
  if (window.approximate) notes.push("matched id");
  if (window.cappedFrom) notes.push(`capped from ${window.cappedFrom.toLocaleString("en-US")}`);
  if (window.overridden) notes.push("session override: full");
  lines.push(`  context limit ${short(window.effective)} (${notes.join(", ")})`);

  // Two numbers, deliberately side by side: the measured one is exact, the estimate is what
  // actually decides when compaction fires. A wide gap means the trigger is mis-tuned.
  // The session's own figure first: it is the one the compaction gate uses, so showing anything
  // else here would let the two lines below contradict each other. Analytics is the fallback for
  // sessions that predate the field, but only while there is a history for it to describe: after a
  // /new the last recorded call is not in this context any more, and reporting it as a share of the
  // window would be a straight falsehood.
  const measured =
    session.lastPrompt?.tokens ?? (session.messages.length > 0 ? getLastContextTokens(p.sessionId)?.promptTokens : undefined);
  const toChat = (msgs: readonly SessionMessage[]): ChatMessage[] =>
    msgs.map((m) => (m.role === "tool" ? { role: "user" as const, content: m.content } : { role: m.role, content: m.content }));
  const estimated = estimateMessagesTokens(toChat(session.messages));
  const occupied = occupiedContextTokens(session.messages, toChat, session.lastPrompt);
  const limit = window.effective;
  lines.push("");
  lines.push("**Context**");
  if (measured) {
    lines.push(`  measured      ${short(measured)} on the last call - ${((measured / limit) * 100).toFixed(1)}% of the limit`);
  } else {
    lines.push("  measured      no call recorded yet");
  }
  lines.push(`  estimated     ${short(estimated)} (chars/4, under-counts)`);
  lines.push(`  occupied      ${short(occupied)} (measured prompt plus the turns since, drives auto-compaction)`);
  if (autoCompactEnabled(p.config)) {
    const threshold = resolveAutoCompactThreshold(p.config);
    lines.push(`  auto-compact  on, threshold ${Math.round(threshold * 100)}% = ${short(Math.round(limit * threshold))}`);
  } else {
    lines.push("  auto-compact  off");
  }
  if (session.contextTransfer) {
    const t = session.contextTransfer;
    lines.push(`  carried to ${t.model}: ${t.messages} messages (~${short(t.tokens)} tokens)${t.dropped > 0 ? `, ${t.dropped} oldest dropped` : ""}`);
  }

  // Same id, two very different numbers: /new resets the session counter while analytics keeps
  // accumulating under the room-derived id. Both are correct, so both are labelled.
  const u = session.tokenUsage;
  lines.push("");
  lines.push("**This conversation** (since /new)");
  if (u) {
    const cached = u.cacheReadTokens ? ` - cached ${short(u.cacheReadTokens)}` : "";
    lines.push(`  ${u.apiCalls} calls - in ${short(u.promptTokens)}${cached} - out ${short(u.completionTokens)}`);
  } else {
    lines.push("  no calls yet");
  }

  const own = priceRows(getSessionModelUsage(p.sessionId, "own"), p.pricing);
  if (own.length > 0) {
    const t = totals(own);
    const calls = own.reduce((s, r) => s + r.calls, 0);
    const errors = own.reduce((s, r) => s + r.errorCount, 0);
    const rollup = getSessionUsage(p.sessionId);
    lines.push("");
    lines.push("**This session, 90 d** (analytics)");
    lines.push(`  ${calls} calls - ${errors} errors${rollup ? ` - ${duration(rollup.totalDurationMs)} of API time` : ""}`);
    if (t.billed > 0) lines.push(`  billed        ${money(t.billed)}`);
    if (t.reference > 0) lines.push(`  reference    *${money(t.reference)}   flat plans, subscriptions, self-hosted`);
    lines.push("```");
    for (const row of own) {
      lines.push(formatModelRow(row));
    }
    lines.push("```");
    lines.push("  `*` not a charge   `~` price of a matched model id");
    if (t.unpriced > 0) lines.push(`  ${t.unpriced} model(s) unpriced`);
  }

  const delegated = priceRows(getSessionModelUsage(p.sessionId, "delegated"), p.pricing);
  if (delegated.length > 0) {
    const t = totals(delegated);
    const calls = delegated.reduce((s, r) => s + r.calls, 0);
    const tokens = delegated.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0);
    lines.push("");
    lines.push("**Delegated by this session** (sub-agents, browser)");
    lines.push(`  ${calls} calls - ${short(tokens)} tokens - billed ${money(t.billed)}${t.reference > 0 ? ` - reference *${money(t.reference)}` : ""}`);
  }

  lines.push("");
  lines.push("**Runtime**");
  lines.push(`  active run    ${live}`);
  lines.push(`  verbose       ${session.verbose === false ? "off" : "on"}`);
  if (session.approvedTools?.length) lines.push(`  approved      ${session.approvedTools.join(", ")}`);
  if (session.sdkSessionId) lines.push(`  sdk session   \`${session.sdkSessionId}\``);

  return lines.join("\n");
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
