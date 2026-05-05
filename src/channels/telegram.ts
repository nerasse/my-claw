import { Bot, InlineKeyboard, InputFile, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { ChannelAdapter, UnifiedMessage, OutgoingMessage, Attachment } from "./types.ts";
import type { TelegramChannelConfig } from "../config.ts";
import { MY_CLAW_DIR } from "../config.ts";
import { markdownToTelegramHtml, stripHtml } from "./telegram-format.ts";
import { CHUNK_LIMIT, splitHtmlChunks, alignPlainTextChunks } from "./telegram-split.ts";
import { registerCommands, getHelpText } from "./telegram-commands.ts";
import { ReactionManager } from "./telegram-reactions.ts";
import { ErrorReporter } from "./telegram-errors.ts";
import { MessageStreamer } from "./telegram-stream.ts";
import { extractMediaRefs, stripMediaRefs } from "../utils/media.ts";
import { log } from "../utils/logger.ts";

// Error detection (from OpenClaw)
const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const THREAD_NOT_FOUND_RE = /message thread not found/i;
const MESSAGE_NOT_MODIFIED_RE = /message is not modified/i;
const PRE_CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

// Text batching (from OpenClaw)
const TEXT_BATCH_THRESHOLD = 4000;
const TEXT_BATCH_GAP_MS = 1500;
const TEXT_BATCH_MAX_PARTS = 12;
const TEXT_BATCH_MAX_CHARS = 50_000;
const TEXT_BATCH_MAX_ID_GAP = 1;

// Retry (from OpenClaw: 3 attempts, exponential backoff, jitter)
const RETRY_ATTEMPTS = 3;
const RETRY_MIN_DELAY_MS = 400;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRY_JITTER = 0.1;

// Media, typing, misc
const MEDIA_GROUP_TIMEOUT_MS = 500;
const CAPTION_LIMIT = 1024;
const TYPING_INTERVAL_MS = 5000;
const GENERAL_TOPIC_ID = 1;
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_THREAD_ID_ENTRIES = 10_000;
const TMP_DIR = join(MY_CLAW_DIR, "tmp");
const ERROR_REPORT_COOLDOWN_MS = 5 * 60 * 1000;

const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "avi", "mkv", "mov", "webm"]);
const VOICE_EXTENSIONS = new Set(["ogg", "oga"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "m4a", "aac"]);

type GrammyMessage = NonNullable<Context["message"]>;

interface TextBatch {
  messages: Array<{ text: string; messageId: number; date: number }>;
  timer: Timer;
  chatId: string;
  firstMsg: GrammyMessage;
}

interface MediaGroupBuffer {
  messages: GrammyMessage[];
  timer: Timer;
}

interface PendingConfirmation {
  resolve: (accepted: boolean) => void;
  timer: Timer;
}

interface TypingRef {
  interval: Timer;
  count: number;
}

interface Caption {
  html: string;
  plain: string;
}

interface TelegramCallbackContext {
  chatId: string;
  userId: string;
  chatType: "dm" | "group";
  messageId: string;
  data: string;
  messageText?: string;
}

interface TelegramCallbackResponse {
  text?: string;
  buttons?: Array<{ label: string; action: string }>;
  answerText?: string;
}

// ── Error classification ──────────────────────────────────────

function isParseError(err: unknown): boolean {
  return err instanceof GrammyError && PARSE_ERR_RE.test(err.description);
}

function isThreadNotFoundError(err: unknown): boolean {
  return err instanceof GrammyError && THREAD_NOT_FOUND_RE.test(err.description);
}

function isMessageNotModifiedError(err: unknown): boolean {
  return err instanceof GrammyError && MESSAGE_NOT_MODIFIED_RE.test(err.description);
}

function isRateLimitError(err: unknown): err is GrammyError {
  return err instanceof GrammyError && err.error_code === 429;
}

function getRetryAfter(err: GrammyError): number {
  const params = err.parameters as Record<string, unknown> | undefined;
  return typeof params?.retry_after === "number" ? params.retry_after : 5;
}

