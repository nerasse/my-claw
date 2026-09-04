/**
 * Compacting before it is needed, so the wait lands where nobody is waiting -- docs/compaction.md.
 *
 * A compaction is a full LLM call over the whole conversation: one to two minutes with nothing on
 * the wire, and it fires at the worst possible moment, right after the owner pressed send. The
 * work does not have to happen then. Once occupancy enters a band just below the threshold, the
 * summary can be computed against a snapshot while the owner is reading the answer he just got,
 * and the crossing itself becomes an append.
 *
 * Taken from oh-my-pi's `compaction.asyncEnabled` (17.4.0), with their two load-bearing rules:
 * only ever speculate the expensive half, and never commit a snapshot the branch has moved past.
 */

import type { MyClawConfig } from "../core/config.ts";
import { log as logLine } from "../utils/logger.ts";
import { errorLogData } from "../utils/errors.ts";
import { sessionLogOf } from "./log-access.ts";
import { pathOf, type Entry } from "./log.ts";
import { contextEntries } from "./projection.ts";
import {
  commitCompaction,
  entriesPromptTokens,
  planCompaction,
  summarizeForCompaction,
  tailBudgetFor,
  TAIL_BUDGET_TOKENS,
  type CompactionPlan,
  type CompactionResult,
} from "./compaction.ts";
import type { SessionData } from "./store.ts";
import { isAbort } from "../core/aborted.ts";

interface Armed {
  plan: CompactionPlan;
  summary: string;
}

/**
 * One armed summary per session, and one flight per session.
 *
 * Module-level, therefore shared by every test file: reset in `tests/setup-globals.ts`.
 */
const armed = new Map<string, Armed>();
interface Flight {
  controller: AbortController;
  /** Settles when the background pass has armed, failed or been cancelled. */
  done: Promise<void>;
}
const inflight = new Map<string, Flight>();

/**
 * How far below the threshold the band opens.
 *
 * An eighth of the threshold, floored and capped: proportional so a 512k window does not start
 * speculating 8k early (one tool call), bounded so a 32k window does not start at half full.
 */
export function speculationLeadTokens(thresholdTokens: number): number {
  return Math.min(32_000, Math.max(8_192, Math.round(thresholdTokens * 0.125)));
}

/** Below the threshold but within a lead of it. Above it, the blocking path owns the case. */
export function inSpeculationBand(occupiedTokens: number, thresholdTokens: number): boolean {
  if (thresholdTokens <= 0) return false;
  return occupiedTokens < thresholdTokens && occupiedTokens >= thresholdTokens - speculationLeadTokens(thresholdTokens);
}

export function isSpeculating(sessionId: string): boolean {
  return inflight.has(sessionId);
}

/**
 * The background pass for a session, for whoever must not race it.
 *
 * A test needs it to be deterministic instead of sleeping, and a shutdown needs it to know whether
 * a summarizer call is still on the wire.
 */
export function pendingSpeculation(sessionId: string): Promise<void> | undefined {
  return inflight.get(sessionId)?.done;
}

export function hasArmedCompaction(sessionId: string): boolean {
  return armed.has(sessionId);
}

/**
 * Drop whatever is armed or in flight for a session.
 *
 * Called by every path that compacts for real: a manual pass supersedes the background one, and
 * running both would bill the summarizer twice and race the same append.
 */
export function cancelSpeculation(sessionId: string): void {
  inflight.get(sessionId)?.controller.abort();
  inflight.delete(sessionId);
  armed.delete(sessionId);
}

export function resetSpeculations(): void {
  for (const flight of inflight.values()) flight.controller.abort();
  inflight.clear();
  armed.clear();
}

function lastCompactionId(entries: readonly Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compaction") return entries[i]!.id;
  }
  return undefined;
}

/**
 * Whether an armed summary still describes the branch.
 *
 * Three ways it stops describing it, and all three are silent corruption if committed anyway:
 * the boundary it names was rewound away; another compaction landed in the meantime, so appending
 * this one would move the floor *backwards*; or so much has been added since the snapshot that the
 * turns the summary does not cover would no longer fit in the verbatim tail.
 */
