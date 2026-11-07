/**
 * A sub-agent's lifecycle, written as it happens and folded back onto its card -- docs/session-log.md §5.
 *
 * This is the one place in the log where an entry is *about* another entry, and the reason is
 * timing. A `spawn` tool hands back the moment the child is launched, so its tool entry is written
 * while the child is still working; complete, error, killed and reset all land after the single
 * write that entry ever gets. Rewriting it is not an option -- an entry is written once, which is
 * what makes every reader of this format able to trust what it holds.
 *
 * So the writer appends, and the reader folds. `spawnStates` is the fold: entries in, one state per
 * card out. It is the only place the rules live -- notably that a terminal state is final -- so a
 * log written by an older build, or by two processes, still reads the same way.
 */

import { hooks } from "../hooks/index.ts";
import type { HookEventMap } from "../hooks/index.ts";
import { log } from "../utils/logger.ts";
import type { Entry, SessionLog, SpawnStateEntry } from "./log.ts";
import type { LogRecord } from "./log-index.ts";
import type { SessionSubAgentAction, SessionSubAgentState, SessionSubAgentStatus } from "./store.ts";

/** What a lifecycle event knows. Only the opening one carries an identity. */
export interface SpawnStateUpdate {
  subagentId: string;
  status: SessionSubAgentStatus;
  /** The `spawn` or `send` call that opened the card. Absent on a terminal event: see `cardOf`. */
  toolCallId?: string;
  displayName?: string;
  agentType?: string;
  mode?: string;
  action?: SessionSubAgentAction;
  /** What the child was asked to do. Opening event only, like the identity. */
  task?: string;
  resultLength?: number;
  error?: string;
}

/**
 * One state per card, keyed on the tool call id the card is drawn under.
 *
 * File order, not branch order: a card is identified by a call id, which is unique whatever branch
 * the conversation went down, and a child launched before a `/fork` still finishes afterwards. A
 * branch that never held the call simply never asks about it.
 *
 * Two rules, and both are here rather than at the writer so that the log's meaning never depends on
 * which build wrote it:
 *
 * - A terminal state is final. Nothing after it counts -- not a duplicate, not a `kill` aimed at a
 *   child that had already answered. Without this, a roster sweep at shutdown turns every finished
 *   card in the history into an aborted one.
 * - An imported `spawn` on the tool entry is the floor. Sessions from before this entry existed
 *   carry their state inline (`ToolEntry.spawn`), and it is a state that had already settled.
 */
export function spawnStates(entries: readonly Entry[]): Map<string, SessionSubAgentState> {
  const out = new Map<string, SessionSubAgentState>();

  for (const entry of entries) {
    if (entry.type === "tool") {
      if (entry.spawn && !out.has(entry.callId)) out.set(entry.callId, entry.spawn);
      continue;
    }
    if (entry.type !== "spawn_state") continue;

    const current = out.get(entry.callId);
    if (current && current.status !== "running") continue;
    const ts = new Date(entry.ts).toISOString();
    out.set(entry.callId, {
      subagentId: entry.subagentId,
      displayName: entry.displayName ?? current?.displayName ?? entry.subagentId,
      agentType: entry.agentType ?? current?.agentType ?? "unknown",
      mode: entry.mode ?? current?.mode ?? "run",
      action: entry.action ?? current?.action ?? "spawn",
      status: entry.status,
      startedAt: current?.startedAt ?? ts,
      ...(entry.task !== undefined ? { task: entry.task } : current?.task !== undefined ? { task: current.task } : {}),
      ...(entry.resultLength !== undefined
        ? { resultLength: entry.resultLength }
        : current?.resultLength !== undefined
          ? { resultLength: current.resultLength }
          : {}),
      ...(entry.error !== undefined ? { error: entry.error } : current?.error !== undefined ? { error: current.error } : {}),
      ...(entry.status === "running" ? {} : { finishedAt: current?.finishedAt ?? ts }),
    });
  }

  return out;
}

