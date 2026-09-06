/**
 * A run, written as entries -- docs/session-log.md §3, partie 5.
 *
 * The bridge decides what happens; this decides what is kept. Splitting them is what keeps the
 * loop readable, but it is also the only way the mapping can be tested at all: a run is an API
 * call in a retry loop around a tool executor, and nothing about that is worth standing up to
 * find out whether a cut turn produced the right two entries.
 *
 * Three decisions live here and nowhere else.
 *
 * **A turn id groups one API call's output.** Every phase and every tool of one call share it
 * (stored as `runId`, a name from before runs had markers), and that is what lets `promptOf` fold
 * the phases back into the single assistant turn they were before the streamer cut them. It is
 * minted per call, not per run: an agentic run is a dozen calls, and folding all of them into one
 * turn would hand the model its own history as a single message. The run itself is named by the
 * run context's id, which its `run_start` marker carries.
 *
 * **A tool entry is written when the call settles, never before.** The old store persisted the
 * assistant turn with its `tool_calls` before the tools ran, so a process killed mid-tool left a
 * request nothing would ever answer -- and an OpenAI-compatible provider refuses that prompt
 * outright, killing the conversation rather than one turn. Here the calls in the prompt are
 * derived from the entries that carry the results, so the two cannot drift apart and the seal that
 * repairs the old shape has nothing to repair.
 *
 * **A failed run branches, it does not truncate.** The old loop cut the array back to where the
 * turn started, destroying what the run had produced. Moving the cursor instead leaves the dead
 * branch on disk, reachable, which is what makes `/retry` a sibling rather than an overwrite.
 */

import { currentRunId, newRunId, takeRunBubbles } from "../utils/run-context.ts";
import { spillToolOutput } from "../sessions/tool-output.ts";
import type { SessionLog, Entry, PhaseEntry, ToolEntry, UserEntry } from "../sessions/log.ts";
import type { SessionAttachment } from "../sessions/store.ts";
import type { ChatLocation } from "../channels/types.ts";
import type { ProviderMeta } from "../llm/provider.ts";

/** One phase of a model turn: what it thought, then what it wrote. */
export interface RecordedPhase {
  content: string;
  reasoning?: string;
}

export interface RecordedTurn {
  /** The whole turn's text, used when the provider reported no phases. */
  content: string;
  reasoning?: string;
  /** Set only when one call produced more than one thinking phase. */
  segments?: RecordedPhase[];
  /** How much it thought, when the engine counts instead of reporting the text. */
  reasoningTokens?: number;
  /** Opaque provider state. Persisted, unlike before -- a resumed run kept losing the chain. */
  providerMeta?: ProviderMeta;
  /** The turn came back cut. Its provider state describes a position it never reached. */
  incomplete?: boolean;
}

export interface RecordedToolCall {
  callId: string;
  name: string;
  arguments: string;
  output: string;
  ok: boolean;
  durationMs?: number;
}

/**
 * The entry that was written, and what the caller should put in the live prompt for it.
 *
 * Two views of one output, decided in a single place (`spillToolOutput`): the entry is what every
 * later run replays and is kept small, the message is what the run that made the call still gets
 * to see. Handing the caller a string it has to re-derive is how the two drift apart.
 */
export interface RecordedTool {
  entry: ToolEntry;
  message: string;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { value: parsed };
  } catch {
    // A turn cut on `length` stops mid-serialization, so the arguments are half-written. Keeping
    // the raw text is what lets the card show what was attempted rather than an empty object.
    return { raw };
  }
}

let turnCounter = 0;

/**
 * A fresh id for one API call's output. Monotonic within a process, unique across one. Stored on
 * phases and tools under `runId`, a name from before runs had markers: it groups one model turn,
 * while the run itself is named by the run context's id (`run-context.ts`).
 */
export function newTurnId(): string {
  turnCounter += 1;
  return `run-${Date.now().toString(36)}-${turnCounter.toString(36)}`;
}

/**
 * Writes one run's entries into a session's log.
 *
 * Holds the leaf the run started from, which is the only state it needs: a failure rewinds to it,
 * and the rewind is a cursor move rather than a deletion.
 */
export class RunRecorder {
  private readonly entries: SessionLog;
  /** Where rewind() returns: advances when user() is called, so rewinding never erases a user turn. */
  private startLeaf: string | null;
  private currentTurnId: string;

  constructor(entries: SessionLog) {
    this.entries = entries;
    this.startLeaf = entries.leaf();
    this.currentTurnId = newTurnId();
  }

  /** The turn id in force. Phases and tools written now are one model turn. */
  turnId(): string {
    return this.currentTurnId;
  }

  /**
   * Marks the opening of this run under the trigger turn just written.
   *
   * Everything logged from here to `runEnd` is one run's work -- docs/run-grouping.md. The marker
   * is the floor the app folds a finished run under, and the absence of its `run_end` pair is what
   * tells a reopened thread that the run is still in flight. It carries the run context's id, the
   * same one `chat.run.start` put on the wire, so the fold names the run the app already knows.
   */
  runStart(): Entry {
    return this.entries.append({ type: "run_start", prompt: false, runId: currentRunId() ?? newRunId() });
  }

  /** Marks the closing of this run and why it ended. */
  runEnd(reason: "done" | "aborted" | "error"): Entry {
    return this.entries.append({ type: "run_end", prompt: false, reason });
  }

