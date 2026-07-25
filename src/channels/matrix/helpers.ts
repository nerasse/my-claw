import type { Attachment } from "../types.ts";
import type { MatrixEventContent } from "./types.ts";
import { MsgType, RelationType, type MatrixEvent } from "matrix-js-sdk";

export function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveMatrixMessageAttachmentSummary(params: {
  body?: string;
  filename?: string;
  msgtype?: string;
  unavailable?: boolean;
  tooLarge?: boolean;
}): string | undefined {
  const kind = (() => {
    switch (params.msgtype) {
      case MsgType.Image:
        return "image";
      case MsgType.Audio:
        return "audio";
      case MsgType.Video:
        return "video";
      case MsgType.File:
        return "file";
      case "m.sticker":
        return "sticker";
      default:
        return undefined;
    }
  })();

  const marker = kind
    ? params.tooLarge
      ? `[matrix ${kind} attachment too large]`
      : params.unavailable
        ? `[matrix ${kind} attachment unavailable]`
        : `[matrix ${kind} attachment]`
    : undefined;
  const { caption, filename } = resolveMatrixCaptionAndFilename({
    body: params.body,
    filename: params.filename,
  });

  if (!marker) return caption ?? filename;
  if (caption) return `${caption}\n\n${marker}`;
  return marker;
}

function looksLikeMatrixFilename(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\n") || /\s/.test(trimmed)) {
    return false;
  }
  const basename = trimmed.split(/[\\/]/).at(-1) ?? trimmed;
  if (basename !== trimmed) {
    return false;
  }
  const dotIndex = trimmed.lastIndexOf(".");
  return dotIndex > 0 && trimmed.length - dotIndex > 1;
}

export function resolveMatrixCaptionAndFilename(params: {
  body?: string;
  filename?: string;
}): { caption?: string; filename?: string } {
  const body = trimString(params.body);
  const filename = trimString(params.filename);

  if (filename) {
    if (!body || body === filename) {
      return { filename };
    }
    return { caption: body, filename };
  }

  if (!body) {
    return {};
  }
  if (looksLikeMatrixFilename(body)) {
    return { filename: body };
  }
  return { caption: body };
}

export function extFromFilename(filename?: string): string {
  if (!filename) return "";
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return filename.slice(dotIndex);
}

export function normalizeMatrixUserId(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("@") || !trimmed.includes(":")) return trimmed.toLowerCase();

  const withoutAt = trimmed.slice(1);
  const separator = withoutAt.indexOf(":");
  if (separator === -1) return trimmed.toLowerCase();

  const localpart = withoutAt.slice(0, separator).trim().toLowerCase();
  const server = withoutAt.slice(separator + 1).trim().toLowerCase();
  if (!localpart || !server) return trimmed.toLowerCase();

  return `@${localpart}:${server}`;
}

export function matrixUserListIncludes(list: string[] | undefined, userId: string): boolean {
  const normalizedUserId = normalizeMatrixUserId(userId);
  if (!normalizedUserId) return false;

  return (list ?? []).some((entry) => normalizeMatrixUserId(entry) === normalizedUserId);
}

export function limitRecentItems<T>(items: T[], limit: number): T[] {
  if (limit <= 0) return [];
  return items.slice(Math.max(0, items.length - limit));
}

function buildReplyRelation(replyToId?: string): Record<string, unknown> | undefined {
  const eventId = replyToId?.trim();
  if (!eventId) return undefined;
  return { "m.in_reply_to": { event_id: eventId } };
}

function buildThreadRelation(threadId: string, replyToId?: string): Record<string, unknown> {
  return {
    rel_type: RelationType.Thread,
    event_id: threadId,
    is_falling_back: true,
    "m.in_reply_to": { event_id: replyToId?.trim() || threadId },
  };
}

export function buildRelation(threadId?: string, replyToId?: string): Record<string, unknown> | undefined {
  if (threadId?.trim()) return buildThreadRelation(threadId.trim(), replyToId);
  return buildReplyRelation(replyToId);
}

export function buildReplaceRelation(eventId: string, threadId?: string): Record<string, unknown> {
  const relation: Record<string, unknown> = {
    rel_type: RelationType.Replace,
    event_id: eventId,
  };
  if (threadId?.trim()) {
    relation["m.in_reply_to"] = { event_id: threadId.trim() };
  }
  return relation;
}

export function normalizeRoomKey(value: string): string {
  return value.trim();
}

/** A Matrix voice message is an m.audio event carrying the MSC3245 marker (MSC2516 in older
 *  clients). Plain audio files do not have it, and the difference matters: a configured STT
 *  language is right for the owner dictating, wrong for an arbitrary audio file. */
export function isMatrixVoiceMessage(content: MatrixEventContent): boolean {
  return (
    content["org.matrix.msc3245.voice"] !== undefined ||
    content["org.matrix.msc2516.voice"] !== undefined
  );
}

export function matrixAttachmentTypeFromMsgType(msgtype?: string): Attachment["type"] {
  switch (msgtype) {
    case MsgType.Image:
    case "m.sticker":
      return "image";
    case MsgType.Audio:
      return "audio";
    case MsgType.Video:
      return "video";
    default:
      return "file";
  }
}

export function messageBody(content: MatrixEventContent): string {
  return typeof content.body === "string" ? content.body : "";
}

export function stripMatrixReplyFallback(text: string, hasReplyTo: boolean): string {
  if (!hasReplyTo) {
    return text;
  }

  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("> ")) {
    return text;
  }

  const splitIndex = normalized.indexOf("\n\n");
  if (splitIndex === -1) {
    return text;
  }

  const fallback = normalized.slice(0, splitIndex);
  if (!fallback.split("\n").every((line) => line.startsWith("> "))) {
    return text;
  }

  return normalized.slice(splitIndex + 2).trimStart();
}

export function threadRootId(event: MatrixEvent): string | undefined {
  const relation = event.getRelation();
  if (relation?.rel_type === RelationType.Thread && typeof relation.event_id === "string") {
    return relation.event_id;
  }
  const thread = event.getThread();
  const rootId = thread?.id;
  return typeof rootId === "string" && rootId.length > 0 ? rootId : undefined;
}

export function replyToEventId(event: MatrixEvent): string | undefined {
  const relation = event.getRelation();
  const replyTo = relation?.["m.in_reply_to"]?.event_id;
  return typeof replyTo === "string" && replyTo.length > 0 ? replyTo : undefined;
}
