import type { MyClawAppServerFrame } from "./types.ts";

/**
 * The turn in flight, kept replayable for as long as it is in flight -- docs/live-turn-replay.md.
 *
 * A session entry is written when what it describes settles, so the persisted thread holds nothing
 * of the bubble being written into or the tool still running; and the frames that showed them went
 * to the sockets connected at that instant and nowhere else. A window that reloads mid-run
 * therefore came back to a hole. This holds those frames so `session.sync` can replay them after
 * the delta.
 *
 * It stores frames, not a summary: replaying what was sent means the client applies them through
 * the paths it already has, and a replayed turn converges with a watched one.
 *
 * **It holds only what the store cannot know yet.** A bubble that closed and a tool that settled
 * are dropped on the spot, because they are on their way into the session and the delta is what
 * serves them. Keeping them would show the prose of the run twice: a persisted phase and a live
 * bubble do not share an id (a user turn does, a phase does not yet), so the client cannot dedupe
 * them, and a duplicate on screen is permanent while the gap this trades for lasts milliseconds.
 */

/** Total live tool output kept per thread. Past this the oldest is dropped, head first. */
const OUTPUT_BUDGET_BYTES = 256 * 1024;

type ToolDelta = Extract<MyClawAppServerFrame, { type: "chat.tool.delta" }>;
type StreamDelta = Extract<MyClawAppServerFrame, { type: "chat.stream.delta" }>;
type ReasoningDelta = Extract<MyClawAppServerFrame, { type: "chat.reasoning.delta" }>;
type AnyDelta = ToolDelta | StreamDelta | ReasoningDelta;

/**
 * The frames that carry a fragment of something bigger. Replaying them one by one is what made a
 * reconnecting window paint the turn twice: the client keeps the bubble it was already watching,
 * so a second pass of chunks lands on top of the text it already holds.
 */
function isDelta(frame: MyClawAppServerFrame): frame is AnyDelta {
  return (
    frame.type === "chat.stream.delta" ||
    frame.type === "chat.tool.delta" ||
    frame.type === "chat.reasoning.delta"
  );
}

/** Two chunks of the same subject, as one. */
function mergeDelta(into: AnyDelta, next: AnyDelta): AnyDelta {
  if (into.type === "chat.tool.delta" && next.type === "chat.tool.delta") {
    return { ...into, stdout: into.stdout + next.stdout, stderr: into.stderr + next.stderr };
  }
  if (into.type !== "chat.tool.delta" && next.type !== "chat.tool.delta") {
    return { ...into, text: into.text + next.text };
  }
  return into;
}

/** Frames that carry a tool's live output: the only ones that can grow without limit. */
function isToolOutput(frame: MyClawAppServerFrame): frame is ToolDelta {
  return frame.type === "chat.tool.delta";
}

function outputSize(frame: ToolDelta): number {
  return frame.stdout.length + frame.stderr.length;
}

/**
 * The bubble or card a frame belongs to, when it belongs to one. A frame with no id is kept for
 * the whole run: those are the annotations (a spawn's state), they are tiny, and they are applied
 * by the card they name rather than by themselves.
 */
function subjectOf(frame: MyClawAppServerFrame): string | null {
  switch (frame.type) {
    case "chat.stream.start":
    case "chat.stream.delta":
    case "chat.stream.done":
    case "chat.stream.abort":
    case "chat.reasoning.delta":
    case "chat.reasoning.tokens":
    case "chat.tool.start":
    case "chat.tool.delta":
    case "chat.tool":
      return frame.id;
    default:
      return null;
  }
}

/** Frames that mean "this subject is settled, the store owns it now". */
function settles(frame: MyClawAppServerFrame): boolean {
  return frame.type === "chat.stream.done" || frame.type === "chat.stream.abort" || frame.type === "chat.tool";
}

interface Journal {
  frames: MyClawAppServerFrame[];
  /** Bytes of tool output currently held, so the budget is a subtraction and not a rescan. */
  outputBytes: number;
  /** Cards whose earliest output was dropped: their replay says so instead of lying by omission. */
  clipped: Set<string>;
  /** Pending approval requests, by frame id: a question still waiting for its answer. */
  approvals: Map<string, MyClawAppServerFrame>;
  /** Pending question sheets, by frame id: the run is waiting on the owner. */
  questions: Map<string, MyClawAppServerFrame>;
}

export class LiveTurnJournal {
  private journals = new Map<string, Journal>();

  /**
   * A compaction in flight, held outside the journals because it is not part of a turn: `/compact`
   * is a command, not a run, so there is no journal open for it and there is nothing to open one
   * from. It is exactly the case this class exists for -- minutes of silence a reloading window
   * cannot reconstruct from the store -- so it gets its own slot rather than a fake run.
   */
  private compactions = new Map<string, MyClawAppServerFrame>();

  private key(owner: string, threadId: string): string {
    return `${owner}\u0000${threadId}`;
  }

  /** A run started on this thread: whatever a previous one left is not this turn. */
  open(owner: string, threadId: string): void {
    this.journals.set(this.key(owner, threadId), {
      frames: [],
      outputBytes: 0,
      clipped: new Set(),
      approvals: new Map(),
      questions: new Map(),
    });
  }

