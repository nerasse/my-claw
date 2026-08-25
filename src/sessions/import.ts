/**
 * A stored session, read as a log -- docs/session-log.md annexe A.
 *
 * Pure: a `LegacySessionData` in, entries out, no I/O. The one-shot pass that writes them to disk is a
 * separate concern; keeping the mapping pure is what lets the whole of it be checked against real
 * sessions without touching them.
 *
 * The mapping is lossy in exactly one direction and it is deliberate. Four natures were folded
 * into one array (`messages` served the prompt *and* the screen, `commands` and `failures` sat
 * beside it in their own journals, `promptBase` was an index into the first): coming out, each
 * becomes its own entry, and the timestamp collation that used to put them back together is what
 * disappears. Nothing that was on screen is dropped.
 */

import type { Entry, Provisioned } from "./log.ts";
import type { LegacySessionData, SessionMessage } from "./store.ts";
import { summaryBodyOf } from "./compaction.ts";

/** Ordered payloads, ready to be appended in this order. Ids, seq and parentId are the log's job. */
export type ImportedEntry = Provisioned<Entry> & { ts: number };

/**
 * Milliseconds from a stored ISO timestamp.
 *
 * A session written by a version that used something else, or a field a hand-edit broke, must not
 * take the conversation with it: an unreadable timestamp inherits the previous entry's, which
 * keeps the order the array already had. The array order is the truth here, not the clock.
 */
function msOf(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? fallback : ms;
}

/**
 * A stored assistant turn, as the phases and tool calls it was.
 *
 * `segments` exist only when one API call produced more than one thinking phase; a turn without
 * them is its own only phase. The tool results live in the `role: "tool"` messages that follow,
 * keyed by call id, which is why the caller passes them in rather than this walking ahead.
 */
function phasesOf(message: Extract<SessionMessage, { role: "assistant" }>): Array<{ reasoning?: string; content: string; reasoningTokens?: number }> {
  if (message.segments?.length) {
    // Only the last phase carries the turn's token count: it is one number for the whole turn, and
    // repeating it on every phase would multiply what the status line adds up.
    return message.segments.map((segment, index) => ({
      ...segment,
      ...(index === message.segments!.length - 1 && message.reasoningTokens ? { reasoningTokens: message.reasoningTokens } : {}),
    }));
  }
  return [
    {
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      ...(message.reasoningTokens ? { reasoningTokens: message.reasoningTokens } : {}),
      content: message.content,
    },
  ];
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { value: parsed };
  } catch {
    return { raw };
  }
}

/**
 * The entries a stored session becomes, in the order they happened.
 *
 * Commands and failures are merged back in by timestamp *here, once*, and never again: that
 * collation is exactly what the log exists to stop doing on every page render. An aside with a
 * timestamp older than every message lands at the front rather than nowhere, which is where a
 * command that outlived the turns it was typed on used to become unreachable.
 */
export function entriesOf(session: LegacySessionData): ImportedEntry[] {
  return importSession(session).entries;
}

export interface ImportedSession {
  entries: ImportedEntry[];
  /**
   * Where the compaction boundary's floor lands in `entries`, or -1 when there is none.
   *
   * Resolved by position, never by timestamp, and that is not a detail: compaction inserts its
   * summary into the middle of the array with the clock of the moment it ran, so on a real session
   * here the summary is stamped 18:15:35 while the turn right after it is stamped 18:14:17. Any
   * ts-based match walks straight past the turns it was supposed to keep. The array order is the
   * truth; the clock is a hint.
   */
  boundaryIndex: number;
}