function isPreConnectError(err: unknown): boolean {
  if (err instanceof HttpError) {
    const code = (err.error as Record<string, unknown> | undefined)?.code;
    return typeof code === "string" && PRE_CONNECT_ERROR_CODES.has(code);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mediaTypeFromExt(ext: string): "photo" | "video" | "voice" | "audio" | "document" {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (PHOTO_EXTENSIONS.has(e)) return "photo";
  if (VIDEO_EXTENSIONS.has(e)) return "video";
  if (VOICE_EXTENSIONS.has(e)) return "voice";
  if (AUDIO_EXTENSIONS.has(e)) return "audio";
  return "document";
}

// ── Adapter ───────────────────────────────────────────────────

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram" as const;
  private bot: Bot;
  private messageHandler?: (msg: UnifiedMessage) => Promise<void>;
  private commandHandler?: (chatId: string, userId: string, chatType: "dm" | "group", command: string, args: string) => Promise<OutgoingMessage | string | undefined>;
  private callbackHandler?: (ctx: TelegramCallbackContext) => Promise<TelegramCallbackResponse | undefined>;

  private textBatches = new Map<string, TextBatch>();
  private mediaGroups = new Map<string, MediaGroupBuffer>();
  private typingRefs = new Map<string, TypingRef>();
  private messageThreadIds = new Map<string, number>();
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  private webhookServer: { stop(): void } | undefined;
  private reactions: ReactionManager;
  private errorReporter: ErrorReporter;

  constructor(
    private config: TelegramChannelConfig,
    private whitelist: Set<string>,
  ) {
    this.bot = new Bot(config.token);
    this.reactions = new ReactionManager(this.bot, {
      enabled: config.reactions?.enabled ?? false,
      emojis: {
        received: config.reactions?.received,
        thinking: config.reactions?.thinking,
        tool_use: config.reactions?.toolUse,
        done: config.reactions?.done,
        error: config.reactions?.error,
      },
    });
    this.errorReporter = new ErrorReporter({
      mode: config.errorPolicy ?? "always",
      onceCooldownMs: ERROR_REPORT_COOLDOWN_MS,
    });
  }

  // ── Public API ──────────────────────────────────────────────

  async start(): Promise<void> {
    this.bot.api.config.use(apiThrottler());
    this.bot.catch((err) => log("error", "grammy unhandled error", { error: String(err) }));

    this.setupHandlers();

    if (this.config.mode === "webhook" && this.config.webhook) {
      await this.startWebhook();
    } else {
      await this.bot.init();
      await registerCommands(this.bot);
      this.bot.start({ onStart: () => log("info", "telegram polling started") });
    }

    log("info", "telegram adapter started", { mode: this.config.mode ?? "polling" });
  }

  async stop(): Promise<void> {
    for (const [, b] of this.textBatches) clearTimeout(b.timer);
    for (const [, g] of this.mediaGroups) clearTimeout(g.timer);
    for (const [, r] of this.typingRefs) clearInterval(r.interval);
    for (const [, p] of this.pendingConfirmations) {
      clearTimeout(p.timer);
      p.resolve(false);
    }

    this.textBatches.clear();
    this.mediaGroups.clear();
    this.typingRefs.clear();
    this.pendingConfirmations.clear();

    await this.bot.stop();
    this.webhookServer?.stop();
    log("info", "telegram adapter stopped");
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    const mediaRefs = extractMediaRefs(message.text);
    const text = stripMediaRefs(message.text);

    if (!text && !mediaRefs.length && !message.attachments?.length) return;

    const replyToId = message.replyToId ? Math.trunc(Number(message.replyToId)) : undefined;
    const threadId = message.replyToId ? this.messageThreadIds.get(message.replyToId) : undefined;
    const hasMedia = mediaRefs.length > 0 || (message.attachments?.length ?? 0) > 0;

    // Caption: text ≤ 1024 chars with media → attach to first media (OpenClaw: all-or-nothing at 1024)
    let caption: Caption | undefined;
    if (text && hasMedia && text.length <= CAPTION_LIMIT) {
      const html = markdownToTelegramHtml(text);
      caption = { html, plain: stripHtml(html) };
    }

    // Send text as chunked messages (if too long for caption or no media)
    if (text && !caption) {
      const html = markdownToTelegramHtml(text);
      const plain = stripHtml(html);
      const htmlChunks = splitHtmlChunks(html);
      const plainChunks = alignPlainTextChunks(plain, htmlChunks.length);

      for (let i = 0; i < htmlChunks.length; i++) {
        await this.sendTextMessage(chatId, htmlChunks[i]!, plainChunks[i] ?? "", {
          threadId,
          replyToId: i === 0 ? replyToId : undefined,
          keyboard:
            i === htmlChunks.length - 1 && message.buttons?.length
              ? this.buildKeyboard(message.buttons)
              : undefined,
        });
      }
    }

    // Send media with optional caption on first item
    let usedCaption = false;
    for (const ref of mediaRefs) {
      const cap = !usedCaption ? caption : undefined;
      await this.sendMediaByPath(chatId, ref.path, threadId, cap);
      if (cap) usedCaption = true;
    }
    if (message.attachments) {
      for (const att of message.attachments) {
        const cap = !usedCaption ? caption : undefined;
        await this.sendAttachment(chatId, att, threadId, cap);
        if (cap) usedCaption = true;
      }
    }
  }

  onMessage(handler: (msg: UnifiedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onCommand(handler: (chatId: string, userId: string, chatType: "dm" | "group", command: string, args: string) => Promise<OutgoingMessage | string | undefined>): void {
    this.commandHandler = handler;
  }

  onCallbackQuery(handler: (ctx: TelegramCallbackContext) => Promise<TelegramCallbackResponse | undefined>): void {
    this.callbackHandler = handler;
  }

  streamingEnabled(): boolean {
    return this.config.streaming?.enabled === true;
  }

  createStreamer(message: UnifiedMessage): MessageStreamer {
    const raw = message.raw as Partial<GrammyMessage>;
    return new MessageStreamer(
      {
        chatId: message.chatId,
        threadId: raw.message_thread_id,
        replyToId: Math.trunc(Number(message.id)),
        minCharsBeforeSend: this.config.streaming?.minChars ?? 30,
        editThrottleMs: this.config.streaming?.throttleMs ?? 1000,
        chunkLimit: CHUNK_LIMIT,
      },
      {
        sendPlain: (chatId, text, opts) => this.sendPlainTextMessage(chatId, text, opts),
        editPlain: (chatId, messageId, text) => this.editPlainTextMessage(chatId, messageId, text),
        sendFinal: (chatId, html, plain, opts) => this.sendTextMessage(chatId, html, plain, opts),
        editFinal: (chatId, messageId, html, plain) => this.editTextMessage(chatId, messageId, html, plain),
        deleteMessage: (chatId, messageId) => this.deleteMessage(chatId, messageId),
      },
    );
  }

  async confirm(chatId: string, text: string, replyToId?: string): Promise<boolean> {
    const id = crypto.randomUUID().slice(0, 8);
    const keyboard = new InlineKeyboard()
      .text("Accept", `cfm:${id}:y`)
      .text("Deny", `cfm:${id}:n`);

    const params: Record<string, unknown> = {
      parse_mode: "HTML",
      reply_markup: keyboard,
    };
    if (replyToId) {
      params.reply_parameters = {
        message_id: Math.trunc(Number(replyToId)),
        allow_sending_without_reply: true,
      };
    }

    await this.withRetry(() => this.bot.api.sendMessage(chatId, text, params));

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingConfirmations.delete(id);
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);

      this.pendingConfirmations.set(id, { resolve, timer });
    });
  }

  // ── Sending ─────────────────────────────────────────────────

  private async sendTextMessage(
    chatId: string,
    html: string,
    plain: string,
    opts: { threadId?: number; replyToId?: number; keyboard?: InlineKeyboard },
  ): Promise<number> {
    const params: Record<string, unknown> = {};
    if (this.config.linkPreview === false) {
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
      const msg = await this.withRetry(() =>
        this.bot.api.sendMessage(chatId, html, { ...params, parse_mode: "HTML" }),
      );
      return msg.message_id;
    } catch (err) {
      if (isParseError(err)) {
        log("warn", "HTML parse failed, falling back to plain text", { chatId });
        const msg = await this.withRetry(() => this.bot.api.sendMessage(chatId, plain, params));
        return msg.message_id;
      }
      if (isThreadNotFoundError(err) && params.message_thread_id) {
        log("warn", "thread not found, retrying without thread_id", { chatId });
        delete params.message_thread_id;
        try {
          const msg = await this.withRetry(() =>
            this.bot.api.sendMessage(chatId, html, { ...params, parse_mode: "HTML" }),
          );
          return msg.message_id;
        } catch (retryErr) {
          if (isParseError(retryErr)) {
            const msg = await this.bot.api.sendMessage(chatId, plain, params);
            return msg.message_id;
          }
          throw retryErr;
        }
      }
      throw err;
    }
  }

  private async sendPlainTextMessage(
    chatId: string,
    plain: string,
    opts: { threadId?: number; replyToId?: number },
  ): Promise<number> {
    const params: Record<string, unknown> = {};
    if (this.config.linkPreview === false) {
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
      const msg = await this.withRetry(() => this.bot.api.sendMessage(chatId, plain, params));
      return msg.message_id;
    } catch (err) {
      if (isThreadNotFoundError(err) && params.message_thread_id) {
        delete params.message_thread_id;
        const msg = await this.withRetry(() => this.bot.api.sendMessage(chatId, plain, params));
        return msg.message_id;
      }
      throw err;
    }
  }

  private async editPlainTextMessage(chatId: string, messageId: number, plain: string): Promise<void> {
    const params: Record<string, unknown> = {};
    if (this.config.linkPreview === false) {
      params.link_preview_options = { is_disabled: true };
    }

    try {
      await this.withRetry(() => this.bot.api.editMessageText(chatId, messageId, plain, params));
    } catch (err) {
      if (isMessageNotModifiedError(err)) return;
      throw err;
    }
  }

  private async editTextMessage(
    chatId: string,
    messageId: number,
    html: string,
    plain: string,
  ): Promise<void> {
    const params: Record<string, unknown> = {};
    if (this.config.linkPreview === false) {
      params.link_preview_options = { is_disabled: true };
    }

    try {
      await this.withRetry(() =>
        this.bot.api.editMessageText(chatId, messageId, html, { ...params, parse_mode: "HTML" }),
      );
      return;
    } catch (err) {
      if (isMessageNotModifiedError(err)) return;
      if (!isParseError(err)) throw err;
    }

    try {
      await this.withRetry(() => this.bot.api.editMessageText(chatId, messageId, plain, params));
    } catch (err) {
      if (isMessageNotModifiedError(err)) return;
      throw err;
    }
  }

  private async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.bot.api.deleteMessage(chatId, messageId).catch(() => {});
  }

  private async sendMediaByPath(
    chatId: string,
    filePath: string,
    threadId?: number,
    caption?: Caption,
  ): Promise<void> {
    const ext = extname(filePath);
    const type = mediaTypeFromExt(ext);
    const file = new InputFile(filePath);
    const params: Record<string, unknown> = { ...this.threadParams(threadId) };

    if (caption) {
      params.caption = caption.html;
      params.parse_mode = "HTML";
    }

    const sendByType = (p: Record<string, unknown>): Promise<unknown> => {
      switch (type) {
        case "photo":
          return this.bot.api.sendPhoto(chatId, file, p);
        case "video":
          return this.bot.api.sendVideo(chatId, file, p);
        case "voice":
          return this.bot.api.sendVoice(chatId, file, p);
        case "audio":
          return this.bot.api.sendAudio(chatId, file, p);
        default:
          return this.bot.api.sendDocument(chatId, file, p);
      }
    };

    try {
      await this.withRetry(() => sendByType(params));
    } catch (err) {
      if (caption && isParseError(err)) {
        params.caption = caption.plain;
        delete params.parse_mode;
        await this.withRetry(() => sendByType(params));
      } else {
        throw err;
      }
    }
  }

  private async sendAttachment(
    chatId: string,
    att: Attachment,
    threadId?: number,
    caption?: Caption,
  ): Promise<void> {
    const source = att.path ?? att.url;
    if (!source) return;

    const file = att.path ? new InputFile(att.path) : new InputFile(new URL(source));
    const params: Record<string, unknown> = { ...this.threadParams(threadId) };

    if (caption) {
      params.caption = caption.html;
      params.parse_mode = "HTML";
    }

    const sendByType = (p: Record<string, unknown>): Promise<unknown> => {
      switch (att.type) {
        case "image":
          return this.bot.api.sendPhoto(chatId, file, p);
        case "video":
          return this.bot.api.sendVideo(chatId, file, p);
        case "audio":
          return this.bot.api.sendAudio(chatId, file, p);
        default:
          return this.bot.api.sendDocument(chatId, file, p);
      }
    };

    try {
      await this.withRetry(() => sendByType(params));
    } catch (err) {
      if (caption && isParseError(err)) {
        params.caption = caption.plain;
        delete params.parse_mode;
        await this.withRetry(() => sendByType(params));
      } else {
        throw err;
      }
    }
  }

  private threadParams(threadId?: number): Record<string, unknown> {
    if (threadId && threadId !== GENERAL_TOPIC_ID) {
      return { message_thread_id: threadId };
    }
    return {};
  }

  private buildKeyboard(buttons: Array<{ label: string; action: string }>): InlineKeyboard {
    const kb = new InlineKeyboard();
    buttons.forEach((btn, index) => {
      kb.text(btn.label, btn.action);
      if (index % 2 === 1 && index < buttons.length - 1) kb.row();
    });
    return kb;
  }

  // ── Retry (exponential backoff, from OpenClaw) ──────────────

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt === RETRY_ATTEMPTS) break;

        if (isRateLimitError(err)) {
          const seconds = getRetryAfter(err);
          log("warn", `rate limited, waiting ${seconds}s`);
          await sleep(seconds * 1000);
          continue;
        }

        if (!isPreConnectError(err)) break;

        const base = RETRY_MIN_DELAY_MS * Math.pow(2, attempt - 1);
        const clamped = Math.min(base, RETRY_MAX_DELAY_MS);
        const jittered = clamped * (1 + (Math.random() * 2 - 1) * RETRY_JITTER);
        const delay = Math.max(RETRY_MIN_DELAY_MS, Math.min(jittered, RETRY_MAX_DELAY_MS));
        log("warn", `pre-connect error, retrying in ${Math.round(delay)}ms (attempt ${attempt}/${RETRY_ATTEMPTS})`);
        await sleep(delay);
      }
    }

    throw lastErr;
  }

  // ── Handlers ────────────────────────────────────────────────

  private setupHandlers(): void {
    this.bot.command("new", (ctx) => this.handleCommand(ctx, "new"));
    this.bot.command("model", (ctx) => this.handleCommand(ctx, "model"));
    this.bot.command("status", (ctx) => this.handleCommand(ctx, "status"));
    this.bot.command("clear", (ctx) => this.handleCommand(ctx, "clear"));
    this.bot.command("help", (ctx) => this.handleCommand(ctx, "help"));
    this.bot.on("callback_query:data", (ctx) => this.handleCallbackQuery(ctx));
    this.bot.on("message", (ctx) => this.handleMessage(ctx));
  }

  private async handleCommand(ctx: Context, command: string): Promise<void> {
    const userId = String(ctx.from?.id);
    if (!this.whitelist.has(userId)) return;

    if (command === "help") {
      await ctx.reply(getHelpText());
      return;
    }

    if (this.commandHandler) {
      const chatId = String(ctx.chat?.id);
      const chatType = ctx.chat?.type === "private" ? "dm" as const : "group" as const;
      const args = typeof ctx.match === "string" ? ctx.match : "";
      const messageId = ctx.message?.message_id;
      const threadId = ctx.message?.message_thread_id;

      if (messageId && threadId) {
        this.messageThreadIds.set(String(messageId), threadId);
        this.pruneThreadIds();
      }

      try {
        const response = await this.commandHandler(chatId, userId, chatType, command, args);
        if (!response) return;

        const replyToId = messageId ? String(messageId) : undefined;
        if (typeof response === "string") {
          await this.send(chatId, { text: response, replyToId });
          return;
        }

        await this.send(chatId, {
          ...response,
          replyToId: response.replyToId ?? replyToId,
        });
      } catch (err) {
        log("error", "telegram command failed", { command, chatId, error: String(err) });
        await this.reportProcessingError(chatId, messageId ? String(messageId) : undefined, err);
      }
    }
  }

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    const userId = String(ctx.from?.id);
    if (!this.whitelist.has(userId)) {
      await ctx.answerCallbackQuery({ text: "Not authorized" });
      return;
    }

    const match = data.match(/^cfm:(\w+):(y|n)$/);
    if (!match) {
      const message = ctx.callbackQuery?.message;
      if (!message || !this.callbackHandler) {
        await ctx.answerCallbackQuery();
        return;
      }

      try {
        const response = await this.callbackHandler({
          chatId: String(message.chat.id),
          userId,
          chatType: message.chat.type === "private" ? "dm" : "group",
          messageId: String(message.message_id),
          data,
          messageText: message.text,
        });

        if (!response) {
          await ctx.answerCallbackQuery();
          return;
        }

        const params: Record<string, unknown> = {};
        if (response.buttons?.length) {
          params.reply_markup = this.buildKeyboard(response.buttons);
        }
        if (response.text) {
          await ctx.editMessageText(response.text, params).catch(() => {});
        }
        await ctx.answerCallbackQuery(response.answerText ? { text: response.answerText } : undefined);
      } catch (err) {
        const chatId = String(message.chat.id);
        log("error", "telegram callback failed", { chatId, data, error: String(err) });
        await this.reportProcessingError(chatId, String(message.message_id), err);
        await ctx.answerCallbackQuery({ text: "Error" }).catch(() => {});
      }
      return;
    }

    const id = match[1]!;
    const accepted = match[2] === "y";
    const pending = this.pendingConfirmations.get(id);

    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Expired" });
      return;
    }

    clearTimeout(pending.timer);
    this.pendingConfirmations.delete(id);
    pending.resolve(accepted);

    const original = ctx.callbackQuery!.message?.text ?? "";
    const label = accepted ? "Accepted" : "Denied";
    await ctx.editMessageText(`${original}\n\n${label}`).catch(() => {});
    await ctx.answerCallbackQuery({ text: label });
  }

  // ── Inbound message handling ────────────────────────────────

  private async handleMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg?.from || msg.from.is_bot) return;

    const userId = String(msg.from.id);
    if (!this.whitelist.has(userId)) return;

    if (msg.message_thread_id) {
      this.messageThreadIds.set(String(msg.message_id), msg.message_thread_id);
      this.pruneThreadIds();
    }

    if (msg.media_group_id) {
      this.bufferMediaGroup(msg);
      return;
    }

    const text = msg.text ?? msg.caption ?? "";
    const batchKey = `${msg.chat.id}:${userId}`;

    if (this.textBatches.has(batchKey) && this.tryAppendToBatch(batchKey, msg)) {
      return;
    }

    if (text.length >= TEXT_BATCH_THRESHOLD) {
      this.startTextBatch(batchKey, msg);
      return;
    }

    await this.processMessage(msg);
  }

  private async processMessage(
    msg: GrammyMessage,
    textOverride?: string,
    extraMessages?: GrammyMessage[],
  ): Promise<void> {
    if (!this.messageHandler) return;

    const chatId = String(msg.chat.id);
    const messageId = msg.message_id;
    const unified = await this.normalizeMessage(msg, textOverride, extraMessages);

    await this.reactions.set(chatId, messageId, "received");
    this.startTyping(chatId, msg.message_thread_id);
    try {
      await this.reactions.set(chatId, messageId, "thinking");
      await this.messageHandler(unified);
      await this.reactions.set(chatId, messageId, "done");
    } catch (err) {
      await this.reactions.set(chatId, messageId, "error");
      log("error", "telegram message handling failed", { chatId, error: String(err) });
      await this.reportProcessingError(chatId, String(messageId), err);
    } finally {
      this.stopTyping(chatId);
    }
  }

  private async reportProcessingError(
    chatId: string,
    replyToId: string | undefined,
    err: unknown,
  ): Promise<void> {
    const errorKey = this.errorReporter.errorKey(err);
    if (!this.errorReporter.shouldReport(errorKey)) return;

    await this.send(chatId, {
      text: "An error occurred while processing your message.",
      replyToId,
    }).catch((sendErr) => {
      log("error", "telegram error reporting failed", { chatId, error: String(sendErr) });
    });
  }

  private async normalizeMessage(
    msg: GrammyMessage,
    textOverride?: string,
    extraMessages?: GrammyMessage[],
  ): Promise<UnifiedMessage> {
    const allMessages = [msg, ...(extraMessages ?? [])];
    const attachmentArrays = await Promise.all(allMessages.map((m) => this.extractAttachments(m)));
    const attachments = attachmentArrays.flat();

    return {
      id: String(msg.message_id),
      platform: "telegram",
      userId: String(msg.from!.id),
      chatId: String(msg.chat.id),
      chatType: msg.chat.type === "private" ? "dm" : "group",
      text: textOverride ?? msg.text ?? msg.caption ?? "",
      attachments,
      isForwarded: !!msg.forward_origin,
      raw: msg,
    };
  }

  private async extractAttachments(msg: GrammyMessage): Promise<Attachment[]> {
    const tasks: Promise<Attachment | null>[] = [];

    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1]!;
      tasks.push(
        this.downloadFile(largest.file_id).then((dl) =>
          dl ? { type: "image" as const, path: dl.path, mimeType: dl.mimeType } : null,
        ),
      );
    }
    if (msg.voice) {
      tasks.push(
        this.downloadFile(msg.voice.file_id).then((dl) =>
          dl
            ? { type: "audio" as const, path: dl.path, mimeType: msg.voice!.mime_type ?? dl.mimeType }
            : null,
        ),
      );
    }
    if (msg.audio) {
      tasks.push(
        this.downloadFile(msg.audio.file_id).then((dl) =>
          dl
            ? { type: "audio" as const, path: dl.path, mimeType: msg.audio!.mime_type ?? dl.mimeType }
            : null,
        ),
      );
    }
    if (msg.video) {
      tasks.push(
        this.downloadFile(msg.video.file_id).then((dl) =>
          dl
            ? { type: "video" as const, path: dl.path, mimeType: msg.video!.mime_type ?? dl.mimeType }
            : null,
        ),
      );
    }
    if (msg.document) {
      tasks.push(
        this.downloadFile(msg.document.file_id).then((dl) =>
          dl
            ? { type: "file" as const, path: dl.path, mimeType: msg.document!.mime_type ?? dl.mimeType }
            : null,
        ),
      );
    }

    const results = await Promise.all(tasks);
    return results.filter((a): a is Attachment => a !== null);
  }

  private async downloadFile(fileId: string): Promise<{ path: string; mimeType?: string } | null> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return null;

      const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const buffer = await res.arrayBuffer();
      const ext = file.file_path.split(".").pop() ?? "bin";
      await mkdir(TMP_DIR, { recursive: true });
      const localPath = join(TMP_DIR, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`);
      await Bun.write(localPath, buffer);

      return { path: localPath, mimeType: res.headers.get("content-type") ?? undefined };
    } catch (err) {
      log("error", "failed to download telegram file", { fileId, error: String(err) });
      return null;
    }
  }

  // ── Text batching ───────────────────────────────────────────

  private startTextBatch(key: string, msg: GrammyMessage): void {
    const text = msg.text ?? msg.caption ?? "";
    const timer = setTimeout(() => this.flushTextBatch(key), TEXT_BATCH_GAP_MS);
    this.textBatches.set(key, {
      messages: [{ text, messageId: msg.message_id, date: msg.date }],
      timer,
      chatId: String(msg.chat.id),
      firstMsg: msg,
    });
  }

  private tryAppendToBatch(key: string, msg: GrammyMessage): boolean {
    const batch = this.textBatches.get(key);
    if (!batch) return false;

    const last = batch.messages[batch.messages.length - 1]!;
    const text = msg.text ?? msg.caption ?? "";
    const idGap = msg.message_id - last.messageId;
    const timeGapMs = (msg.date - last.date) * 1000;
    const totalChars = batch.messages.reduce((s, m) => s + m.text.length, 0) + text.length;

    if (
      idGap > 0 &&
      idGap <= TEXT_BATCH_MAX_ID_GAP &&
      timeGapMs >= 0 &&
      timeGapMs <= TEXT_BATCH_GAP_MS &&
      batch.messages.length < TEXT_BATCH_MAX_PARTS &&
      totalChars <= TEXT_BATCH_MAX_CHARS
    ) {
      batch.messages.push({ text, messageId: msg.message_id, date: msg.date });
      clearTimeout(batch.timer);
      batch.timer = setTimeout(() => this.flushTextBatch(key), TEXT_BATCH_GAP_MS);
      return true;
    }

    return false;
  }

  private flushTextBatch(key: string): void {
    const batch = this.textBatches.get(key);
    if (!batch) return;
    this.textBatches.delete(key);

    const combined = batch.messages.map((m) => m.text).join("");
    this.processMessage(batch.firstMsg, combined).catch((err) =>
      log("error", "failed to process batched message", { error: String(err) }),
    );
  }

  // ── Media group buffering ───────────────────────────────────

  private bufferMediaGroup(msg: GrammyMessage): void {
    const groupId = msg.media_group_id!;
    const existing = this.mediaGroups.get(groupId);

    if (existing) {
      existing.messages.push(msg);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flushMediaGroup(groupId), MEDIA_GROUP_TIMEOUT_MS);
    } else {
      const timer = setTimeout(() => this.flushMediaGroup(groupId), MEDIA_GROUP_TIMEOUT_MS);
      this.mediaGroups.set(groupId, { messages: [msg], timer });
    }
  }

  private flushMediaGroup(groupId: string): void {
    const group = this.mediaGroups.get(groupId);
    if (!group) return;
    this.mediaGroups.delete(groupId);

    group.messages.sort((a, b) => a.message_id - b.message_id);
    const primary = group.messages.find((m) => m.caption) ?? group.messages[0]!;
    const others = group.messages.filter((m) => m !== primary);

    this.processMessage(primary, undefined, others).catch((err) =>
      log("error", "failed to process media group", { error: String(err) }),
    );
  }

  // ── Typing indicator (ref-counted) ──────────────────────────

  private startTyping(chatId: string, threadId?: number): void {
    const existing = this.typingRefs.get(chatId);
    if (existing) {
      existing.count++;
      return;
    }

    const send = () => {
      const params = this.threadParams(threadId);
      this.bot.api.sendChatAction(chatId, "typing", params).catch(() => {});
    };
    send();
    const interval = setInterval(send, TYPING_INTERVAL_MS);
    this.typingRefs.set(chatId, { interval, count: 1 });
  }

  private stopTyping(chatId: string): void {
    const ref = this.typingRefs.get(chatId);
    if (!ref) return;
    ref.count--;
    if (ref.count <= 0) {
      clearInterval(ref.interval);
      this.typingRefs.delete(chatId);
    }
  }

  // ── Thread ID cleanup ──────────────────────────────────────

  private pruneThreadIds(): void {
    if (this.messageThreadIds.size <= MAX_THREAD_ID_ENTRIES) return;
    const toDelete = this.messageThreadIds.size - MAX_THREAD_ID_ENTRIES;
    let deleted = 0;
    for (const key of this.messageThreadIds.keys()) {
      if (deleted >= toDelete) break;
      this.messageThreadIds.delete(key);
      deleted++;
    }
  }

  // ── Webhook (200-first, async processing) ───────────────────

  private async startWebhook(): Promise<void> {
    const wh = this.config.webhook!;

    await this.bot.init();
    await registerCommands(this.bot);
    await this.bot.api.setWebhook(wh.url, { secret_token: wh.secret });

    this.webhookServer = Bun.serve({
      port: wh.port,
      fetch: async (req) => {
        if (req.headers.get("x-telegram-bot-api-secret-token") !== wh.secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        let update: Parameters<typeof this.bot.handleUpdate>[0];
        try {
          update = (await req.json()) as typeof update;
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        // ACK immediately, process in background (prevents Telegram re-delivery)
        void this.bot.handleUpdate(update).catch((err) => {
          log("error", "webhook update processing error", { error: String(err) });
        });

        return new Response("OK", { status: 200 });
      },
    });

    log("info", "telegram webhook started", { port: wh.port, url: wh.url });
  }
}
