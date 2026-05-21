import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelAdapter, UnifiedMessage, OutgoingMessage, Attachment } from "../types.ts";
import type { TelegramChannelConfig } from "../../core/config.ts";
import { MY_CLAW_DIR } from "../../core/config.ts";
import { markdownToTelegramHtml, stripHtml } from "./format.ts";
import { CHUNK_LIMIT, splitHtmlChunks, alignPlainTextChunks } from "./split.ts";
import { registerCommands, getHelpText } from "./commands.ts";
import { ReactionManager } from "./reactions.ts";
import { ErrorReporter, userFacingError } from "./errors.ts";
import { MessageStreamer } from "./stream.ts";
import { createTelegramUpdateDeduper } from "./offset-store.ts";
import {
  isConfiguredTelegramBotUser,
  isTelegramAllowedByPolicy,
  isTelegramChatAllowed,
  resolveTelegramAllowBotsMode,
  resolveTelegramGroupConfig,
  resolveTelegramRequireMention,
  type TelegramChatType,
} from "./policy.ts";
import { extractMediaRefs, stripMediaRefs } from "../../utils/media.ts";
import { telegramLog } from "../../utils/logger.ts";
import { LruMap } from "../../utils/lru-map.ts";
import {
  sendTextMessage,
  sendPlainTextMessage,
  editPlainTextMessage,
  editTextMessage,
  deleteMessage,
  sendMediaByPath,
  sendAttachment,
  threadParams,
  buildKeyboard,
  withRetry,
  type Caption,
} from "./send.ts";
import {
  rememberInboundContext,
  resolveReplyContext,
  resolveThreadRootContext,
  resolveRoomHistoryContext,
  senderLabel,
  type TelegramHistoryEntry,
  type TelegramStoredMessageContext,
} from "./context.ts";

// Text batching (from OpenClaw)
const TEXT_BATCH_THRESHOLD = 4000;
const TEXT_BATCH_GAP_MS = 1500;
const TEXT_BATCH_MAX_PARTS = 12;
const TEXT_BATCH_MAX_CHARS = 50_000;
const TEXT_BATCH_MAX_ID_GAP = 1;

// Media, typing, misc
const MEDIA_GROUP_TIMEOUT_MS = 500;
const CAPTION_LIMIT = 1024;
const TYPING_INTERVAL_MS = 5000;
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_THREAD_ID_ENTRIES = 10_000;
const TMP_DIR = join(MY_CLAW_DIR, "tmp");
const ERROR_REPORT_COOLDOWN_MS = 5 * 60 * 1000;

type GrammyMessage = NonNullable<Context["message"]>;
type AnyGrammyMessage = GrammyMessage | NonNullable<GrammyMessage["reply_to_message"]>;

interface TextBatch {
  messages: Array<{ text: string; messageId: number; date: number }>;
  timer: Timer;
  chatId: string;
  firstMsg: GrammyMessage;
  updateId?: number;
}

interface MediaGroupBuffer {
  messages: GrammyMessage[];
  timer: Timer;
  updateId?: number;
}

interface PendingConfirmation {
  resolve: (accepted: boolean) => void;
  timer: Timer;
}

interface TypingRef {
  interval: Timer;
  count: number;
}

interface TelegramCallbackContext {
  chatId: string;
  userId: string;
  chatType: "dm" | "group";
  messageId: string;
  data: string;
  messageText?: string;
  threadId?: string;
}

interface TelegramCallbackResponse {
  text?: string;
  buttons?: Array<{ label: string; action: string }>;
  answerText?: string;
}

interface TelegramCommandMeta {
  threadId?: string;
}

interface ProcessMessageMeta {
  updateId?: number;
}

