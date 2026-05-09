import { Bot, InlineKeyboard, InputFile, GrammyError, HttpError } from "grammy";
import type { Attachment } from "../types.ts";
import type { TelegramChannelConfig } from "../../core/config.ts";
import { telegramLog } from "../../utils/logger.ts";
import { extname } from "node:path";

export const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
export const THREAD_NOT_FOUND_RE = /message thread not found/i;
export const MESSAGE_NOT_MODIFIED_RE = /message is not modified/i;
export const PRE_CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

export const RETRY_ATTEMPTS = 3;
export const RETRY_MIN_DELAY_MS = 400;
export const RETRY_MAX_DELAY_MS = 30_000;
export const RETRY_JITTER = 0.1;
export const GENERAL_TOPIC_ID = 1;

const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "avi", "mkv", "mov", "webm"]);
const VOICE_EXTENSIONS = new Set(["ogg", "oga"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "m4a", "aac"]);

export interface Caption {
  html: string;
  plain: string;
}

export function isParseError(err: unknown): boolean {
  return err instanceof GrammyError && PARSE_ERR_RE.test(err.description);
}

export function isThreadNotFoundError(err: unknown): boolean {
  return err instanceof GrammyError && THREAD_NOT_FOUND_RE.test(err.description);
}

export function isMessageNotModifiedError(err: unknown): boolean {
  return err instanceof GrammyError && MESSAGE_NOT_MODIFIED_RE.test(err.description);
}

export function isRateLimitError(err: unknown): err is GrammyError {
  return err instanceof GrammyError && err.error_code === 429;
}

export function getRetryAfter(err: GrammyError): number {
  const params = err.parameters as Record<string, unknown> | undefined;
  return typeof params?.retry_after === "number" ? params.retry_after : 5;
}

export function isPreConnectError(err: unknown): boolean {
  if (err instanceof HttpError) {
    const code = (err.error as Record<string, unknown> | undefined)?.code;
    return typeof code === "string" && PRE_CONNECT_ERROR_CODES.has(code);
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function mediaTypeFromExt(ext: string): "photo" | "video" | "voice" | "audio" | "document" {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (PHOTO_EXTENSIONS.has(e)) return "photo";
  if (VIDEO_EXTENSIONS.has(e)) return "video";
  if (VOICE_EXTENSIONS.has(e)) return "voice";
  if (AUDIO_EXTENSIONS.has(e)) return "audio";
  return "document";
}

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === RETRY_ATTEMPTS) break;

      if (isRateLimitError(err)) {
        const seconds = getRetryAfter(err);
        await telegramLog("warn", `rate limited, waiting ${seconds}s`);
        await sleep(seconds * 1000);
        continue;
      }

      if (!isPreConnectError(err)) break;

      const base = RETRY_MIN_DELAY_MS * Math.pow(2, attempt - 1);
      const clamped = Math.min(base, RETRY_MAX_DELAY_MS);
      const jittered = clamped * (1 + (Math.random() * 2 - 1) * RETRY_JITTER);
      const delay = Math.max(RETRY_MIN_DELAY_MS, Math.min(jittered, RETRY_MAX_DELAY_MS));
      await telegramLog("warn", `pre-connect error, retrying in ${Math.round(delay)}ms (attempt ${attempt}/${RETRY_ATTEMPTS})`);
      await sleep(delay);
    }
  }

  throw lastErr;
}

export function threadParams(threadId?: number): Record<string, unknown> {
  if (threadId && threadId !== GENERAL_TOPIC_ID) {
    return { message_thread_id: threadId };
  }
  return {};
}

export function buildKeyboard(buttons: Array<{ label: string; action: string }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  buttons.forEach((btn, index) => {
    kb.text(btn.label, btn.action);
    if (index % 2 === 1 && index < buttons.length - 1) kb.row();
  });
  return kb;
}

export async function sendTextMessage(
  bot: Bot,
  config: TelegramChannelConfig,
  chatId: string,
  html: string,
  plain: string,
  opts: { threadId?: number; replyToId?: number; keyboard?: InlineKeyboard },
): Promise<number> {
  const params: Record<string, unknown> = {};
  if (config.linkPreview === false) {
    params.link_preview_options = { is_disabled: true };
  }
  if (opts.threadId && opts.threadId !== GENERAL_TOPIC_ID) {
    params.message_thread_id = opts.threadId;
  }
  if (opts.replyToId) {
    params.reply_parameters = {
      message_id: opts.replyToId,
      allow_sending_without_reply: true,
    };
  }
  if (opts.keyboard) {
    params.reply_markup = opts.keyboard;
  }

  try {
    const msg = await withRetry(() =>
      bot.api.sendMessage(chatId, html, { ...params, parse_mode: "HTML" }),
    );
    return msg.message_id;
  } catch (err) {
    if (isParseError(err)) {
      await telegramLog("warn", "HTML parse failed, falling back to plain text", { chatId });
      const msg = await withRetry(() => bot.api.sendMessage(chatId, plain, params));
      return msg.message_id;
    }
    if (isThreadNotFoundError(err) && params.message_thread_id) {
      await telegramLog("warn", "thread not found, retrying without thread_id", { chatId });
      delete params.message_thread_id;
      try {
        const msg = await withRetry(() =>
          bot.api.sendMessage(chatId, html, { ...params, parse_mode: "HTML" }),
        );
        return msg.message_id;
      } catch (retryErr) {
        if (isParseError(retryErr)) {
          const msg = await bot.api.sendMessage(chatId, plain, params);
          return msg.message_id;
        }
        throw retryErr;
      }
    }
    throw err;
  }
}