  /**
   * The run ended: its content is in the session now, and the store is the one truth for anything
   * settled. Keeping the journal past the end would give the same turn two writers.
   */
  close(owner: string, threadId: string): void {
    this.journals.delete(this.key(owner, threadId));
  }

  /**
   * One frame of the turn. Recording is unconditional on purpose: the streamer's `send` is the
   * single door every frame goes through, so there is no list of types to keep in sync with it.
   */
  record(owner: string, threadId: string, frame: MyClawAppServerFrame): void {
    const journal = this.journals.get(this.key(owner, threadId));
    // No open journal means no run was announced for this thread: nothing to replay into.
    if (!journal) return;

    if (settles(frame)) {
      this.forget(journal, subjectOf(frame));
      return;
    }
    journal.frames.push(frame);
    if (isToolOutput(frame)) {
      journal.outputBytes += outputSize(frame);
      this.trim(journal);
    }
  }

  /** Everything held for one bubble or card: it settled, and the session serves it from now on. */
  private forget(journal: Journal, subject: string | null): void {
    if (subject === null) return;
    journal.frames = journal.frames.filter((frame) => {
      if (subjectOf(frame) !== subject) return true;
      if (isToolOutput(frame)) journal.outputBytes -= outputSize(frame);
      return false;
    });
    journal.clipped.delete(subject);
  }

  /**
   * Drops the oldest tool output until the budget holds. Prose is never dropped: a turn's text is
   * small and it is the part a reader would miss most. A card that lost its head is remembered, so
   * its replay is flagged clipped rather than quietly short.
   */
  private trim(journal: Journal): void {
    if (journal.outputBytes <= OUTPUT_BUDGET_BYTES) return;
    const kept: MyClawAppServerFrame[] = [];
    for (const frame of journal.frames) {
      if (journal.outputBytes > OUTPUT_BUDGET_BYTES && isToolOutput(frame)) {
        journal.outputBytes -= outputSize(frame);
        journal.clipped.add(frame.id);
        continue;
      }
      kept.push(frame);
    }
    journal.frames = kept;
  }

  /** An approval sheet was asked for: it is a question, and it stands until answered. */
  recordApproval(owner: string, threadId: string, id: string, frame: MyClawAppServerFrame): void {
    const journal = this.journals.get(this.key(owner, threadId));
    if (!journal) return;
    journal.approvals.set(id, frame);
  }

  /** Answered, expired or refused: replaying it would ask a question that has no answer left. */
  resolveApproval(owner: string, threadId: string, id: string): void {
    this.journals.get(this.key(owner, threadId))?.approvals.delete(id);
  }

  /** A question sheet was asked for: it stands until answered or canceled. */
  recordQuestion(owner: string, threadId: string, id: string, frame: MyClawAppServerFrame): void {
    const journal = this.journals.get(this.key(owner, threadId));
    if (!journal) return;
    journal.questions.set(id, frame);
  }

  /** Answered or canceled: replaying it would ask a question that has no answer left. */
  resolveQuestion(owner: string, threadId: string, id: string): void {
    this.journals.get(this.key(owner, threadId))?.questions.delete(id);
  }

  /** A compaction began on this thread: it stands until it settles, run or no run. */
  markCompacting(owner: string, threadId: string, frame: MyClawAppServerFrame): void {
    this.compactions.set(this.key(owner, threadId), frame);
  }

  /** Settled, whatever the outcome: a replay of it would show an operation that is over. */
  clearCompacting(owner: string, threadId: string): void {
    this.compactions.delete(this.key(owner, threadId));
  }

  /**
   * What a window that missed the turn needs, in the order it was sent. The pending approvals come
   * last: the sheet belongs on top of the thread it interrupted, not before it.
   */
  replay(owner: string, threadId: string): MyClawAppServerFrame[] {
    const key = this.key(owner, threadId);
    // A compaction outlives the run that triggered it and can exist without one at all, so it is
    // replayed on its own: a window that reloads during a `/compact` has no journal to read.
    const compacting = this.compactions.get(key);
    const tail = compacting ? [compacting] : [];
    const journal = this.journals.get(key);
    if (!journal) return tail;

    // One delta per subject, carrying everything held for it and flagged `replay` so the client
    // replaces rather than appends. It sits where the first chunk sat, so the order the window
    // sees is still the order the turn happened in.
    const frames: MyClawAppServerFrame[] = [];
    const mergedAt = new Map<string, number>();
    for (const frame of journal.frames) {
      const marked =
        isToolOutput(frame) && journal.clipped.has(frame.id) ? { ...frame, clipped: true } : frame;
      if (!isDelta(marked)) {
        frames.push(marked);
        continue;
      }
      const subject = `${marked.type}\u0000${marked.id}`;
      const at = mergedAt.get(subject);
      if (at === undefined) {
        mergedAt.set(subject, frames.length);
        frames.push({ ...marked, replay: true });
        continue;
      }
      frames[at] = mergeDelta(frames[at] as AnyDelta, marked);
    }

    return [...frames, ...tail, ...journal.approvals.values(), ...journal.questions.values()];
  }

  /** Test seam: how many frames a thread is holding. */
  size(owner: string, threadId: string): number {
    return this.journals.get(this.key(owner, threadId))?.frames.length ?? 0;
  }
}
