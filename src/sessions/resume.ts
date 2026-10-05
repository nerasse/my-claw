import { pathOf, type Entry, type PhaseEntry, type RunEndEntry, type SpawnStateEntry, type ToolEntry, type UserEntry } from "./log.ts";

/**
 * What a conversation stopped on, read from its log, so a run can pick it back up without a new
 * turn from anyone -- docs/continue.md.
 *
 * Everything here is a read of the log. Nothing is kept anywhere else, so a thread stopped a week
 * ago, a sub-agent reopened from its own chat and a run the server lost at a crash are all read the
 * same way.
 */

/** The tools whose call is a sub-agent run: the ones a Continue can resume instead of redoing. */
const SUBAGENT_TOOLS = new Set(["spawn", "send", "delegate_browser_task"]);

function lastRunOf(path: readonly Entry[]): { start: number; end?: RunEndEntry } | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.type !== "run_start") continue;
    const end = path.slice(i + 1).find((entry): entry is RunEndEntry => entry.type === "run_end");
    return { start: i, ...(end ? { end } : {}) };
  }
  return undefined;
}

export type Continuable =
  | { ok: true; lastUserText: string; ended: "aborted" | "error" | "lost" }
  | { ok: false; reason: string };

/**
 * Whether the conversation can be picked back up: the owner's last message has not been answered
 * to the end. A run still going is the caller's to check -- only it knows what is live.
 *
 * Read from the last message rather than from the last run, and decided by the last run marker
 * after it: an end says how it ended (`done` leaves nothing to do), a start with no end is a run
 * the server lost, and no marker at all is a message no run ever took up. Reading the last run
 * instead refused the message stopped before its run wrote its own marker (a Stop during the
 * snapshot, the transcription, a compaction ahead of the run): it found the run before, finished,
 * and answered "the last run finished" about a message nothing had answered (2026-10-02).
 */
export function continuable(entries: readonly Entry[], leafId: string | null): Continuable {
  const path = pathOf(entries, leafId);
  let userAt = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.type === "user") {
      userAt = i;
      break;
    }
  }
  if (userAt < 0) return { ok: false, reason: "Nothing to continue: this conversation has no run yet." };
  const lastUserText = (path[userAt] as UserEntry).text;
  for (let i = path.length - 1; i > userAt; i--) {
    const entry = path[i]!;
    if (entry.type === "run_start") return { ok: true, lastUserText, ended: "lost" };
    if (entry.type !== "run_end") continue;
    if (entry.reason === "done") return { ok: false, reason: "Nothing to continue: the last run finished." };
    return { ok: true, lastUserText, ended: entry.reason };
  }
  return { ok: true, lastUserText, ended: "lost" };
}

/** A sub-agent call of the last run whose answer never reached the log, and what it was. */
export interface OrphanCall {
  turnId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  subagentId: string;
}

/**
 * Sub-agent calls the server lost with its run: the run died while they worked (a crash, a
 * restart), so no result was ever written, and the prompt, which derives a turn's calls from their
 * results, does not show them at all. The model then spawns a fresh sub-agent and the first one's
 * work is lost. `spawn_state` entries survive, and they name the call, the child and its task.
 *
 * Only when nothing the model said comes after the turn that made them: past that, the model has
 * moved on, and a result appended now would land in the wrong place of the conversation.
 */
export function orphanCalls(entries: readonly Entry[], leafId: string | null): OrphanCall[] {
  const path = pathOf(entries, leafId);
  const run = lastRunOf(path);
  if (!run) return [];
  const settled = new Set(path.filter((e): e is ToolEntry => e.type === "tool").map((e) => e.callId));
  const out: OrphanCall[] = [];
  let lastPhase: PhaseEntry | undefined;
  for (let i = run.start + 1; i < path.length; i++) {
    const entry = path[i]!;
    if (entry.type === "phase") {
      lastPhase = entry;
      continue;
    }
    if (entry.type !== "spawn_state" || !entry.action || settled.has(entry.callId) || !lastPhase) continue;
    if (out.some((o) => o.callId === entry.callId)) continue;
    out.push({ turnId: lastPhase.runId, callId: entry.callId, subagentId: entry.subagentId, ...callShape(entry) });
  }
  if (!lastPhase) return [];
  const afterTurn = path.slice(path.indexOf(lastPhase) + 1);
  // A filed report (a cron delivery) is not the model moving on: it says nothing in the turn.
  const movedOn = afterTurn.some((e) => e.prompt && e.type !== "command" && !(e.type === "tool" && e.runId === lastPhase!.runId));
  return movedOn ? [] : out.filter((o) => o.turnId === lastPhase!.runId);
}

