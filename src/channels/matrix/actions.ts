import { MsgType } from "matrix-js-sdk";
import { buildMatrixFormattedText, prefixEditedMatrixFormattedBody } from "./format.ts";
import type { ConfirmationButton, OutgoingMessage } from "../types.ts";
import type { PendingMatrixAction } from "./types.ts";
import { buildReplaceRelation, trimString } from "./helpers.ts";

const KEYCAP_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

// Unicode has no keycap past ten, so the numbering continues with regional-indicator letters:
// A is option 11, Z is option 36. Reaction keys are arbitrary strings on Matrix, so the only
// requirement is that each option gets a distinct, typeable symbol. Built from code points rather
// than 26 literals to keep the letter/position mapping evident.
const REGIONAL_INDICATOR_A = 0x1f1e6;
const LETTER_EMOJIS = Array.from({ length: 26 }, (_, i) => String.fromCodePoint(REGIONAL_INDICATOR_A + i));

export const MATRIX_REACTION_BUTTON_EMOJIS = [...KEYCAP_EMOJIS, ...LETTER_EMOJIS];

export function extractReactionAnnotation(
  content: Record<string, unknown>,
): { eventId: string; key: string } | undefined {
  const relates = content["m.relates_to"];
  if (!relates || typeof relates !== "object") return undefined;
  const relation = relates as Record<string, unknown>;
  if (relation.rel_type !== "m.annotation") return undefined;

  const eventId = trimString(relation.event_id);
  const key = trimString(relation.key);
  if (!eventId || !key) return undefined;

  return { eventId, key };
}

export function resolveActionForReaction(buttons: ConfirmationButton[], key: string): string | undefined {
  const index = MATRIX_REACTION_BUTTON_EMOJIS.findIndex((emoji) => emoji === key);
  if (index < 0) return undefined;
  return buttons[index]?.action;
}

function normalizeActionSelectionText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveActionForTextReply(buttons: ConfirmationButton[], text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const indexMatch = /^\/?([1-9]\d*)(?:\b|\s|[.)-])/.exec(trimmed);
  if (indexMatch) {
    const index = Number(indexMatch[1]) - 1;
    return index >= 0 ? buttons[index]?.action : undefined;
  }

  // Options past the tenth are labelled with letters, so typing the letter you see must work.
  // A miss falls through to label matching instead of returning: on a menu too short to reach
  // that letter, a single-letter reply is far more likely to be a model label.
  const letterMatch = /^\/?([a-z])(?:\b|\s|[.)-])/i.exec(trimmed);
  if (letterMatch?.[1]) {
    const offset = letterMatch[1].toLowerCase().charCodeAt(0) - "a".charCodeAt(0);
    const index = MATRIX_REACTION_BUTTON_EMOJIS.indexOf(String.fromCodePoint(REGIONAL_INDICATOR_A + offset));
    const action = index >= 0 ? buttons[index]?.action : undefined;
    if (action) return action;
  }

  const normalized = normalizeActionSelectionText(trimmed);
  for (const button of buttons) {
    if (normalizeActionSelectionText(button.label) === normalized) {
      return button.action;
    }
  }

  return undefined;
}

export function rememberPendingAction(params: {
  pendingActions: Map<string, PendingMatrixAction>;
  roomId: string;
  eventId: string;
  buttons: ConfirmationButton[];
  threadId?: string;
  stateKey?: string;
  reactionEventIds?: string[];
  ttlMs: number;
  limit: number;
}): void {
  const key = pendingActionKey(params.roomId, params.eventId);
  if (params.buttons.length === 0) {
    params.pendingActions.delete(key);
    return;
  }

  prunePendingActions(params.pendingActions);
  params.pendingActions.set(key, {
    roomId: params.roomId,
    eventId: params.eventId,
    buttons: params.buttons,
    threadId: params.threadId,
    stateKey: params.stateKey,
    reactionEventIds: params.reactionEventIds,
    expiresAt: Date.now() + params.ttlMs,
  });

  while (params.pendingActions.size > params.limit) {
    const oldest = params.pendingActions.keys().next().value;
    if (typeof oldest !== "string") break;
    params.pendingActions.delete(oldest);
  }
}