/**
 * The card a sub-agent's state belongs to, for an event that only knows the child.
 *
 * A terminal event carries no tool call id -- by the time a child is done, the code settling it is
 * nowhere near the call that asked for it -- so the log answers instead: the opening entry recorded
 * the pairing. The *last* one, because a `send` to a live child opens a new card, and it is that
 * card the next result belongs on.
 */
export function cardOf(entries: readonly Entry[], subagentId: string): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "spawn_state" && entry.subagentId === subagentId) return entry.callId;
  }
  return undefined;
}

/**
 * The fold, plus the cards the log already carries.
 *
 * A state whose card exists is drawn *there*, at the tool entry's own position; one whose card is
 * still missing -- `spawn` returns while the child works, so the entry lands only when the whole
 * batch settles -- has to draw itself, and this is what tells the two apart.
 */
export interface SpawnView {
  states: ReadonlyMap<string, SpawnCardState>;
  /** Call ids with a tool entry anywhere in the log: those cards need no stand-in. */
  carded: ReadonlySet<string>;
}

/**
 * A card as a reader shows it. `interrupted` is never written: it is what a `running` state reads
 * as once nothing drives the child any more.
 */
export type SpawnCardState = Omit<SessionSubAgentState, "status"> & { status: SessionSubAgentStatus | "interrupted" };

/**
 * `live` answers whether a session has a run in flight. A `running` state only says the child had
 * started when the log was last written: a server that went down under it (a crash, a kill, a
 * restart) never writes the end, and the card spun for good in the parent's thread while the
 * child sat idle (2026-10-04). Whether it still runs is the process's to say, so it is asked here.
 */
export function spawnView(entries: readonly Entry[], live: (sessionId: string) => boolean): SpawnView {
  const carded = new Set<string>();
  for (const entry of entries) if (entry.type === "tool") carded.add(entry.callId);
  const states = new Map<string, SpawnCardState>();
  for (const [callId, state] of spawnStates(entries)) {
    states.set(callId, state.status === "running" && !live(state.subagentId) ? { ...state, status: "interrupted" } : state);
  }
  return { states, carded };
}

/**
 * Records one step, or declines.
 *
 * Two reasons to decline, and neither is an error. A lifecycle with no card behind it -- a child
 * started from the roster rather than by a tool call -- has nothing to annotate, and writing it
 * would be a line no reader ever asks for. A card that has already settled is final, and appending
 * past it would only grow the file with entries `spawnStates` is bound to ignore.
 */
export async function appendSpawnState(entryLog: SessionLog, update: SpawnStateUpdate): Promise<SpawnStateEntry | null> {
  // The states and the cards they revise, and nothing else: a lifecycle event is written while a
  // run is working, and reading 46 000 entries to decide one line would put the log on that path.
  const records = [];
  for (let i = 0; i < entryLog.count(); i++) {
    const record = entryLog.recordAt(i);
    if (record.type === "spawn_state" || record.spawnCard) records.push(record);
  }
  const entries = await entryLog.entriesIn(records);
  const callId = update.toolCallId ?? cardOf(entries, update.subagentId);
  if (!callId) return null;
  const current = spawnStates(entries).get(callId);
  if (current && current.status !== "running") return null;

  return entryLog.append<SpawnStateEntry>({
    type: "spawn_state",
    prompt: false,
    callId,
    subagentId: update.subagentId,
    status: update.status,
    ...(update.displayName ? { displayName: update.displayName } : {}),
    ...(update.agentType ? { agentType: update.agentType } : {}),
    ...(update.mode ? { mode: update.mode } : {}),
    ...(update.action ? { action: update.action } : {}),
    ...(update.task ? { task: update.task } : {}),
    ...(update.resultLength !== undefined ? { resultLength: update.resultLength } : {}),
    ...(update.error ? { error: update.error } : {}),
  });
}

