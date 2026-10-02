/**
 * Pending undo requests, one at a time per session, resolved by the owner.
 *
 * A `/undo` without an argument opens a choice: conversation only, or conversation plus files.
 * The channel (my-claw-app) broadcasts an `undo.prompt` and the owner answers with `undo.choose`.
 * The design mirrors the question flow with one deliberate difference: no run is blocked here.
 * The run that produced the turn already finished (or is aborted first); the choice only decides
 * how far back the undo goes.
 *
 * Like questions, no timeout is imposed by the manager: a sheet left open is the owner's
 * decision, not a stale prompt. The channel owns a display timeout if one is needed.
 */

import { randomUUID } from "node:crypto";

export interface UndoDiffEntry {
  root: string;
  /** Files that differ: a binary or an emptied file is one, at +0/-0. */
  files: number;
  additions: number;
  deletions: number;
}

export type UndoMode = "soft" | "hard";

export interface PendingUndo {
  id: string;
  sessionId: string;
  owner: string;
  threadId: string;
  /** What the choice would restore, precomputed at prompt time for the sheet. */
  diff: UndoDiffEntry[];
  /** The preview of the user turn being undone. */
  turnPreview: string;
  requestedAt: number;
}

export type UndoOutcome = { kind: "chosen"; mode: UndoMode } | { kind: "canceled" };

interface PendingEntry {
  undo: PendingUndo;
  resolve: (outcome: UndoOutcome) => void;
}

export interface UndoPromptHandler {
  (undo: PendingUndo): void;
}

/** One manager per process. The handler is set once, by the channel adapter; a `/undo` command
 *  talks to the manager through `prompt`, and the channel through `choose`/`cancel`.
 *
 *  The prompt is a decision the owner might never take (app killed, old client without the sheet,
 *  sheet dismissed offline). A command handler is a long-lived await, so the manager settles a
 *  prompt on its own after `PROMPT_TIMEOUT_MS`: the undo is dropped, nothing runs, and the
 *  command answers "Undo annulé." -- the same fate an approval timeout has, without the journal.
 */
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

export class UndoManager {
  private pending = new Map<string, PendingEntry>();

  constructor(private handler?: UndoPromptHandler) {}

  setHandler(handler: UndoPromptHandler | undefined): void {
    this.handler = handler;
  }

  /** Opens the choice and waits for the owner's selection or a cancel.
   *  `signal` is the run's abort (an undo issued while a run turns) — dropping the pending entry
   *  on abort avoids a card with nothing behind it, same as the question flow. */
  prompt(input: {
    sessionId: string;
    owner: string;
    threadId: string;
    diff: UndoDiffEntry[];
    turnPreview: string;
    signal?: AbortSignal;
  }): Promise<UndoOutcome> {
    const undo: PendingUndo = {
      id: `undo_${randomUUID()}`,
      sessionId: input.sessionId,
      owner: input.owner,
      threadId: input.threadId,
      diff: input.diff,
      turnPreview: input.turnPreview,
      requestedAt: Date.now(),
    };
    let onAbort: (() => void) | undefined;
    let closed = false;
    const promise = new Promise<UndoOutcome>((resolve) => {
      const done = (outcome: UndoOutcome): void => {
        closed = true;
        if (onAbort) input.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      this.pending.set(undo.id, { undo, resolve: done });
      onAbort = () => {
        const entry = this.pending.get(undo.id);
        if (!entry) return;
        this.pending.delete(undo.id);
        done({ kind: "canceled" });
      };
      if (input.signal?.aborted) {
        onAbort();
      } else {
        input.signal?.addEventListener("abort", onAbort, { once: true });
      }
      // A sheet nobody answers (old client, killed app, offline tap) must not hold a command
      // handler forever: settle it after the timeout, same as an approval prompt.
      setTimeout(onAbort, PROMPT_TIMEOUT_MS).unref?.();
    });
    if (!closed) {
      this.handler?.(undo);
    }
    return promise;
  }

  /** The owner chose a mode. Returns the undo when closed. */
  choose(id: string, mode: UndoMode): PendingUndo | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    entry.resolve({ kind: "chosen", mode });
    return entry.undo;
  }

  /** Cancels: the owner dismissed the sheet. Returns the undo when closed. */
  cancel(id: string): PendingUndo | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    entry.resolve({ kind: "canceled" });
    return entry.undo;
  }

  /** One open undo of a session, if any. */
  ofSession(sessionId: string): PendingUndo | undefined {
    for (const { undo } of this.pending.values()) {
      if (undo.sessionId === sessionId) return undo;
    }
    return undefined;
  }

  /** Everything a window is handed when it connects, so a reloaded app still sees the card. */
  list(): PendingUndo[] {
    return Array.from(this.pending.values(), ({ undo }) => undo);
  }

  /** Test/reset seam: drops everything, as if every owner had dismissed it. */
  clear(): void {
    for (const { resolve } of this.pending.values()) resolve({ kind: "canceled" });
    this.pending.clear();
  }
}

export const undoManager = new UndoManager();