export function resolvePendingAction(
  pendingActions: Map<string, PendingMatrixAction>,
  roomId: string,
  eventId: string,
): PendingMatrixAction | undefined {
  const key = pendingActionKey(roomId, eventId);
  const pending = pendingActions.get(key);
  if (!pending) return undefined;
  if (pending.expiresAt < Date.now()) {
    pendingActions.delete(key);
    return undefined;
  }
  return pending;
}

export function pendingActionKey(roomId: string, eventId: string): string {
  return `${roomId}:${eventId}`;
}

export function prunePendingActions(pendingActions: Map<string, PendingMatrixAction>): void {
  const now = Date.now();
  for (const [key, pending] of pendingActions.entries()) {
    if (pending.expiresAt < now) {
      pendingActions.delete(key);
    }
  }
}

export async function editPendingActionMessage(params: {
  sendMessage: (roomId: string, content: Record<string, unknown>) => Promise<void>;
  roomId: string;
  eventId: string;
  text: string;
  threadId?: string;
  notice?: boolean;
}): Promise<void> {
  const formatted = buildMatrixFormattedText(params.text);
  const msgtype = params.notice ? MsgType.Notice : MsgType.Text;
  const newContent: Record<string, unknown> = {
    msgtype,
    body: formatted.body,
  };
  if (formatted.formatted_body) {
    newContent["format"] = "org.matrix.custom.html";
    newContent["formatted_body"] = formatted.formatted_body;
  }
  if (formatted.mentions) {
    newContent["m.mentions"] = formatted.mentions;
  }

  const content: Record<string, unknown> = {
    msgtype,
    body: `* ${formatted.body}`,
    "m.new_content": newContent,
    "m.relates_to": buildReplaceRelation(params.eventId, params.threadId),
  };
  if (formatted.formatted_body) {
    content["format"] = "org.matrix.custom.html";
    content["formatted_body"] = prefixEditedMatrixFormattedBody(formatted.formatted_body);
  }
  if (formatted.mentions) {
    content["m.mentions"] = formatted.mentions;
  }

  await params.sendMessage(params.roomId, content);
}

export async function applyActionResponse(params: {
  pendingActions: Map<string, PendingMatrixAction>;
  roomId: string;
  eventId: string;
  threadId: string | undefined;
  stateKey?: string;
  response: { text?: string; buttons?: ConfirmationButton[]; answerText?: string; supersededText?: string };
  send: (chatId: string, message: OutgoingMessage) => Promise<void>;
  editPendingActionMessage: (params: {
    roomId: string;
    eventId: string;
    text: string;
    threadId?: string;
    notice?: boolean;
  }) => Promise<void>;
  redactReactions?: (roomId: string, eventIds: readonly string[]) => Promise<void>;
  ttlMs: number;
  limit: number;
}): Promise<void> {
  const key = pendingActionKey(params.roomId, params.eventId);
  const previousReactionIds = params.pendingActions.get(key)?.reactionEventIds ?? [];
  const cleanupReactions = async () => {
    if (previousReactionIds.length > 0) {
      await params.redactReactions?.(params.roomId, previousReactionIds).catch(() => undefined);
    }
  };

  // Next menu step: send a NEW message so the user gets fresh, untapped reactions
  // (re-reacting with an already-used emoji is impossible on an edited message, and the
  // seeded reaction count would no longer match the options). The old menu collapses to a
  // one-line breadcrumb and loses its numbered reactions.
  if (params.response.buttons?.length) {
    params.pendingActions.delete(key);
    await params.editPendingActionMessage({
      roomId: params.roomId,
      eventId: params.eventId,
      text: params.response.supersededText ?? "Menu continued below.",
      threadId: params.threadId,
      notice: params.stateKey === "approval",
    });
    await params.send(params.roomId, {
      text: params.response.text ?? "",
      buttons: params.response.buttons,
      threadId: params.threadId,
      stateKey: params.stateKey,
    });
    await cleanupReactions();
    return;
  }

  if (params.response.text?.trim()) {
    await params.editPendingActionMessage({
        roomId: params.roomId,
        eventId: params.eventId,
        text: params.response.text,
        threadId: params.threadId,
        notice: params.stateKey === "approval",
      });
  } else if (params.response.answerText?.trim()) {
    await params.send(params.roomId, {
      text: params.response.answerText,
      replyToId: params.eventId,
      threadId: params.threadId,
      notice: true,
    });
  }

  params.pendingActions.delete(key);
  await cleanupReactions();
}
