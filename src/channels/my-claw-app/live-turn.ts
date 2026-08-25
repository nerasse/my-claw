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
}

export class LiveTurnJournal {
  private journals = new Map<string, Journal>();

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

  /**
   * What a window that missed the turn needs, in the order it was sent. The pending approvals come
   * last: the sheet belongs on top of the thread it interrupted, not before it.
   */
  replay(owner: string, threadId: string): MyClawAppServerFrame[] {
    const journal = this.journals.get(this.key(owner, threadId));
    if (!journal) return [];
    const frames = journal.frames.map((frame) =>
      isToolOutput(frame) && journal.clipped.has(frame.id) ? { ...frame, clipped: true } : frame,
    );
    return [...frames, ...journal.approvals.values()];
  }

  /** Test seam: how many frames a thread is holding. */
  size(owner: string, threadId: string): number {
    return this.journals.get(this.key(owner, threadId))?.frames.length ?? 0;
  }
}
