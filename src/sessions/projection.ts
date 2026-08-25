/**
 * The log, read as a prompt -- docs/session-log.md §3.
 *
 * Pure: entries in, messages out, no state and no I/O. The log is the only thing that is true;
 * everything a consumer wants is a view of it, computed on demand. That is the whole point of the
 * split -- one tableau serving both the model and the screen is what forced every reconciliation
 * hack this replaces.
 *
 * The display projection is deliberately not here. It resolves attachments, media refs and tool
 * display names, all of which belong to a channel, and `sessions/` does not depend on `channels/`.
 */

import type { ChatMessage } from "../llm/provider.ts";
import type { Entry, PhaseEntry, ToolEntry, CompactionEntry } from "./log.ts";
import { pathOf } from "./log.ts";

/** Wrapper the model reads a compaction summary in. Same text the old summary turn carried. */
export const SUMMARY_OPEN = "[Prior context summarized]";
export const SUMMARY_CLOSE = "[End of summary — respond to the message below]";

export function summaryTurnText(summary: string): string {
  return `${SUMMARY_OPEN}\n${summary}\n\n${SUMMARY_CLOSE}`;
}

/**
 * The entries of a branch that the model is allowed to read, compaction applied.
 *
 * Two filters, in this order. `prompt` drops what is shown and never sent -- a slash command, a
 * failed run, a hand-back note. Then the *last* compaction on the branch moves the floor: the
 * summary entry itself, followed by everything from `firstKeptEntryId` onwards. What it replaced
 * stays on disk and stays on screen, which is the difference between a boundary and a deletion.
 *
 * The last one, not the first: compactions accumulate over a long conversation and only the newest
 * describes the current floor. An earlier one sits below it and is already summarised by it.
 */
export function contextEntries(entries: readonly Entry[], leafId: string | null): Entry[] {
  const path = pathOf(entries, leafId).filter((entry) => entry.prompt);

  let compaction: CompactionEntry | undefined;
  let compactionIndex = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.type === "compaction") {
      compaction = path[i] as CompactionEntry;
      compactionIndex = i;
      break;
    }
  }
  if (!compaction) return path;

  const keptFrom = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  // A boundary naming an entry this branch does not hold describes nothing here: sending the whole
  // branch costs tokens, dropping it loses turns, and only the first is recoverable.
  if (keptFrom < 0) return path;

  // Everything from the floor on, wherever the boundary itself sits relative to it. A live
  // compaction appends the boundary after the turns it covers, so it lands past them; an imported
  // one sat in the middle of the array it summarised, so the floor is after it. Both are the same
  // statement -- this is the floor, here is what stands for what is below it -- and taking the
  // union rather than a slice between two indexes is what makes the two geometries one case.
  // Any other boundary in the kept range is stale: the newest already summarises what an older one
  // stood for, so replaying it would hand the model the same context twice, once condensed.
  const kept = path.filter((entry, index) => index >= keptFrom && index !== compactionIndex && entry.type !== "compaction");
  return [compaction, ...kept];
}

/**
 * A branch as the chat-completions messages a provider is handed.
 *
 * Phases of one model turn fold back into a single assistant message, because that is what they
 * were before the streamer cut them: the cuts exist so the reader sees thinking beside the text it
 * produced, and a provider has no slot for them. The tool calls of that turn ride on the message,
 * their results follow it, and the order of the results is the order of the calls -- an
 * OpenAI-compatible endpoint matches them by id but rejects a result whose call it never saw.
 */
export function promptOf(entries: readonly Entry[], leafId: string | null): ChatMessage[] {
  const context = contextEntries(entries, leafId);
  const out: ChatMessage[] = [];

  for (let i = 0; i < context.length; i++) {
    const entry = context[i]!;

    if (entry.type === "user") {
      out.push({ role: "user", content: entry.text });
      continue;
    }

    if (entry.type === "compaction") {
      // A user turn, because that is the role the summary has to arrive in for the model to treat
      // it as context rather than as its own prior words.
      out.push({ role: "user", content: summaryTurnText(entry.summary) });
      continue;
    }

    if (entry.type !== "phase") continue;

    // One model turn: every phase sharing this runId, then the tools it called.
    const runId = entry.runId;
    const phases: PhaseEntry[] = [];
    while (i < context.length && context[i]!.type === "phase" && (context[i] as PhaseEntry).runId === runId) {
      phases.push(context[i] as PhaseEntry);
      i++;
    }
    const tools: ToolEntry[] = [];
    while (i < context.length && context[i]!.type === "tool" && (context[i] as ToolEntry).runId === runId) {
      tools.push(context[i] as ToolEntry);
      i++;
    }
    i--;

    const text = phases.map((phase) => phase.text).filter((part) => part.length > 0).join("\n\n");
    // Of the whole turn, only the last phase's provider state is still current: it is the state the
    // provider left the turn in, and the earlier ones describe positions it has already moved past.
    const providerMeta = phases[phases.length - 1]?.providerMeta;

    // A turn that says nothing and asks for nothing is not a turn. It happens for real: the model
    // called a tool without writing any prose, so the phase is empty, and the call has not settled
    // yet, so no tool entry derives a `tool_calls`. Mid-run steering rebuilds the prompt in exactly
    // that window. Sending it costs the whole conversation rather than one turn -- Anthropic
    // answers HTTP 400 "text content blocks must be non-empty", and a retry reposts the same
    // prompt, so the run cannot recover. Dropping it loses nothing: there is nothing in it.
    if (!text && tools.length === 0) continue;

    const assistant: ChatMessage = {
      role: "assistant",
      content: text,
      ...(tools.length > 0
        ? {
            tool_calls: tools.map((tool) => ({
              id: tool.callId,
              type: "function" as const,
              function: { name: tool.name, arguments: JSON.stringify(tool.args) },
            })),
          }
        : {}),
      ...(providerMeta ? { providerMeta: providerMeta as never } : {}),
    };
    out.push(assistant);

    for (const tool of tools) {
      out.push({ role: "tool", tool_call_id: tool.callId, content: tool.output });
    }
  }

  return out;
}

/**
 * Why no tool call here can be left dangling, and what it costs.
 *
 * The old store persisted the assistant turn with its `tool_calls` *before* the tools ran, so a
 * process killed mid-tool left a request nothing would ever answer, and an OpenAI-compatible
 * provider refuses that prompt outright, killing the conversation rather than one turn.
 *
 * It cannot happen here: `tool_calls` above are *derived from the tool entries*, and a tool entry
 * is only written once the call has settled and has a result. A killed run leaves phases and no
 * tool entry, which projects to an assistant turn that asked for nothing.
 *
 * That turn is dropped rather than sent, and the distinction matters: "asked for nothing" is legal
 * only while it still *says* something. A phase with no prose -- the model called a tool without a
 * word of commentary -- projects to a turn with no text and no tool call, which is not a legal
 * assistant turn anywhere. Anthropic refuses the whole request ("text content blocks must be
 * non-empty"), and since a retry reposts the same prompt the run cannot recover: one unsettled
 * call took the conversation down. Mid-run steering hits that window every time, because injecting
 * a message rebuilds the prompt while a call is still running.
 *
 * The price is on the screen, not in the prompt: a call still executing is in no entry, so a page
 * built from the log alone cannot draw its spinner. The live frames carry it while the socket is
 * up, and a reload keeps it because the app holds the cards of a run it is told is still active
 * (`chat.history.activeRun`, commit 48f084d). Both halves of that are lot 4's problem.
 */