export async function sendPlainTextMessage(
  bot: Bot,
  config: TelegramChannelConfig,
  chatId: string,
  plain: string,
  opts: { threadId?: number; replyToId?: number },
): Promise<number> {
  const params: Record<string, unknown> = {};
  if (config.linkPreview === false) {
    params.link_preview_options = { is_disabled: true };
  }
  if (opts.threadId && opts.threadId !== GENERAL_TOPIC_ID) {
    params.message_thread_id = opts.threadId;
  }
  if (opts.replyToId) {
    params.reply_parameters = {
      message_id: opts.replyToId,
      allow_sending_without_reply: true,
    };
  }

  try {
    const msg = await withRetry(() => bot.api.sendMessage(chatId, plain, params));
    return msg.message_id;
  } catch (err) {
    if (isThreadNotFoundError(err) && params.message_thread_id) {
      delete params.message_thread_id;
      const msg = await withRetry(() => bot.api.sendMessage(chatId, plain, params));
      return msg.message_id;
    }
    throw err;
  }
}

export async function editPlainTextMessage(
  bot: Bot,
  config: TelegramChannelConfig,
  chatId: string,
  messageId: number,
  plain: string,
): Promise<void> {
  const params: Record<string, unknown> = {};
  if (config.linkPreview === false) {
    params.link_preview_options = { is_disabled: true };
  }

  try {
    await withRetry(() => bot.api.editMessageText(chatId, messageId, plain, params));
  } catch (err) {
    if (isMessageNotModifiedError(err)) return;
    throw err;
  }
}

export async function editTextMessage(
  bot: Bot,
  config: TelegramChannelConfig,
  chatId: string,
  messageId: number,
  html: string,
  plain: string,
): Promise<void> {
  const params: Record<string, unknown> = {};
  if (config.linkPreview === false) {
    params.link_preview_options = { is_disabled: true };
  }

  try {
    await withRetry(() =>
      bot.api.editMessageText(chatId, messageId, html, { ...params, parse_mode: "HTML" }),
    );
    return;
  } catch (err) {
    if (isMessageNotModifiedError(err)) return;
    if (!isParseError(err)) throw err;
  }

  try {
    await withRetry(() => bot.api.editMessageText(chatId, messageId, plain, params));
  } catch (err) {
    if (isMessageNotModifiedError(err)) return;
    throw err;
  }
}

export async function deleteMessage(bot: Bot, chatId: string, messageId: number): Promise<void> {
  await bot.api.deleteMessage(chatId, messageId).catch(() => {});
}

export async function sendMediaByPath(
  bot: Bot,
  chatId: string,
  filePath: string,
  threadId?: number,
  replyToId?: number,
  caption?: Caption,
): Promise<void> {
  const ext = extname(filePath);
  const type = mediaTypeFromExt(ext);
  const file = new InputFile(filePath);
  const params: Record<string, unknown> = { ...threadParams(threadId) };
  if (replyToId) {
    params.reply_parameters = {
      message_id: replyToId,
      allow_sending_without_reply: true,
    };
  }

  if (caption) {
    params.caption = caption.html;
    params.parse_mode = "HTML";
  }

  const sendByType = (p: Record<string, unknown>): Promise<unknown> => {
    switch (type) {
      case "photo":
        return bot.api.sendPhoto(chatId, file, p);
      case "video":
        return bot.api.sendVideo(chatId, file, p);
      case "voice":
        return bot.api.sendVoice(chatId, file, p);
      case "audio":
        return bot.api.sendAudio(chatId, file, p);
      default:
        return bot.api.sendDocument(chatId, file, p);
    }
  };

  try {
    await withRetry(() => sendByType(params));
  } catch (err) {
    if (caption && isParseError(err)) {
      params.caption = caption.plain;
      delete params.parse_mode;
      await withRetry(() => sendByType(params));
    } else {
      throw err;
    }
  }
}

export async function sendAttachment(
  bot: Bot,
  chatId: string,
  att: Attachment,
  threadId?: number,
  replyToId?: number,
  caption?: Caption,
): Promise<void> {
  const source = att.path ?? att.url;
  if (!source) return;

  const file = att.path ? new InputFile(att.path) : new InputFile(new URL(source));
  const params: Record<string, unknown> = { ...threadParams(threadId) };
  if (replyToId) {
    params.reply_parameters = {
      message_id: replyToId,
      allow_sending_without_reply: true,
    };
  }

  if (caption) {
    params.caption = caption.html;
    params.parse_mode = "HTML";
  }

  const sendByType = (p: Record<string, unknown>): Promise<unknown> => {
    switch (att.type) {
      case "image":
        return bot.api.sendPhoto(chatId, file, p);
      case "video":
        return bot.api.sendVideo(chatId, file, p);
      case "audio":
        return bot.api.sendAudio(chatId, file, p);
      default:
        return bot.api.sendDocument(chatId, file, p);
    }
  };

  try {
    await withRetry(() => sendByType(params));
  } catch (err) {
    if (caption && isParseError(err)) {
      params.caption = caption.plain;
      delete params.parse_mode;
      await withRetry(() => sendByType(params));
    } else {
      throw err;
    }
  }
}