  /**
   * Starts a new model turn.
   *
   * Called before each API call, so the phases of one call stay together and two calls stay apart.
   */
  nextTurn(): string {
    this.currentTurnId = newTurnId();
    return this.currentTurnId;
  }

  /**
   * What the owner (or another agent) asked.
   *
   * Advances the rewind floor: a failed run must never erase a question the owner actually sent.
   * The floor moves here, not in a separate call, so the invariant holds by construction.
   */
  user(input: {
    /** The channel bubble id, when this turn was already drawn before persistence. */
    id?: string;
    text: string;
    attachments?: SessionAttachment[];
    location?: ChatLocation;
    transcripts?: Record<string, string>;
    from?: { sessionId: string; label: string };
  }): UserEntry {
    const entry = this.entries.append<UserEntry>({
      type: "user",
      prompt: true,
      text: input.text,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.transcripts && Object.keys(input.transcripts).length > 0 ? { transcripts: input.transcripts } : {}),
      ...(input.from ? { from: input.from } : {}),
    }, input.id);
    this.startLeaf = entry.id;
    return entry;
  }

  /**
   * What the model produced in one call: one entry per phase.
   *
   * The cuts are kept because the live stream closes a bubble whenever thinking follows text, and
   * a reopened conversation that glued them back together stacked every thought above prose they
   * were not about. `promptOf` folds them back for the provider, which has no slot for them.
   *
   * Opaque provider state rides on the last phase alone, and only when the turn came back whole.
   * A cut turn can carry a half-formed reasoning item, and handing that back is how a signed chain
   * gets refused for the rest of the run -- docs/reasoning-replay.md.
   */
  turn(recorded: RecordedTurn): PhaseEntry[] {
    const phases: RecordedPhase[] = recorded.segments?.length
      ? recorded.segments
      : [{ content: recorded.content, ...(recorded.reasoning ? { reasoning: recorded.reasoning } : {}) }];
    const replayable = recorded.providerMeta && !recorded.incomplete ? recorded.providerMeta : undefined;

    // The ids of the bubbles this turn was streamed into, so a phase and the bubble holding its
    // text are one identity -- docs/bubble-identity.md. Used only when there are exactly as many
    // as there are phases: a segment can hold thinking that never becomes prose, and pairing by
    // position through a mismatch would give a phase the id of a bubble holding something else,
    // which is worse than two ids. A turn that does not line up keeps the ids the log mints.
    const bubbles = takeRunBubbles(this.entries.sessionId);
    const ids = bubbles.length === phases.length ? bubbles : [];

    return phases.map((phase, index) => {
      const last = index === phases.length - 1;
      return this.entries.append<PhaseEntry>({
        type: "phase",
        prompt: true,
        text: phase.content,
        ...(phase.reasoning ? { reasoning: phase.reasoning } : {}),
        // One number for the whole turn: repeated per phase, every reader adding them up would
        // multiply what the model actually thought.
        ...(last && recorded.reasoningTokens ? { reasoningTokens: recorded.reasoningTokens } : {}),
        runId: this.currentTurnId,
        ...(last && replayable ? { providerMeta: replayable } : {}),
      }, ids[index]);
    });
  }

  /**
   * A tool call that has settled, with its result.
   *
   * Awaits the spill, unlike the append itself: the entry names a file, and an entry pointing at a
   * file that does not exist yet is the one state the card's see-all button cannot recover from.
   */
  async tool(call: RecordedToolCall): Promise<RecordedTool> {
    const spilled = await spillToolOutput(this.entries.sessionId, call.callId, call.output);
    const entry = this.entries.append<ToolEntry>({
      type: "tool",
      prompt: true,
      callId: call.callId,
      name: call.name,
      args: parseArguments(call.arguments),
      output: spilled.output,
      ...(spilled.outputPath ? { outputPath: spilled.outputPath } : {}),
      truncated: spilled.truncated,
      ok: call.ok,
      ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
      // No sub-agent state here, and it is not an omission: a `spawn` returns while its child runs,
      // so this entry is written before there is anything terminal to record. `spawn_state` entries
      // carry the lifecycle -- src/sessions/spawn-state.ts.
      runId: this.currentTurnId,
    });
    return { entry, message: spilled.message };
  }

  /** A slash command and the answer the owner was shown. Never part of a prompt. */
  command(input: string, output: string, details?: string): Entry {
    return this.entries.append({ type: "command", prompt: false, input, output, ...(details ? { details } : {}) });
  }

  /** Why a run died. Display-only: stored as an assistant turn it would come back as the agent's own words. */
  failure(error: string): Entry {
    return this.entries.append({ type: "failure", prompt: false, error });
  }

  /**
   * Rewinds to where this run started, keeping everything it wrote.
   *
   * The old loop truncated the array, which destroyed the turn. A branch leaves it on disk and
   * reachable: that is what makes the abandoned attempt a sibling of the retry rather than
   * something that was overwritten by it, and it is why `/retry` and `/undo` cost nothing extra.
   *
   * The dead branch is coherent on its own terms because a tool entry is only ever written once
   * its call settled: there is no request on it that nothing answers.
   */
  rewind(): void {
    this.entries.branch(this.startLeaf);
  }

  /** Where the conversation stood before this run. What `/retry` branches back to. */
  origin(): string | null {
    return this.startLeaf;
  }
}