function stillValid(plan: CompactionPlan, entries: readonly Entry[], leafId: string | null, tailBudget: number): boolean {
  const path = pathOf(entries, leafId).filter((entry) => entry.prompt);
  const keptAt = path.findIndex((entry) => entry.id === plan.firstKeptEntryId);
  if (keptAt < 0) return false;

  const plannedLastCompaction = lastCompactionId(plan.entries);
  const currentLastCompaction = lastCompactionId(path);
  if (currentLastCompaction !== plannedLastCompaction) return false;

  const plannedLast = plan.entries[plan.entries.length - 1];
  if (!plannedLast) return false;
  const plannedLastAt = path.findIndex((entry) => entry.id === plannedLast.id);
  if (plannedLastAt < 0) return false;

  return entriesPromptTokens(path.slice(plannedLastAt + 1)) <= tailBudget;
}

/**
 * Start a background summary for a session, if one is worth starting.
 *
 * Fire and forget by design: the caller is a run that has just finished answering and must not wait
 * for it, and a failure here costs nothing but the blocking pass that would have happened anyway.
 */
export function startSpeculation(config: MyClawConfig, session: SessionData): void {
  const sessionId = session.id;
  if (inflight.has(sessionId) || armed.has(sessionId)) return;

  const controller = new AbortController();
  const done = (async () => {
    try {
      const sessionLog = await sessionLogOf(sessionId);
      const planned = planCompaction(sessionLog, tailBudgetFor(config, session));
      if (!planned.ok) {
        void logLine("debug", "speculative compaction not planned", { sessionId, reason: planned.reason });
        return;
      }
      const summarized = await summarizeForCompaction(
        config,
        session,
        planned.plan,
        undefined,
        controller.signal,
        "compaction-speculative",
      );
      if (!summarized.ok) {
        void logLine("info", "speculative compaction produced no summary", { sessionId, reason: summarized.reason });
        return;
      }
      // The controller is aborted by `cancelSpeculation`, which also clears the map: arming here
      // would resurrect a summary a manual compaction has already superseded.
      if (controller.signal.aborted) return;
      armed.set(sessionId, { plan: planned.plan, summary: summarized.summary });
      void logLine("info", "speculative compaction armed", {
        sessionId,
        covered: planned.plan.middle.length,
        summaryLength: summarized.summary.length,
      });
    } catch (err) {
      if (isAbort(err, controller.signal)) return;
      void logLine("warn", "speculative compaction failed", { sessionId, error: errorLogData(err) });
    } finally {
      if (inflight.get(sessionId)?.controller === controller) inflight.delete(sessionId);
    }
  })();
  inflight.set(sessionId, { controller, done });
}

/**
 * Commit an armed summary if one is still good for this branch.
 *
 * Returns `undefined` when there is nothing to claim, which is the caller's signal to run the
 * blocking path. A stale entry is dropped here rather than kept for a later attempt: what made it
 * stale only ever grows.
 */
export async function claimSpeculation(config: MyClawConfig, session: SessionData): Promise<CompactionResult | undefined> {
  const entry = armed.get(session.id);
  if (!entry) return undefined;
  armed.delete(session.id);

  const sessionLog = await sessionLogOf(session.id);
  const before = pathOf(sessionLog.entries(), sessionLog.leaf()).filter((e) => e.prompt).length;
  if (!stillValid(entry.plan, sessionLog.entries(), sessionLog.leaf(), tailBudgetFor(config, session))) {
    void logLine("info", "speculative compaction discarded, the branch moved", { sessionId: session.id });
    return undefined;
  }

  const boundary = await commitCompaction(sessionLog, entry.plan, entry.summary);
  session.lastActiveAt = new Date().toISOString();
  const afterCount = contextEntries(sessionLog.entries(), sessionLog.leaf()).length;
  void logLine("info", "speculative compaction claimed", { sessionId: session.id, beforeCount: before, afterCount });
  return {
    ok: true,
    beforeCount: before,
    afterCount,
    summary: entry.summary,
    boundary: { entryId: boundary.id, count: boundary.count },
  };
}
