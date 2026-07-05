import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { MatrixClient } from "matrix-js-sdk";
import { MsgType } from "matrix-js-sdk";
import type { MatrixChannelConfig } from "../../core/config.ts";
import type { Attachment, OutgoingMessage, UnifiedMessage } from "../types.ts";
import { buildRelation } from "./helpers.ts";
import type { MatrixCryptoFacade, MatrixEncryptedFile } from "./types.ts";
import { withMatrixRetry } from "./retry.ts";

// Bridges Record<string, unknown> to Matrix SDK's strict content types.
// Centralized here so the unavoidable SDK type gap lives in one place.
export function toSdkContent<T = never>(content: Record<string, unknown>): T {
  return content as T;
}

export function sendMatrixMessage(
  sdk: MatrixClient,
  roomId: string,
  content: Record<string, unknown>,
  txnId?: string,
): Promise<{ event_id: string }> {
  return withMatrixRetry({
    task: () => sdk.sendMessage(roomId, toSdkContent(content), txnId),
  });
}

export async function sendMediaByPath(
  sdk: MatrixClient,
  crypto: MatrixCryptoFacade | undefined,
  roomId: string,
  filePath: string,
  replyToId?: string,
  threadId?: string,
  audioAsVoice?: boolean,
  durationMs?: number,
): Promise<void> {
  const buffer = Buffer.from(await readFile(filePath));
  const name = basename(filePath);
  const mimeType = mimeFromExt(extname(filePath));
  const upload = await uploadMedia(sdk, crypto, roomId, buffer, {
    name,
    type: mimeType,
  });
  const content = buildMediaContent({
    body: name,
    filename: name,
    msgtype: msgTypeFromMime(mimeType),
    url: upload.url,
    file: upload.file,
    mimeType,
    size: buffer.byteLength,
    replyToId,
    threadId,
  });

  if (audioAsVoice) {
    content["org.matrix.msc3245.voice"] = {};
    if (typeof durationMs === "number") {
      content["org.matrix.msc1767.audio"] = { duration: durationMs };
    }
  }

  await sendMatrixMessage(sdk, roomId, content, outboundTxnId(`media-${name}`));
}

