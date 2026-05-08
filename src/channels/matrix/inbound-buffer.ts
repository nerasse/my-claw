import type { Attachment } from "../types.ts";
import type { MatrixEventContent } from "./adapter-types.ts";

export type MatrixBufferedIngressItem = {
  eventId: string;
  senderId: string;
  text: string;
  content: MatrixEventContent;
  attachments?: Attachment[];
  timestampMs: number;
};

type MatrixIngressQueue = {
  items: MatrixBufferedIngressItem[];
};

const DEFAULT_COALESCE_WINDOW_MS = 1500;
const DEFAULT_MAX_ITEMS = 6;

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
      if (
        last &&
        last.senderId === item.senderId &&
        item.timestampMs - last.timestampMs <= coalesceWindowMs &&
        queue.items.length < maxItems
      ) {
        const merged: MatrixBufferedIngressItem = {
          eventId: item.eventId,
          senderId: item.senderId,
          text: [last.text, item.text].filter(Boolean).join("\n"),
          content: item.content,
          attachments: [...(last.attachments ?? []), ...(item.attachments ?? [])],
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