export function importSession(session: LegacySessionData): ImportedSession {
  const out: ImportedEntry[] = [];
  /** First entry each message produced, so an index into `messages` can become one into `out`. */
  const startOfMessage: number[] = [];
  let clock = msOf(session.createdAt, 0);

  // Each aside carries the entries it produces, so the merge below only compares timestamps.
  const asides: Array<{ ts: number; entries: ImportedEntry[] }> = [];
  for (const command of session.commands ?? []) {
    const ts = msOf(command.timestamp, clock);
    asides.push({
      ts,
      entries: [{ type: "command", prompt: false, input: command.input, output: command.output, ...(command.details ? { details: command.details } : {}), ts }],
    });
  }
  for (const failure of session.failures ?? []) {
    const ts = msOf(failure.timestamp, clock);
    asides.push({ ts, entries: [{ type: "failure", prompt: false, error: failure.error, ts }] });
  }
  asides.sort((a, b) => a.ts - b.ts);

  let nextAside = 0;
  const flushAsidesUpTo = (limit: number | undefined): void => {
    while (nextAside < asides.length) {
      const aside = asides[nextAside]!;
      if (limit !== undefined && aside.ts > limit) return;
      nextAside += 1;
      out.push(...aside.entries);
    }
  };

  // Outputs are keyed by call id across the whole session, not per turn: a stop between a call and
  // its result put the synthetic answer in the same place, and a turn only ever owns its own ids.
  const outputs = new Map<string, string>();
  for (const message of session.messages) {
    if (message.role === "tool") outputs.set(message.toolCallId, message.content);
  }

  for (let index = 0; index < session.messages.length; index++) {
    const message = session.messages[index]!;
    const ts = msOf(message.timestamp, clock);
    clock = ts;
    flushAsidesUpTo(ts);
    startOfMessage[index] = out.length;

    if (message.role === "tool") continue;

    if (message.role === "user") {
      if (message.summaryOf !== undefined) {
        // The summary was stored as a user turn because that is the role the prompt needs it in.
        // It becomes a boundary of its own, and `firstKeptEntryId` is filled by the caller: it
        // names an entry that does not have an id yet at this point.
        out.push({
          type: "compaction",
          prompt: true,
          summary: summaryBodyOf(message.content),
          firstKeptEntryId: "",
          tokensBefore: 0,
          count: message.summaryOf,
          ts,
        });
        continue;
      }
      out.push({
        type: "user",
        prompt: true,
        text: message.content,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        ...(message.location ? { location: message.location } : {}),
        ts,
      });
      continue;
    }

    // One run per stored assistant turn: the phases of a turn were produced by one API call, which
    // is exactly what `runId` groups. The id is positional because nothing recorded it at the time.
    const runId = `import-${index}`;
    for (const phase of phasesOf(message)) {
      out.push({
        type: "phase",
        prompt: true,
        text: phase.content,
        ...(phase.reasoning ? { reasoning: phase.reasoning } : {}),
        ...(phase.reasoningTokens ? { reasoningTokens: phase.reasoningTokens } : {}),
        runId,
        ts,
      });
    }
    for (const call of message.toolCalls ?? []) {
      // A call with no result is a run that never came back. It becomes an entry all the same,
      // because the card was on screen; `ok: false` is what the reader was already shown.
      const settled = outputs.has(call.id);
      const output = outputs.get(call.id) ?? "";
      out.push({
        type: "tool",
        prompt: true,
        callId: call.id,
        name: call.name,
        args: parseArguments(call.arguments),
        output,
        truncated: false,
        ok: settled && call.spawn?.status !== "error" && call.spawn?.status !== "aborted",
        ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
        ...(call.spawn ? { spawn: call.spawn } : {}),
        runId,
        ts,
      });
    }
  }

  flushAsidesUpTo(undefined);

  const base = session.promptBase ?? 0;
  // A boundary past the end is a session rewritten under a stale index: treat as no boundary.
  if (base <= 0 || base >= session.messages.length) return { entries: out, boundaryIndex: -1 };

  // The old index pointed at the summary turn itself, and the summary is now the boundary entry.
  // The floor is therefore the first entry of the first message after it that produced one -- a
  // turn can produce none (a `tool` message folds into the call above it), so this walks forward.
  let boundaryIndex = -1;
  for (let index = base + 1; index < session.messages.length; index++) {
    const start = startOfMessage[index];
    if (start !== undefined && start < out.length) {
      boundaryIndex = start;
      break;
    }
  }
  return { entries: out, boundaryIndex };
}