export async function sendAttachment(
  sdk: MatrixClient,
  crypto: MatrixCryptoFacade | undefined,
  fetchMedia: (url: string) => Promise<Response>,
  roomId: string,
  attachment: Attachment,
  replyToId?: string,
  threadId?: string,
): Promise<void> {
  const source = attachment.path ?? attachment.url;
  if (!source) return;

  if (attachment.path) {
    await sendMediaByPath(sdk, crypto, roomId, attachment.path, replyToId, threadId, attachment.audioAsVoice, attachment.durationMs);
    return;
  }

  const response = await fetchMedia(source);
  if (!response.ok) {
    throw new Error(`Matrix attachment fetch failed: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = attachment.mimeType ?? response.headers.get("content-type") ?? "application/octet-stream";
  const name = source.split("/").pop() ?? `file${extFromMime(mimeType)}`;
  const upload = await uploadMedia(sdk, crypto, roomId, buffer, {
    name,
    type: mimeType,
  });
  const content = buildMediaContent({
    body: name,
    filename: name,
    msgtype: msgTypeFromMime(mimeType),
    url: upload.url,
    file: upload.file,
    mimeType,
    size: buffer.byteLength,
    replyToId,
    threadId,
  });

  if (attachment.type === "audio" && attachment.audioAsVoice) {
    content["org.matrix.msc3245.voice"] = {};
    if (typeof attachment.durationMs === "number") {
      content["org.matrix.msc1767.audio"] = { duration: attachment.durationMs };
    }
  }

  await sendMatrixMessage(sdk, roomId, content, outboundTxnId(`attachment-${name}`));
}

export async function uploadMedia(
  sdk: MatrixClient,
  crypto: MatrixCryptoFacade | undefined,
  roomId: string,
  buffer: Buffer,
  opts: { name?: string; type?: string },
): Promise<{ url: string; file?: MatrixEncryptedFile }> {
  const shouldEncrypt = (await crypto?.isRoomEncrypted?.(roomId)) === true && typeof crypto?.encryptMedia === "function";
  if (shouldEncrypt && crypto?.encryptMedia) {
    const encrypted = await crypto.encryptMedia(buffer);
    const upload = await withMatrixRetry({
      task: () =>
        sdk.uploadContent(encrypted.buffer, {
          ...opts,
          includeFilename: false,
        }),
    });
    return {
      url: upload.content_uri,
      file: {
        url: upload.content_uri,
        key: encrypted.file.key,
        iv: encrypted.file.iv,
        hashes: encrypted.file.hashes,
        v: encrypted.file.v,
      },
    };
  }
  const upload = await withMatrixRetry({
    task: () => sdk.uploadContent(buffer, opts),
  });
  return { url: upload.content_uri };
}

export function buildMediaContent(params: {
  body: string;
  filename?: string;
  msgtype: string;
  url: string;
  file?: MatrixEncryptedFile;
  mimeType?: string;
  size: number;
  replyToId?: string;
  threadId?: string;
}): Record<string, unknown> {
  const relation = buildRelation(
    params.threadId,
    effectiveReplyToId({ replyToId: params.replyToId, threadId: params.threadId }),
  );
  const info: Record<string, unknown> = {
    size: params.size,
  };
  if (params.mimeType) {
    info["mimetype"] = params.mimeType;
  }

  const content: Record<string, unknown> = {
    msgtype: params.msgtype,
    body: params.body,
    filename: params.filename,
    info,
  };
  if (params.file) {
    content["file"] = params.file;
  } else {
    content["url"] = params.url;
  }
  if (relation) {
    content["m.relates_to"] = relation;
  }
  return content;
}

export function msgTypeFromMime(mimeType: string): string {
  if (mimeType.startsWith("image/")) return MsgType.Image;
  if (mimeType.startsWith("video/")) return MsgType.Video;
  if (mimeType.startsWith("audio/")) return MsgType.Audio;
  return MsgType.File;
}

export function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

export function extFromMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "video/mp4") return ".mp4";
  if (mimeType === "audio/mpeg") return ".mp3";
  if (mimeType === "audio/ogg") return ".ogg";
  return "";
}

export function outboundTxnId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

export function replyTargetForChunk(
  config: MatrixChannelConfig,
  message: OutgoingMessage,
  chunkIndex: number,
  params: { chunkCount: number; hasMedia: boolean },
): string | undefined {
  if (message.threadId) return undefined;

  const replyToId = message.replyToId;
  if (!replyToId) return undefined;

  const mode = config.replyToMode ?? "off";
  if (mode === "off") return undefined;
  const multiPart = params.hasMedia || params.chunkCount > 1;
  if (!multiPart) return replyToId;
  if (mode === "all") return replyToId;
  if (mode === "batched") return replyToId;
  if (mode === "first") return chunkIndex === 0 ? replyToId : undefined;
  return undefined;
}

export function streamReplyTarget(config: MatrixChannelConfig, message: UnifiedMessage): string | undefined {
  if (message.threadId) return undefined;

  const mode = config.replyToMode ?? "off";
  if (mode === "off") return undefined;
  return message.id;
}

export function textChunkLimit(config: MatrixChannelConfig): number {
  const limit = config.textChunkLimit;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return 4000;
  }
  return Math.floor(limit);
}

export function chunkMode(config: MatrixChannelConfig): "plain" | "line" {
  return (config.chunkMode ?? "newline") === "length" ? "plain" : "line";
}

function effectiveReplyToId(message: { threadId?: string; replyToId?: string }): string | undefined {
  return message.threadId ? undefined : message.replyToId;
}
