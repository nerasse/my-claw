import type { Attachment } from "../types.ts";
import type { MatrixEventContent } from "./types.ts";

export type MatrixBufferedIngressItem = {
  eventId: string;
  senderId: string;
  chatType: "dm" | "group";
  text: string;
  content: MatrixEventContent;
  attachments?: Attachment[];
  threadId?: string;
  replyToId?: string;
  mode: "text" | "media";
  timestampMs: number;
};

type MatrixIngressQueue = {
  items: MatrixBufferedIngressItem[];
};

const DEFAULT_COALESCE_WINDOW_MS = 1500;
const DEFAULT_MAX_ITEMS = 6;
const DEFAULT_MEDIA_TEXT_MERGE_MAX_CHARS = 280;
const DEFAULT_SHORT_TEXT_HOLD_MAX_CHARS = 120;
const MATRIX_ATTACHMENT_SUMMARY_LINE = /^\[matrix .+ attachment(?: unavailable| too large)?\]$/;

function sameIngressContext(a: MatrixBufferedIngressItem, b: MatrixBufferedIngressItem, coalesceWindowMs: number): boolean {
  return (
    a.senderId === b.senderId &&
    a.chatType === b.chatType &&
    a.threadId === b.threadId &&
    a.replyToId === b.replyToId &&
    b.timestampMs - a.timestampMs <= coalesceWindowMs
  );
}

function canMergeModes(a: MatrixBufferedIngressItem, b: MatrixBufferedIngressItem): boolean {
  if (a.mode === b.mode) {
    return true;
  }

  const textItem = a.mode === "text" ? a : b.mode === "text" ? b : undefined;
  const mediaItem = a.mode === "media" ? a : b.mode === "media" ? b : undefined;
  if (!textItem || !mediaItem) {
    return false;
  }

  const trimmed = textItem.text.trim();
  return trimmed.length > 0 && trimmed.length <= DEFAULT_MEDIA_TEXT_MERGE_MAX_CHARS;
}

function shouldHoldShortText(item: MatrixBufferedIngressItem): boolean {
  if (item.chatType !== "group") {
    return false;
  }
  if (item.threadId || item.replyToId || item.mode !== "text") {
    return false;
  }
  const trimmed = item.text.trim();
  if (!trimmed || trimmed.length > DEFAULT_SHORT_TEXT_HOLD_MAX_CHARS || trimmed.length < 8) {
    return false;
  }
  if (trimmed.includes("\n") || trimmed.startsWith("/") || trimmed.startsWith("@") || trimmed.startsWith("[")) {
    return false;
  }
  if (/^[^\s:]+:\s/.test(trimmed)) {
    return false;
  }
  return !/[.!?]\s*$/.test(trimmed);
}

function isAttachmentSummaryBlock(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => MATRIX_ATTACHMENT_SUMMARY_LINE.test(line));
}

function mergeIngressText(a: MatrixBufferedIngressItem, b: MatrixBufferedIngressItem): string {
  if (a.mode !== b.mode) {
    const textItem = a.mode === "text" ? a : b.mode === "text" ? b : undefined;
    const mediaItem = a.mode === "media" ? a : b.mode === "media" ? b : undefined;
    const caption = textItem?.text.trim();
    const mediaText = mediaItem?.text.trim();
    if (caption && mediaText && isAttachmentSummaryBlock(mediaText)) {
      return `${caption}\n\n${mediaText}`;
    }
  }

  return [a.text, b.text].filter(Boolean).join("\n");
}

export function createMatrixInboundBuffer(params?: {
  coalesceWindowMs?: number;
  maxItems?: number;
}) {
  const coalesceWindowMs = Math.max(0, params?.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS);
  const maxItems = Math.max(1, params?.maxItems ?? DEFAULT_MAX_ITEMS);
  const rooms = new Map<string, MatrixIngressQueue>();

  const getQueue = (roomId: string): MatrixIngressQueue => {
    const existing = rooms.get(roomId);
    if (existing) return existing;
    const created: MatrixIngressQueue = { items: [] };
    rooms.set(roomId, created);
    return created;
  };

  return {
    coalesce(roomId: string, item: MatrixBufferedIngressItem): {
      item: MatrixBufferedIngressItem;
      mergedIntoEventId?: string;
    } {
      const queue = getQueue(roomId);
      const last = queue.items.at(-1);
      if (last && sameIngressContext(last, item, coalesceWindowMs) && canMergeModes(last, item)) {
        const merged: MatrixBufferedIngressItem = {
          eventId: item.eventId,
          senderId: item.senderId,
          chatType: item.chatType,
          text: mergeIngressText(last, item),
          content: item.content,
          attachments: [...(last.attachments ?? []), ...(item.attachments ?? [])],
          threadId: item.threadId,
          replyToId: item.replyToId,
          mode: last.mode === "media" || item.mode === "media" ? "media" : item.mode,
          timestampMs: item.timestampMs,
        };
        queue.items[queue.items.length - 1] = merged;
        return {
          item: merged,
          mergedIntoEventId: last.eventId,
        };
      }
      queue.items.push(item);
      while (queue.items.length > maxItems) {
        queue.items.shift();
      }
      return { item };
    },

    canCoalesce(roomId: string, item: MatrixBufferedIngressItem): boolean {
      const queue = rooms.get(roomId);
      const last = queue?.items.at(-1);
      return Boolean(last && sameIngressContext(last, item, coalesceWindowMs) && canMergeModes(last, item));
    },

    shouldHold(roomId: string, item: MatrixBufferedIngressItem): boolean {
      const queue = rooms.get(roomId);
      const last = queue?.items.at(-1);
      if (last && sameIngressContext(last, item, coalesceWindowMs) && canMergeModes(last, item)) {
        return true;
      }
      return shouldHoldShortText(item);
    },

    clear(roomId: string, eventId: string): void {
      const queue = rooms.get(roomId);
      if (!queue) return;
      queue.items = queue.items.filter((item) => item.eventId !== eventId);
      if (queue.items.length === 0) {
        rooms.delete(roomId);
      }
    },
  };
}