function formatTelegramPollText(poll: {
  question?: string;
  options?: Array<{ text?: string; voter_count?: number }>;
  is_closed?: boolean;
  total_voter_count?: number;
}): string {
  const question = poll.question?.trim();
  if (!question) return "";

  const lines = [poll.is_closed ? "[Poll closed]" : "[Poll]", question];
  const options = Array.isArray(poll.options) ? poll.options : [];
  if (options.length > 0) {
    lines.push("");
    for (const [index, option] of options.entries()) {
      const text = option.text?.trim() || `Option ${index + 1}`;
      const votes =
        typeof option.voter_count === "number" && Number.isFinite(option.voter_count)
          ? option.voter_count
          : undefined;
      lines.push(votes === undefined ? `${index + 1}. ${text}` : `${index + 1}. ${text} (${votes} vote${votes === 1 ? "" : "s"})`);
    }
  }

  if (typeof poll.total_voter_count === "number" && Number.isFinite(poll.total_voter_count)) {
    lines.push("", `Total voters: ${poll.total_voter_count}`);
  }

  return lines.join("\n");
}

function updateIdForBatch(current: number | undefined, next: number | undefined): number | undefined {
  if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 0) {
    return current;
  }
  if (typeof current !== "number" || !Number.isSafeInteger(current) || current < 0) {
    return next;
  }
  return Math.max(current, next);
}