function callShape(entry: SpawnStateEntry): { name: string; args: Record<string, unknown> } {
  if (entry.agentType === "browser") return { name: "delegate_browser_task", args: { instructions: entry.task ?? "" } };
  if (entry.action === "send") return { name: "send", args: { id: entry.subagentId, message: entry.task ?? "" } };
  return {
    name: "spawn",
    args: {
      ...(entry.displayName ? { name: entry.displayName } : {}),
      ...(entry.agentType ? { type: entry.agentType } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
      task: entry.task ?? "",
    },
  };
}

/** The sub-agent a call ran, from the lifecycle its card recorded. */
export function subagentOfCall(entries: readonly Entry[], callId: string): string | undefined {
  for (const entry of entries) {
    if (entry.type === "spawn_state" && entry.callId === callId && entry.action) return entry.subagentId;
  }
  return undefined;
}

/**
 * The result a call gets when its run ended under it. Said so the model reads a stop, not a
 * failure of the tool -- and for a sub-agent, that its work is kept and how to get it back, so it
 * resumes the one it had instead of starting a new one from nothing.
 */
export function interruptedOutput(name: string, subagentId?: string): string {
  if (subagentId && SUBAGENT_TOOLS.has(name)) {
    return `Interrupted: the run stopped before this sub-agent answered. Sub-agent ${subagentId} kept everything it had done so far; it is paused, not gone. send(id: "${subagentId}") with no message resumes it where it stopped, with its whole history. Do not start a new one for the same task.`;
  }
  return "Interrupted: the run stopped before this call returned. Whether it had any effect is unknown: check before doing it again.";
}

/** A sub-agent the last run left interrupted, which a Continue resumes before anything else. */
export interface InterruptedSubagent {
  callId: string;
  subagentId: string;
}

export function interruptedSubagents(entries: readonly Entry[], leafId: string | null): InterruptedSubagent[] {
  const path = pathOf(entries, leafId);
  const run = lastRunOf(path);
  if (!run) return [];
  const out: InterruptedSubagent[] = [];
  for (const entry of path.slice(run.start + 1)) {
    if (entry.type !== "tool" || entry.interrupted !== true || !SUBAGENT_TOOLS.has(entry.name)) continue;
    const subagentId = subagentOfCall(path, entry.callId);
    if (subagentId && !out.some((o) => o.subagentId === subagentId)) out.push({ callId: entry.callId, subagentId });
  }
  return out;
}

/**
 * Where the prompt of a Continue ends, which decides what it needs: after a result or a question
 * the model just answers, but after its own text it was cut off mid-answer, and handed that alone
 * it starts over two times in three (measured on deepseek-v4.1-flash, 2026-09-28).
 */
export function endsOnOwnText(entries: readonly Entry[], leafId: string | null): boolean {
  const prompt = pathOf(entries, leafId).filter((e) => e.prompt && e.type !== "command");
  const last = prompt[prompt.length - 1];
  return last?.type === "phase" && last.text.trim().length > 0;
}

export const CUT_OFF_NUDGE =
  "[Continue] Your previous answer was cut off right after the text above. Continue it from exactly where it stopped: do not repeat what is already written, do not start over.";

/**
 * The answer a finished run gave, for a sub-agent asked to resume that had in fact completed: the
 * caller gets it without the run being redone.
 */
export function lastAnswer(entries: readonly Entry[], leafId: string | null): string | undefined {
  const path = pathOf(entries, leafId);
  const run = lastRunOf(path);
  if (!run || run.end?.reason !== "done") return undefined;
  const phases = path.slice(run.start + 1).filter((e): e is PhaseEntry => e.type === "phase");
  const last = phases[phases.length - 1];
  if (!last) return undefined;
  return phases.filter((p) => p.runId === last.runId).map((p) => p.text).filter(Boolean).join("\n\n") || undefined;
}