/**
 * What boot gets back: a way to wait for the writes in flight, and a way to unsubscribe.
 *
 * Neither is used by the process itself, which registers once and runs until it exits. They exist
 * because a listener on the shared hook bus is module-level state: a test that could not wait for
 * its own event would have to sleep, and one that could not unsubscribe would leak into the next.
 */
export interface SpawnLifecycleRecorder {
  /** Resolves once every state the bus has handed over is in the log. */
  settled(): Promise<void>;
  stop(): void;
}

/**
 * Subscribes the log to the sub-agent lifecycle, for the whole life of the process.
 *
 * Registered once at boot rather than per run, and that is the point: a background child outlives
 * the run that spawned it, so a subscription scoped to that run would miss exactly the events this
 * exists for. The card is in the parent's conversation, so that is the log written to -- `kill` and
 * `reset` reach it from a third conversation and still land on the right card.
 */
export function recordSpawnLifecycle(logOf: (sessionId: string) => Promise<SessionLog>): SpawnLifecycleRecorder {
  // One chain per conversation. `logOf` caches, so all but the first call resolve instantly, but
  // "instantly" is still a turn of the microtask queue: two events racing on a cold session could
  // land in the wrong order, and an opening entry written after its own terminal one is a card
  // stuck on the spinner for good.
  const chains = new Map<string, Promise<void>>();

  const record = (sessionId: string, update: SpawnStateUpdate): void => {
    if (!sessionId) return;
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await appendSpawnState(await logOf(sessionId), update);
      })
      .catch((error: unknown) => {
        void log("warn", "session log: sub-agent state not recorded", {
          sessionId,
          subagentId: update.subagentId,
          status: update.status,
          error: String(error),
        });
      })
      .finally(() => {
        if (chains.get(sessionId) === next) chains.delete(sessionId);
      });
    chains.set(sessionId, next);
  };

  const onSpawn = (event: HookEventMap["subagent:spawn"]): void => {
    record(event.parentSessionId, {
      subagentId: event.id,
      status: "running",
      displayName: event.displayName,
      agentType: event.type,
      mode: event.mode,
      action: event.action,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.task ? { task: event.task } : {}),
    });
  };
  const onComplete = (event: HookEventMap["subagent:complete"]): void => {
    record(event.parentSessionId, { subagentId: event.id, status: "complete", resultLength: event.resultLength });
  };
  const onError = (event: HookEventMap["subagent:error"]): void => {
    record(event.parentSessionId, { subagentId: event.id, status: "error", error: String(event.error) });
  };
  const onAborted = (event: HookEventMap["subagent:aborted"]): void => {
    record(event.parentSessionId, { subagentId: event.id, status: "aborted" });
  };
  // The wording the live frames already use, so a card settled by a kill reads the same whether it
  // was replayed from the log or watched as it happened.
  const onKilled = (event: HookEventMap["subagent:killed"]): void => {
    record(event.parentSessionId, { subagentId: event.id, status: "aborted", error: "sub-agent killed" });
  };
  const onReset = (event: HookEventMap["subagent:reset"]): void => {
    record(event.parentSessionId, { subagentId: event.id, status: "aborted", error: "sub-agent reset" });
  };

  hooks.on("subagent:spawn", onSpawn);
  hooks.on("subagent:complete", onComplete);
  hooks.on("subagent:error", onError);
  hooks.on("subagent:aborted", onAborted);
  hooks.on("subagent:killed", onKilled);
  hooks.on("subagent:reset", onReset);

  return {
    // Drained in a loop, not once: a write that is queued behind another only appears in `chains`
    // while the first is still running, so a single pass can miss the tail.
    async settled(): Promise<void> {
      while (chains.size > 0) await Promise.all([...chains.values()]);
    },
    stop(): void {
      hooks.off("subagent:spawn", onSpawn);
      hooks.off("subagent:complete", onComplete);
      hooks.off("subagent:error", onError);
      hooks.off("subagent:aborted", onAborted);
      hooks.off("subagent:killed", onKilled);
      hooks.off("subagent:reset", onReset);
    },
  };
}