// ── Adapter ───────────────────────────────────────────────────

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram" as const;
  private bot: Bot;
  private messageHandler?: (msg: UnifiedMessage) => Promise<void>;
  private commandHandler?: (chatId: string, userId: string, chatType: "dm" | "group", command: string, args: string, meta?: TelegramCommandMeta) => Promise<OutgoingMessage | string | undefined>;
  private callbackHandler?: (ctx: TelegramCallbackContext) => Promise<TelegramCallbackResponse | undefined>;

  private textBatches = new Map<string, TextBatch>();
  private mediaGroups = new Map<string, MediaGroupBuffer>();
  private typingRefs = new Map<string, TypingRef>();
  private historyByScope = new LruMap<string, TelegramHistoryEntry[]>(1000);
  private messageContexts = new Map<string, TelegramStoredMessageContext>();
  private messageThreadIds = new Map<string, number>();
  private pendingConfirmations = new Map<string, PendingConfirmation>();
  private threadRoots = new Map<string, TelegramHistoryEntry>();
  private webhookServer: { stop(): void } | undefined;
  private reactions: ReactionManager;
  private errorReporter: ErrorReporter;
  private selfUserId?: string;
  private selfUsername?: string;
  private updateDeduper?: Awaited<ReturnType<typeof createTelegramUpdateDeduper>>;

  constructor(
    private config: TelegramChannelConfig,
    private whitelist: Set<string>,
    bot?: Bot,
  ) {
    this.bot = bot ?? new Bot(config.token);
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
    this.bot.catch((err) => telegramLog("error", "grammy unhandled error", { error: String(err) }));
    this.updateDeduper = await createTelegramUpdateDeduper({ token: this.config.token });

    this.setupHandlers();

    if (this.config.mode === "webhook" && this.config.webhook) {
      await this.startWebhook();
    } else {
      await this.bot.init();
      this.captureSelfInfo();
      await registerCommands(this.bot);
      this.bot.start({ onStart: () => telegramLog("info", "telegram polling started") });
    }

    await telegramLog("info", "telegram adapter started", { mode: this.config.mode ?? "polling" });
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

    await this.updateDeduper?.stop().catch(() => undefined);

    await this.bot.stop();
    this.webhookServer?.stop();
    await telegramLog("info", "telegram adapter stopped");
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    const mediaRefs = extractMediaRefs(message.text);
    const text = stripMediaRefs(message.text);
    // If the agent explicitly references files via MEDIA: in its text, trust
    // that and do NOT send programmatic attachments (e.g. TTS auto-audio).
    const hasTextRefs = mediaRefs.length > 0;
    const attachmentsToSend = hasTextRefs ? [] : (message.attachments ?? []);

    if (!text && !mediaRefs.length && !attachmentsToSend.length) return;

    const threadId = this.outboundReplyThreadId(message);
    const hasMedia = mediaRefs.length > 0 || attachmentsToSend.length > 0;

    let caption: Caption | undefined;
    if (text && hasMedia && text.length <= CAPTION_LIMIT) {
      const html = markdownToTelegramHtml(text);
      caption = { html, plain: stripHtml(html) };
    }

    const mediaCount = mediaRefs.length + attachmentsToSend.length;
    const textChunkCount = text && !caption ? splitHtmlChunks(markdownToTelegramHtml(text)).length : 0;
    const totalParts = textChunkCount + mediaCount;
    let partIndex = 0;

    if (text && !caption) {
      const html = markdownToTelegramHtml(text);
      const plain = stripHtml(html);
      const htmlChunks = splitHtmlChunks(html);
      const plainChunks = alignPlainTextChunks(plain, htmlChunks.length);

      for (let i = 0; i < htmlChunks.length; i++) {
        await sendTextMessage(this.bot, this.config, chatId, htmlChunks[i]!, plainChunks[i] ?? "", {
          threadId,
          replyToId: this.replyTargetForPart(message, partIndex++, totalParts),
          keyboard:
            i === htmlChunks.length - 1 && message.buttons?.length
              ? buildKeyboard(message.buttons)
              : undefined,
        });
      }
    }

    let usedCaption = false;
    for (const ref of mediaRefs) {
      const cap = !usedCaption ? caption : undefined;
      await sendMediaByPath(this.bot, chatId, ref.path, threadId, this.replyTargetForPart(message, partIndex++, totalParts), cap);
      if (cap) usedCaption = true;
    }
    for (const att of attachmentsToSend) {
      const cap = !usedCaption ? caption : undefined;
      await sendAttachment(this.bot, chatId, att, threadId, this.replyTargetForPart(message, partIndex++, totalParts), cap);
      if (cap) usedCaption = true;
    }
  }

  onMessage(handler: (msg: UnifiedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onCommand(handler: (chatId: string, userId: string, chatType: "dm" | "group", command: string, args: string, meta?: TelegramCommandMeta) => Promise<OutgoingMessage | string | undefined>): void {
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
        replyToId: this.streamReplyTarget(message),
        replyMode: this.replyToMode(),
        minCharsBeforeSend: this.config.streaming?.minChars ?? 30,
        editThrottleMs: this.config.streaming?.throttleMs ?? 1000,
        chunkLimit: CHUNK_LIMIT,
      },
      {
        sendPlain: (chatId, text, opts) => sendPlainTextMessage(this.bot, this.config, chatId, text, opts),
        editPlain: (chatId, messageId, text) => editPlainTextMessage(this.bot, this.config, chatId, messageId, text),
        sendFinal: (chatId, html, plain, opts) => sendTextMessage(this.bot, this.config, chatId, html, plain, opts),
        editFinal: (chatId, messageId, html, plain) => editTextMessage(this.bot, this.config, chatId, messageId, html, plain),
        deleteMessage: (chatId, messageId) => deleteMessage(this.bot, chatId, messageId),
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

    await withRetry(() => this.bot.api.sendMessage(chatId, text, params));

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingConfirmations.delete(id);
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);

      this.pendingConfirmations.set(id, { resolve, timer });
    });
  }

  // ── Handlers ────────────────────────────────────────────────

  private setupHandlers(): void {
    this.bot.hears(/^\/new(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "new"));
    this.bot.hears(/^\/model(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "model"));
    this.bot.hears(/^\/models(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "models"));
    this.bot.hears(/^\/compact(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "compact"));
    this.bot.hears(/^\/reload(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "reload"));
    this.bot.hears(/^\/verbose(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "verbose"));
    this.bot.hears(/^\/status(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "status"));
    this.bot.hears(/^\/clear(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "clear"));
    this.bot.hears(/^\/archive(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "archive"));
    this.bot.hears(/^\/help(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "help"));
    this.bot.hears(/^\/commands(?:@\w+)?(\s|$)/, (ctx) => this.handleCommand(ctx, "help"));
    this.bot.on("callback_query:data", (ctx) => this.handleCallbackQuery(ctx));
    this.bot.on("message", (ctx) => this.handleMessage(ctx));
  }

  private async handleCommand(ctx: Context, command: string): Promise<void> {
    const claimed = this.claimUpdate(ctx.update.update_id);
    if (!claimed) return;

    const msg = ctx.message;
    if (!msg?.from || !this.shouldProcessMessage(msg)) {
      this.releaseClaimedUpdate(ctx.update.update_id);
      return;
    }

    const userId = String(msg.from.id);
    await telegramLog("info", "telegram command received", { command, userId, text: msg.text ?? msg.caption });

    if (command === "help" || command === "commands") {
      await ctx.reply(getHelpText());
      await this.commitProcessedUpdate(ctx.update.update_id);
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
        const response = await this.commandHandler(chatId, userId, chatType, command, args, {
          threadId: typeof threadId === "number" ? String(threadId) : undefined,
        });
        if (!response) {
          await telegramLog("info", "telegram command handled with no response", { command, chatId });
          await this.commitProcessedUpdate(ctx.update.update_id);
          return;
        }

        const replyToId = messageId ? String(messageId) : undefined;
        if (typeof response === "string") {
          await this.send(chatId, { text: response, replyToId });
          await telegramLog("info", "telegram command response sent", { command, chatId });
          await this.commitProcessedUpdate(ctx.update.update_id);
          return;
        }

        await this.send(chatId, {
          ...response,
          replyToId: response.replyToId ?? replyToId,
        });
        await telegramLog("info", "telegram command response sent", { command, chatId });
        await this.commitProcessedUpdate(ctx.update.update_id);
      } catch (err) {
        await telegramLog("error", "telegram command failed", { command, chatId, error: String(err) });
        await this.reportProcessingError(chatId, messageId ? String(messageId) : undefined, err);
        this.releaseClaimedUpdate(ctx.update.update_id);
      }
    } else {
      this.releaseClaimedUpdate(ctx.update.update_id);
    }
  }

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    const claimed = this.claimUpdate(ctx.update.update_id);
    if (!claimed) return;

    const data = ctx.callbackQuery?.data;
    if (!data) {
      this.releaseClaimedUpdate(ctx.update.update_id);
      return;
    }

    const userId = String(ctx.from?.id);
    if (!this.whitelist.has(userId)) {
      await ctx.answerCallbackQuery({ text: "Not authorized. Contact the bot owner if you think this is an error." });
      this.releaseClaimedUpdate(ctx.update.update_id);
      return;
    }

    const match = data.match(/^cfm:(\w+):(y|n)$/);
    if (!match) {
      const message = ctx.callbackQuery?.message;
      if (!message || !this.callbackHandler) {
        await ctx.answerCallbackQuery();
        this.releaseClaimedUpdate(ctx.update.update_id);
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
          threadId: typeof message.message_thread_id === "number" ? String(message.message_thread_id) : undefined,
        });

        if (!response) {
          await ctx.answerCallbackQuery();
          await this.commitProcessedUpdate(ctx.update.update_id);
          return;
        }

        const params: Record<string, unknown> = {};
        if (response.buttons?.length) {
          params.reply_markup = buildKeyboard(response.buttons);
        }
        if (response.text) {
          await ctx.editMessageText(response.text, params).catch((e) => { telegramLog("debug", "edit callback message failed", { error: String(e) }).catch(() => {}); });
        }
        await ctx.answerCallbackQuery(response.answerText ? { text: response.answerText } : undefined);
        await this.commitProcessedUpdate(ctx.update.update_id);
      } catch (err) {
        const chatId = String(message.chat.id);
        await telegramLog("error", "telegram callback failed", { chatId, data, error: String(err) });
        await this.reportProcessingError(chatId, String(message.message_id), err);
        await ctx.answerCallbackQuery({ text: "Something went wrong. Try again or use /help." }).catch((e) => { telegramLog("debug", "answer callback query failed", { error: String(e) }).catch(() => {}); });
        this.releaseClaimedUpdate(ctx.update.update_id);
      }
      return;
    }

    const id = match[1]!;
    const accepted = match[2] === "y";
    const pending = this.pendingConfirmations.get(id);

    if (!pending) {
      await ctx.answerCallbackQuery({ text: "This action has expired. Please try again." });
      await this.commitProcessedUpdate(ctx.update.update_id);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingConfirmations.delete(id);
    pending.resolve(accepted);

    const original = ctx.callbackQuery!.message?.text ?? "";
    const label = accepted ? "Accepted" : "Denied";
    await ctx.editMessageText(`${original}\n\n${label}`).catch((e) => { telegramLog("debug", "edit confirmation message failed", { error: String(e) }).catch(() => {}); });
    await ctx.answerCallbackQuery({ text: label });
    await this.commitProcessedUpdate(ctx.update.update_id);
  }

  // ── Inbound message handling ────────────────────────────────

  private async handleMessage(ctx: Context): Promise<void> {
    const claimed = this.claimUpdate(ctx.update.update_id);
    if (!claimed) return;

    const msg = ctx.message;
    if (!msg?.from) {
      this.releaseClaimedUpdate(ctx.update.update_id);
      return;
    }
    if (!this.shouldProcessMessage(msg)) {
      await this.commitProcessedUpdate(ctx.update.update_id);
      return;
    }

    const userId = String(msg.from.id);

    if (msg.message_thread_id) {
      this.messageThreadIds.set(String(msg.message_id), msg.message_thread_id);
      this.pruneThreadIds();
    }

    if (msg.media_group_id) {
      this.bufferMediaGroup(msg, ctx.update.update_id);
      return;
    }

    const text = this.messageTextFromRawMessage(msg) ?? "";

    // Defensive fallback: if bot.hears() missed it (no regex match),
    // intercept known commands before routing them as regular messages.
    // Strip optional @botname suffix that Telegram appends in groups.
    if (text.startsWith("/")) {
      const raw = text.slice(1).split(/\s+/)[0]!;
      const command = raw.split("@")[0]!;
      if (["new", "clear", "model", "models", "compact", "reload", "verbose", "status", "archive", "help", "commands"].includes(command)) {
        await this.handleCommand(ctx, command);
        return;
      }
    }

    const batchKey = `${msg.chat.id}:${userId}`;

    if (this.textBatches.has(batchKey) && this.tryAppendToBatch(batchKey, msg, ctx.update.update_id)) {
      return;
    }

    if (text.length >= TEXT_BATCH_THRESHOLD) {
      this.startTextBatch(batchKey, msg, ctx.update.update_id);
      return;
    }

    await this.processMessage(msg, undefined, undefined, { updateId: ctx.update.update_id });
  }

  private async processMessage(
    msg: GrammyMessage,
    textOverride?: string,
    extraMessages?: GrammyMessage[],
    meta?: ProcessMessageMeta,
  ): Promise<void> {
    if (!this.messageHandler) return;

    const chatId = String(msg.chat.id);
    const messageId = msg.message_id;
    const unified = await this.normalizeMessage(msg, textOverride, extraMessages);
    rememberInboundContext(this.config, this.whitelist, this.historyByScope, this.messageContexts, this.threadRoots, unified);

    await this.reactions.set(chatId, messageId, "received");
    this.startTyping(chatId, msg.message_thread_id);
    try {
      await this.reactions.set(chatId, messageId, "thinking");
      await this.messageHandler(unified);
      await this.commitProcessedUpdate(meta?.updateId);
      await this.reactions.set(chatId, messageId, "done");
    } catch (err) {
      this.releaseClaimedUpdate(meta?.updateId);
      await this.reactions.set(chatId, messageId, "error");
      await telegramLog("error", "telegram message handling failed", { chatId, error: String(err) });
      await this.reportProcessingError(chatId, String(messageId), err);
    } finally {
      this.stopTyping(chatId, msg.message_thread_id);
    }
  }

  private claimUpdate(updateId: number | null | undefined): boolean {
    return this.updateDeduper?.claimUpdate(updateId) ?? true;
  }

  private async commitProcessedUpdate(updateId: number | null | undefined): Promise<void> {
    if (!this.updateDeduper) return;
    await this.updateDeduper.commitUpdate(this.config.token, updateId);
  }

  private releaseClaimedUpdate(updateId: number | null | undefined): void {
    this.updateDeduper?.releaseUpdate(updateId);
  }

  private async reportProcessingError(
    chatId: string,
    replyToId: string | undefined,
    err: unknown,
  ): Promise<void> {
    const errorKey = this.errorReporter.errorKey(err);
    if (!this.errorReporter.shouldReport(errorKey)) return;

    await this.send(chatId, {
      text: userFacingError(errorKey),
      replyToId,
    }).catch((sendErr) => {
      void telegramLog("error", "telegram error reporting failed", { chatId, error: String(sendErr) });
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
    const chatId = String(msg.chat.id);
    const chatType = msg.chat.type === "private" ? "dm" : "group";
    const threadId = typeof msg.message_thread_id === "number" ? String(msg.message_thread_id) : undefined;
    const replyMessage = msg.reply_to_message;
    const replyContext = replyMessage
      ? resolveReplyContext(this.config, this.whitelist, this.messageContexts, chatId, chatType, replyMessage, threadId, (m) => this.messageTextFromRawMessage(m))
      : undefined;
    const threadRoot = threadId ? resolveThreadRootContext(this.config, this.whitelist, this.messageContexts, this.threadRoots, this.historyByScope, chatId, chatType, threadId) : undefined;

    return {
      id: String(msg.message_id),
      platform: "telegram",
      userId: String(msg.from?.id ?? msg.sender_chat?.id ?? "unknown"),
      chatId,
      chatType,
      text: this.normalizedMessageText(msg, textOverride),
      attachments,
      isForwarded: !!msg.forward_origin,
      replyToId: replyContext?.messageId,
      replyToText: replyContext?.text,
      replyToSender: replyContext?.senderLabel,
      threadId,
      threadRootText: threadRoot?.text,
      roomContext: resolveRoomHistoryContext(this.config, this.whitelist, this.messageContexts, this.historyByScope, chatId, chatType, threadId),
      mentionsBot: this.resolveMentionsBot(msg),
      sessionScope: chatType === "dm" ? this.config.dm?.sessionScope ?? "per-user" : undefined,
      raw: msg,
    };
  }

  private captureSelfInfo(): void {
    if (!this.bot.botInfo) return;
    this.selfUserId = String(this.bot.botInfo.id);
    this.selfUsername = this.bot.botInfo.username?.toLowerCase();
  }

  private normalizedMessageText(msg: GrammyMessage, textOverride?: string): string {
    if (textOverride !== undefined) return textOverride;
    return this.messageTextFromRawMessage(msg) ?? "";
  }

  private messageTextFromRawMessage(msg: AnyGrammyMessage): string | undefined {
    const text = (msg.text ?? msg.caption)?.trim();
    if (text) return text;
    if (msg.poll) {
      const pollText = formatTelegramPollText(msg.poll);
      if (pollText) return pollText;
    }
    return undefined;
  }

  private shouldProcessMessage(msg: GrammyMessage): boolean {
    const chatType: TelegramChatType = msg.chat.type === "private" ? "dm" : "group";
    const chatId = String(msg.chat.id);
    const threadId = typeof msg.message_thread_id === "number" ? String(msg.message_thread_id) : undefined;
    const groupConfig = resolveTelegramGroupConfig(this.config, chatId, threadId);

    if (!isTelegramChatAllowed(this.config, groupConfig, chatType)) {
      return false;
    }
    if (!isTelegramAllowedByPolicy({
      config: this.config,
      whitelist: this.whitelist,
      groupConfig,
      sender: msg.from,
      chatType,
    })) {
      return false;
    }

    const mentionedBot = this.resolveMentionsBot(msg);
    if (isConfiguredTelegramBotUser(this.config, this.selfUserId, msg.from)) {
      const allowBotsMode = resolveTelegramAllowBotsMode(this.config, groupConfig);
      if (allowBotsMode === "off") {
        return false;
      }
      if (allowBotsMode === "mentions" && chatType === "group" && !mentionedBot) {
        return false;
      }
    }

    if (chatType === "dm") {
      return true;
    }
    if (!resolveTelegramRequireMention(groupConfig)) {
      return true;
    }
    if (mentionedBot) {
      return true;
    }
    return this.isAddressedGroupCommand(msg);
  }

  private isAddressedGroupCommand(msg: GrammyMessage): boolean {
    const entities = msg.entities ?? msg.caption_entities ?? [];
    const text = msg.text ?? msg.caption ?? "";
    const commandEntity = entities.find((entity) => entity.type === "bot_command" && entity.offset === 0);
    if (!commandEntity) return false;

    const commandText = text.slice(commandEntity.offset, commandEntity.offset + commandEntity.length);
    if (!commandText.startsWith("/")) return false;

    const atIndex = commandText.indexOf("@");
    if (atIndex === -1 || !this.selfUsername) return false;
    return commandText.slice(atIndex + 1).toLowerCase() === this.selfUsername;
  }

  private outboundReplyThreadId(message: OutgoingMessage): number | undefined {
    if (message.threadId) {
      const parsed = Math.trunc(Number(message.threadId));
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return message.replyToId ? this.messageThreadIds.get(message.replyToId) : undefined;
  }

  private replyToMode(): "off" | "first" | "all" {
    if (this.config.replyToMode) {
      return this.config.replyToMode;
    }

    const legacyMode = this.config.threadReplies ?? "off";
    if (legacyMode === "always") return "all";
    if (legacyMode === "inbound") return "first";
    return "off";
  }

  private streamReplyTarget(message: UnifiedMessage): number | undefined {
    const replyToId = Math.trunc(Number(message.id));
    if (!Number.isFinite(replyToId) || replyToId <= 0) return undefined;
    return this.replyToMode() === "off" ? undefined : replyToId;
  }

  private replyTargetForPart(
    message: OutgoingMessage,
    partIndex: number,
    partCount: number,
  ): number | undefined {
    const replyToId = message.replyToId ? Math.trunc(Number(message.replyToId)) : undefined;
    if (!replyToId) return undefined;

    const mode = this.replyToMode();
    if (mode === "off") return undefined;

    if (partCount <= 1) return replyToId;
    if (mode === "all") return replyToId;
    if (mode === "first") return partIndex === 0 ? replyToId : undefined;
    return undefined;
  }

  private isReplyToSelf(message: GrammyMessage["reply_to_message"]): boolean {
    if (!message?.from?.is_bot) return false;
    if (this.selfUserId && String(message.from.id) === this.selfUserId) {
      return true;
    }
    if (this.selfUsername && message.from.username?.toLowerCase() === this.selfUsername) {
      return true;
    }
    return false;
  }

  private resolveMentionsBot(msg: GrammyMessage): boolean {
    const entities = msg.entities ?? msg.caption_entities ?? [];
    const text = msg.text ?? msg.caption ?? "";

    for (const entity of entities) {
      if (entity.type === "mention" && this.selfUsername) {
        const mention = text
          .slice(entity.offset, entity.offset + entity.length)
          .replace(/^@/, "")
          .toLowerCase();
        if (mention === this.selfUsername) {
          return true;
        }
      }
      if (entity.type === "text_mention" && this.selfUserId && String(entity.user.id) === this.selfUserId) {
        return true;
      }
    }

    return this.isReplyToSelf(msg.reply_to_message);
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

      await telegramLog("info", "telegram file downloaded", { path: localPath, size: buffer.byteLength, mimeType: res.headers.get("content-type") });

      return { path: localPath, mimeType: res.headers.get("content-type") ?? undefined };
    } catch (err) {
      await telegramLog("error", "failed to download telegram file", { fileId, error: String(err) });
      return null;
    }
  }

  // ── Text batching ───────────────────────────────────────────

  private startTextBatch(key: string, msg: GrammyMessage, updateId?: number): void {
    const text = msg.text ?? msg.caption ?? "";
    const timer = setTimeout(() => this.flushTextBatch(key), TEXT_BATCH_GAP_MS);
    this.textBatches.set(key, {
      messages: [{ text, messageId: msg.message_id, date: msg.date }],
      timer,
      chatId: String(msg.chat.id),
      firstMsg: msg,
      updateId,
    });
  }

  private tryAppendToBatch(key: string, msg: GrammyMessage, updateId?: number): boolean {
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
      batch.updateId = updateIdForBatch(batch.updateId, updateId);
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
    this.processMessage(batch.firstMsg, combined, undefined, { updateId: batch.updateId }).catch((err) => {
      this.releaseClaimedUpdate(batch.updateId);
      telegramLog("error", "failed to process batched message", { error: String(err) });
    });
  }

  // ── Media group buffering ───────────────────────────────────

  private bufferMediaGroup(msg: GrammyMessage, updateId?: number): void {
    const groupId = msg.media_group_id!;
    const existing = this.mediaGroups.get(groupId);

    if (existing) {
      existing.messages.push(msg);
      existing.updateId = updateIdForBatch(existing.updateId, updateId);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flushMediaGroup(groupId), MEDIA_GROUP_TIMEOUT_MS);
    } else {
      const timer = setTimeout(() => this.flushMediaGroup(groupId), MEDIA_GROUP_TIMEOUT_MS);
      this.mediaGroups.set(groupId, { messages: [msg], timer, updateId });
    }
  }

  private flushMediaGroup(groupId: string): void {
    const group = this.mediaGroups.get(groupId);
    if (!group) return;
    this.mediaGroups.delete(groupId);

    group.messages.sort((a, b) => a.message_id - b.message_id);
    const primary = group.messages.find((m) => m.caption) ?? group.messages[0]!;
    const others = group.messages.filter((m) => m !== primary);

    this.processMessage(primary, undefined, others, { updateId: group.updateId }).catch((err) => {
      this.releaseClaimedUpdate(group.updateId);
      telegramLog("error", "failed to process media group", { error: String(err) });
    });
  }

  // ── Typing indicator (ref-counted) ──────────────────────────

  private startTyping(chatId: string, threadId?: number): void {
    const key = threadId ? `${chatId}:${threadId}` : chatId;
    const existing = this.typingRefs.get(key);
    if (existing) {
      existing.count++;
      return;
    }

    const send = () => {
      const params = threadParams(threadId);
      this.bot.api.sendChatAction(chatId, "typing", params).catch((e) => { telegramLog("debug", "send typing indicator failed", { error: String(e) }).catch(() => {}); });
    };
    send();
    const interval = setInterval(send, TYPING_INTERVAL_MS);
    this.typingRefs.set(key, { interval, count: 1 });
  }

  private stopTyping(chatId: string, threadId?: number): void {
    const key = threadId ? `${chatId}:${threadId}` : chatId;
    const ref = this.typingRefs.get(key);
    if (!ref) return;
    ref.count--;
    if (ref.count <= 0) {
      clearInterval(ref.interval);
      this.typingRefs.delete(key);
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
    this.captureSelfInfo();
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

        void this.bot.handleUpdate(update).catch((err) => {
          void telegramLog("error", "webhook update processing error", { error: String(err) });
        });

        return new Response("OK", { status: 200 });
      },
    });

    await telegramLog("info", "telegram webhook started", { port: wh.port, url: wh.url });
  }
}
