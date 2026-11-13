/**
 * Pending undo requests, resolved by the owner.
 *
 * Two sheets, one manager: `/undo` without a mode asks how far back (conversation only, or
 * conversation plus files), and `/undo list` asks which turn. The channel (my-claw-app) broadcasts
 * the frame and the owner answers with `undo.choose`. The design mirrors the question flow with
 * one deliberate difference: no run is blocked here. The run that produced the turn already
 * finished (or is aborted first); the choice only decides what the undo does.
 *
 * Like questions, no timeout is imposed by the owner's absence: a sheet left open is their
 * decision, not a stale prompt. What the timeout below guards is the *command handler*, which is
 * a long-lived await a sheet nobody answers would otherwise hold forever.
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

/** One row of `/undo list`, as the picker draws it. Built by the command, carried verbatim. */
export interface UndoListRow {
  n: number;
  preview: string;
  ts: number;
  attachments: number;
  transcripts: number;
  hard: boolean;
  compaction?: boolean;
}

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

export interface PendingUndoList {
  id: string;
  sessionId: string;
  owner: string;
  threadId: string;
  turns: UndoListRow[];
  requestedAt: number;
}

export type UndoOutcome = { kind: "chosen"; mode: UndoMode } | { kind: "canceled" };
export type UndoListOutcome = { kind: "chosen"; n: number; mode: UndoMode } | { kind: "canceled" };

/** The mode sheet, handled by the channel. */
export interface UndoPromptHandler {
  (undo: PendingUndo): void;
}

/** The turn picker, handled by the channel like the mode sheet. */
export interface UndoListPromptHandler {
  (list: PendingUndoList): void;
}

/**
 * One open sheet of a session: the payload the channel draws, and the one way to settle it.
 *
 * Every closer (a choice, a cancel, the timeout, an aborted run) goes through `close`, so a sheet
 * is answered exactly once whichever arrives first, and a late second answer is a no-op.
 */
interface Sheet<P, O> {
  payload: P;
  close: (outcome: O) => void;
}

const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

export class UndoManager {
  private modes = new Map<string, Sheet<PendingUndo, UndoOutcome>>();
  private pickers = new Map<string, Sheet<PendingUndoList, UndoListOutcome>>();

  constructor(
    private handler?: UndoPromptHandler,
    private listHandler?: UndoListPromptHandler,
  ) {}

  setHandler(handler: UndoPromptHandler | undefined): void {
    this.handler = handler;
  }

  setListHandler(handler: UndoListPromptHandler | undefined): void {
    this.listHandler = handler;
  }

  /** Opens the mode choice and waits for the owner's selection or a cancel. */
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
    return this.open(this.modes, undo, input.signal, () => this.handler?.(undo));
  }

  /**
   * Opens the turn picker: the owner picks a row, and that row IS the answer (n and mode).
   *
   * Same timeout and same abort handling as the mode sheet, deliberately: a picker nobody answers
   * must settle the command handler exactly like a mode sheet nobody answers does.
   */
  promptList(input: {
    sessionId: string;
    owner: string;
    threadId: string;
    turns: UndoListRow[];
    signal?: AbortSignal;
  }): Promise<UndoListOutcome> {
    const list: PendingUndoList = {
      id: `undo_${randomUUID()}`,
      sessionId: input.sessionId,
      owner: input.owner,
      threadId: input.threadId,
      turns: input.turns,
      requestedAt: Date.now(),
    };
    return this.open(this.pickers, list, input.signal, () => this.listHandler?.(list));
  }

  /**
   * The three things every sheet owes, in one place.
   *
   * A sheet nobody answers (old client, killed app, offline tap) must not hold a command handler
   * forever, and an aborted run must not leave a card behind with nothing to close it. `close` is
   * idempotent through the map: the entry leaves it on the first settle, so a choice and a timeout
   * racing cannot both answer.
   *
   * The handler fires only if the sheet is still open after the wiring: a signal that was already
   * aborted settles the prompt before it is ever drawn.
   */
  private open<P extends { id: string }, O extends { kind: "canceled" }>(
    sheets: Map<string, Sheet<P, O>>,
    payload: P,
    signal: AbortSignal | undefined,
    fire: () => void,
  ): Promise<O> {
    let onAbort: (() => void) | undefined;
    const promise = new Promise<O>((resolve) => {
      const close = (outcome: O): void => {
        if (!sheets.has(payload.id)) return;
        sheets.delete(payload.id);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      sheets.set(payload.id, { payload, close });
      onAbort = () => close({ kind: "canceled" } as O);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      setTimeout(onAbort, PROMPT_TIMEOUT_MS).unref?.();
    });
    if (sheets.has(payload.id)) fire();
    return promise;
  }

  /** The owner chose a mode. Returns the sheet when closed. */
  choose(id: string, mode: UndoMode): PendingUndo | undefined {
    const sheet = this.modes.get(id);
    if (!sheet) return undefined;
    sheet.close({ kind: "chosen", mode });
    return sheet.payload;
  }

  /** The owner picked a row of the turn list. Returns the sheet when closed. */
  chooseList(id: string, n: number, mode: UndoMode): PendingUndoList | undefined {
    const sheet = this.pickers.get(id);
    if (!sheet) return undefined;
    sheet.close({ kind: "chosen", n, mode });
    return sheet.payload;
  }

  /** Cancels: the owner dismissed the sheet. Returns the sheet's payload when closed. */
  cancel(id: string): PendingUndo | PendingUndoList | undefined {
    const modeSheet = this.modes.get(id);
    if (modeSheet) {
      modeSheet.close({ kind: "canceled" });
      return modeSheet.payload;
    }
    const pickerSheet = this.pickers.get(id);
    if (!pickerSheet) return undefined;
    pickerSheet.close({ kind: "canceled" });
    return pickerSheet.payload;
  }

  /** One open sheet of a session, whichever kind. */
  ofSession(sessionId: string): PendingUndo | PendingUndoList | undefined {
    for (const { payload } of this.modes.values()) if (payload.sessionId === sessionId) return payload;
    for (const { payload } of this.pickers.values()) if (payload.sessionId === sessionId) return payload;
    return undefined;
  }

  /** Every open mode sheet, so a reloaded app still sees its card. */
  list(): PendingUndo[] {
    return Array.from(this.modes.values(), ({ payload }) => payload);
  }

  /** Every open turn picker, for the same replay. */
  lists(): PendingUndoList[] {
    return Array.from(this.pickers.values(), ({ payload }) => payload);
  }

  /** Test/reset seam: drops everything, as if every owner had dismissed it. */
  clear(): void {
    for (const sheet of [...this.modes.values()]) sheet.close({ kind: "canceled" });
    for (const sheet of [...this.pickers.values()]) sheet.close({ kind: "canceled" });
  }
}

export const undoManager = new UndoManager();
