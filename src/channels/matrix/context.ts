import { MsgType } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import type { MatrixChannelConfig } from "../../core/config.ts";
import type { Attachment } from "../types.ts";
import {
  limitRecentItems,
  messageBody,
  resolveMatrixCaptionAndFilename,
  resolveMatrixMessageAttachmentSummary,
  trimString,
} from "./helpers.ts";
import { matrixLog } from "../../utils/logger.ts";
import type { MatrixChatType, MatrixEventContent } from "./types.ts";
import type { PreparedMatrixRoomHistory } from "./history.ts";
import { isMetaCommand } from "../meta-commands.ts";

export async function resolveReplyContext(
  sdk: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<{ body?: string; sender?: string } | undefined> {
  const event = await fetchEventContent(sdk, roomId, eventId);
  if (!event) return undefined;

  return {
    body: summarizeEventContent(event.content),
    sender: trimString(event.sender),
  };
}

export async function resolveThreadContext(
  sdk: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<{ text?: string; sender?: string } | undefined> {
  const event = await fetchEventContent(sdk, roomId, eventId);
  if (!event) return undefined;

  const body = summarizeEventContent(event.content);
  const sender = trimString(event.sender);
  if (body && sender) return { text: `Matrix thread root from ${sender}:\n${body}`, sender };
  if (body) return { text: body, sender };
  if (sender) return { text: `Matrix thread root from ${sender}`, sender };
  return undefined;
}

export async function fetchEventContent(
  sdk: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<{ sender?: string; content: MatrixEventContent } | undefined> {
  try {
    const raw = await sdk.fetchRoomEvent(roomId, eventId);
    const content = raw.content;
    if (!content || typeof content !== "object") return undefined;
    return {
      sender: trimString(raw.sender),
      content: content as MatrixEventContent,
    };
  } catch (err) {
    await matrixLog("warn", "matrix event context fetch failed", { roomId, eventId, error: String(err) });
    return undefined;
  }
}

export function summarizeEventContent(content: MatrixEventContent): string | undefined {
  const body = messageBody(content);
  const filename = trimString(content.filename);
  const msgtype = trimString(content.msgtype);
  const mediaSummary = resolveMatrixMessageAttachmentSummary({ body, filename, msgtype });
  return mediaSummary ?? (body || undefined);
}

export function resolveNormalizedInboundText(
  content: MatrixEventContent,
  text: string,
  attachments: Attachment[],
): string {
  const msgtype = trimString(content.msgtype);
  if (!isMediaMsgType(msgtype)) {
    return text;
  }

  const summary = attachments
    .map((attachment) => attachment.summaryText?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  const caption = resolveMatrixCaptionAndFilename({
    body: text,
    filename: trimString(content.filename),
  }).caption?.trim();

  return summary || caption || text;
}

export function isMediaMsgType(msgtype?: string): boolean {
  return msgtype === MsgType.Image || msgtype === MsgType.Audio || msgtype === MsgType.Video || msgtype === MsgType.File || msgtype === "m.sticker";
}

export async function resolveRoomHistoryContext(
  config: MatrixChannelConfig,
  roomId: string,
  chatType: MatrixChatType,
  preparedRoomHistory?: PreparedMatrixRoomHistory,
  visibility: "all" | "allowlist" | "allowlist_quote" = "all",
  shouldIncludeSender?: (senderId: string) => boolean,
): Promise<string | undefined> {
  const limit = chatType === "dm"
    ? Math.max(0, config.dm?.historyLimit ?? config.historyLimit ?? 0)
    : Math.max(0, config.historyLimit ?? 0);
  if (limit <= 0) return undefined;

  const recent = limitRecentItems(
    (preparedRoomHistory?.history ?? []).filter((entry) =>
      shouldIncludeSender ? shouldIncludeSender(entry.senderId) : true
    ),
    limit,
  );
  const lines = recent
    .map((entry) => {
      const sender = entry.senderId || "unknown";
      const body = entry.text.trim();
      return body ? `${sender}: ${body}` : undefined;
    })
    .filter((value): value is string => Boolean(value));

  if (lines.length === 0) return undefined;
  return `[Recent Room Context]\n${lines.join("\n")}`;
}

export function resolvePendingRoomHistoryText(text: string, content: MatrixEventContent): string {
  const trimmed = text.trim();
  if (isMetaCommand(trimmed)) return "";
  if (trimmed) return trimmed;
  return summarizeEventContent(content) ?? "";
}
