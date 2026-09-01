/**
 * Pending questions asked by the `question` tool, one per run, resolved by the owner.
 *
 * The tool blocks until an answer arrives: the LLM turn cannot proceed without the user's
 * choices, so a question is a long-lived pending object the channel (my-claw-app) broadcasts
 * and the owner answers from a card drawn in the conversation. The design mirrors the approval
 * flow --
 * docs/my-claw-app-channel.md -- with two deliberate differences:
 *
 * - No timeout. opencode's question never expires either: a question the owner has not
 *   answered is not a stale prompt, it is a run waiting on a person. The only exits are an
 *   answer, a cancel (Stop, or a message typed while a question is pending), or the run going
 *   away (aborted), which cancels everything of that session on the spot.
 * - A cancel is an outcome, not an error. The tool returns "User canceled the questions" and
 *   the run continues; aborting on cancel would throw away the steering the owner just typed.
 */

import { randomUUID } from "node:crypto";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** What the app is shown and what the owner answers. */
export type QuestionOutcome =
  | { kind: "answered"; answers: string[][] }
  | { kind: "canceled" };

export interface PendingQuestion {
  id: string;
  sessionId: string;
  owner: string;
  threadId: string;
  questions: QuestionInfo[];
  /** The bubble the tool call sits on, when the channel told us. */
  replyToId?: string;
  requestedAt: number;
}

interface PendingEntry {
  question: PendingQuestion;
  resolve: (outcome: QuestionOutcome) => void;
}

export interface QuestionHandler {
  /** Broadcasts one question to every reachable surface of the owner (app + web). */
  (question: PendingQuestion): void;
}

/** Called right after a question is asked; the server uses it to push a notification. */
export type QuestionNotifier = (question: PendingQuestion) => void;

/**
 * One manager per process. The handler is set once, by the channel adapter; a run talks to
 * the manager through the tool's execute, and the channel through reply/cancel.
 */
export class QuestionManager {
  private pending = new Map<string, PendingEntry>();

  constructor(private handler?: QuestionHandler, private notifier?: QuestionNotifier) {}

  setHandler(handler: QuestionHandler | undefined): void {
    this.handler = handler;
  }

  setNotifier(notifier: QuestionNotifier | undefined): void {
    this.notifier = notifier;
  }

  /** Asks and blocks until an answer or a cancel. Never resolves on its own.
   *  `signal` is the run's abort: the pending entry is dropped on abort (the tool then reports
   *  the abort), so a killed run never leaves a card with no run behind it. */
  ask(input: {
    sessionId: string;
    owner: string;
    threadId: string;
    questions: QuestionInfo[];
    replyToId?: string;
    signal?: AbortSignal;
  }): Promise<QuestionOutcome> {
    const question: PendingQuestion = {
      id: `que_${randomUUID()}`,
      sessionId: input.sessionId,
      owner: input.owner,
      threadId: input.threadId,
      questions: input.questions,
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      requestedAt: Date.now(),
    };
    let onAbort: (() => void) | undefined;
    let closed = false;
    const promise = new Promise<QuestionOutcome>((resolve) => {
      const done = (outcome: QuestionOutcome): void => {
        closed = true;
        if (onAbort) input.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      this.pending.set(question.id, { question, resolve: done });
      onAbort = () => {
        const entry = this.pending.get(question.id);
        if (!entry) return;
        this.pending.delete(question.id);
        done({ kind: "canceled" });
      };
      if (input.signal?.aborted) {
        // An already-aborted signal never fires the event; the listener above would hang.
        onAbort();
      } else {
        input.signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
    // The channel sees it only after it is answerable: the broadcast is the moment a card can
    // open. A run that was already aborted must not broadcast: the promise above resolved as
    // canceled, and a card with no run behind it is a button that answers nothing.
    if (!closed) {
      this.handler?.(question);
      this.notifier?.(question);
    }
    return promise;
  }

  /** Answers with one array of selections per question. Returns the question when closed. */
  reply(id: string, answers: string[][]): PendingQuestion | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    entry.resolve({ kind: "answered", answers });
    return entry.question;
  }

  /** Cancels: the run keeps going, the tool reports the cancel. Returns the question when closed. */
  cancel(id: string): PendingQuestion | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    entry.resolve({ kind: "canceled" });
    return entry.question;
  }

  /** One open question of a session, if any. */
  ofSession(sessionId: string): PendingQuestion | undefined {
    for (const { question } of this.pending.values()) {
      if (question.sessionId === sessionId) return question;
    }
    return undefined;
  }

  /** Everything a window is handed when it connects, so a reloaded app still sees the card. */
  list(): PendingQuestion[] {
    return Array.from(this.pending.values(), ({ question }) => question);
  }

  /** The session went away (abort, run end): every question it held is canceled. */
  cancelBySession(sessionId: string): boolean {
    let any = false;
    for (const { question, resolve } of this.pending.values()) {
      if (question.sessionId !== sessionId) continue;
      this.pending.delete(question.id);
      resolve({ kind: "canceled" });
      any = true;
    }
    return any;
  }

  /** Test/reset seam: drops everything, as if every run had gone away. */
  clear(): void {
    for (const { resolve } of this.pending.values()) resolve({ kind: "canceled" });
    this.pending.clear();
  }

  /** Whether anything would see a question at all; the tool refuses otherwise. */
  hasSurface(): boolean {
    return this.handler !== undefined;
  }
}

export const questionManager = new QuestionManager();
