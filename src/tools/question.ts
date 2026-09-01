/**
 * The `question` tool: blocks the run and asks the owner, choice by choice.
 *
 * Mirrors opencode's question tool: an array of questions, each with a short header, a
 * question, options (label + description), `multiple` (any number of choices) and `custom`
 * (a free-form answer is offered in the sheet). The answers come back as an array of arrays
 * of labels, one per question, in the order asked.
 *
 * The distinction that matters here: **cancel is an outcome, not an error.** The owner may
 * cancel by pressing Stop while a question is pending, or by typing a message instead of
 * answering. Both resolve the tool and the run continues -- the message is injected as the
 * next user turn. Returning an error would abort the whole run and lose the steering.
 */

import { type Tool, type ToolResult } from "./types.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import { questionManager, type QuestionInfo, type QuestionOption } from "../questions/manager.ts";
import { rethrowIfAborted } from "../core/aborted.ts";

/** Display constraints, matching what opencode's schema enforces on its side. */
const MAX_OPTIONS = 12;
const MAX_HEADER = 30;
const MAX_QUESTIONS = 6;

function parseQuestions(raw: unknown): QuestionInfo[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "questions must be a non-empty array";
  if (raw.length > MAX_QUESTIONS) return `at most ${MAX_QUESTIONS} questions at once`;

  const out: QuestionInfo[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (typeof item !== "object" || item === null) return "each question must be an object";
    const question = item.question;
    const header = item.header;
    const options = item.options;
    if (typeof question !== "string" || question.trim().length === 0) {
      return "each question needs a non-empty question string";
    }
    if (typeof header !== "string" || header.trim().length === 0) {
      return "each question needs a header (max 30 chars)";
    }
    if (!Array.isArray(options) || options.length === 0 || options.length > MAX_OPTIONS) {
      return `each question needs 1-${MAX_OPTIONS} options`;
    }
    const parsedOptions: QuestionOption[] = [];
    for (const option of options as Array<Record<string, unknown>>) {
      if (typeof option !== "object" || option === null || typeof option.label !== "string" || option.label.trim().length === 0) {
        return "each option needs a label";
      }
      parsedOptions.push({
        label: option.label.trim(),
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      });
    }
    out.push({
      question: question.trim(),
      header: header.trim().slice(0, MAX_HEADER),
      options: parsedOptions,
      ...(item.multiple === true ? { multiple: true } : {}),
      ...(item.custom === false ? { custom: false } : {}),
    });
  }
  return out;
}

function formatOutput(questions: QuestionInfo[], answers: string[][] | null): string {
  if (answers === null) {
    return "User canceled the questions. Do not ask again; proceed without the answers.";
  }
  const pairs = questions
    .map((q, i) => `"${q.header}"="${(answers[i] ?? []).length ? answers[i]!.join(", ") : "Unanswered"}"`)
    .join(", ");
  return `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`;
}

export const createQuestionTool = (): Tool => ({
  name: "question",
  description:
    "Ask the user questions during execution and wait for their answers. Use it to gather preferences, clarify ambiguous instructions, or get decisions on implementation choices. " +
    "Pass an array of questions; each has a short header, the question text, 2-12 options (label + optional description), and optionally multiple=true (several choices) or custom=false (no free-form answer). " +
    "Answers come back as arrays of labels, one per question. If the user cancels, proceed without the answers and do not ask again.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "Questions to ask the user",
        items: {
          type: "object",
          properties: {
            header: { type: "string", description: "Very short label (max 30 chars)" },
            question: { type: "string", description: "Complete question" },
            options: {
              type: "array",
              description: "Available choices",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Display text" },
                  description: { type: "string", description: "Explanation of choice" },
                },
                required: ["label"],
              },
            },
            multiple: { type: "boolean", description: "Allow selecting multiple choices" },
            custom: { type: "boolean", description: "Allow typing a custom answer (default: true)" },
          },
          required: ["header", "question", "options"],
        },
      },
    },
    required: ["questions"],
  },
  async execute(args): Promise<ToolResult> {
    const message = args["__message"] as UnifiedMessage | undefined;
    const sessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
    const threadId = typeof message?.threadId === "string" ? message.threadId : "";
    const signal = args["__signal"] as AbortSignal | undefined;

    if (!questionManager.hasSurface()) {
      return { success: false, output: "", error: "No channel surface to ask questions on" };
    }

    const parsed = parseQuestions(args["questions"]);
    if (typeof parsed === "string") {
      return { success: false, output: "", error: `Invalid questions: ${parsed}` };
    }

    try {
      const outcome = await questionManager.ask({
        sessionId,
        owner: message?.chatId ?? "",
        threadId,
        questions: parsed,
        signal,
        ...(typeof args["__toolCallId"] === "string" ? { replyToId: args["__toolCallId"] } : {}),
      });
      if (signal?.aborted) rethrowIfAborted(new Error("aborted"), signal);
      return {
        success: true,
        output: formatOutput(parsed, outcome.kind === "answered" ? outcome.answers : null),
      };
    } catch (e) {
      rethrowIfAborted(e, signal);
      return { success: false, output: "", error: String(e) };
    }
  },
});
