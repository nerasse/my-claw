/**
 * A pending question, as the app is shown it.
 *
 * One builder for the two paths that carry the same thing: the `question.ask` broadcast the moment
 * the tool asks, and the `question.pending` list handed to every socket that connects. A device
 * that was offline, a second surface, or a server restart therefore converge on the same card --
 * see docs/my-claw-app-channel.md.
 */

import type { PendingQuestion } from "../../questions/manager.ts";
import {
  toolCardId,
  type MyClawAppQuestionAsk,
  type MyClawAppQuestionInfo,
  type MyClawAppQuestionPending,
  type MyClawAppQuestionPendingEntry,
} from "./types.ts";

function questionInfo(question: PendingQuestion): MyClawAppQuestionInfo[] {
  return question.questions.map((q) => ({
    header: q.header,
    question: q.question,
    options: q.options.map((o) => ({
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    })),
    ...(q.multiple ? { multiple: true } : {}),
    ...(q.custom === false ? { custom: false } : {}),
  }));
}

export function questionEntry(question: PendingQuestion): MyClawAppQuestionPendingEntry {
  // The card id, not the model's raw call id: the app draws the form inside the running tool card
  // the ask belongs to, and `t-<callId>` is the id that card carries.
  const card = toolCardId(question.replyToId);
  return {
    id: question.id,
    threadId: question.threadId,
    questions: questionInfo(question),
    ...(card ? { replyToId: card } : {}),
    ts: new Date(question.requestedAt).toISOString(),
  };
}

export function questionAskFrame(question: PendingQuestion): MyClawAppQuestionAsk {
  return { type: "question.ask", ...questionEntry(question) };
}

/** Every question of one owner still waiting. Empty is meaningful: it clears the client's set. */
export function questionPendingFrame(questions: PendingQuestion[]): MyClawAppQuestionPending {
  return { type: "question.pending", entries: questions.map(questionEntry) };
}
