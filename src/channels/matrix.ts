import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { EventType, MsgType, RelationType, RoomEvent } from "matrix-js-sdk";
import { MY_CLAW_DIR } from "../config.ts";
import type { MatrixChannelConfig } from "../config.ts";
import { extractMediaRefs, stripMediaRefs } from "../utils/media.ts";
import { matrixLog } from "../utils/logger.ts";
import { MatrixClientRuntime } from "./matrix-client.ts";
import { shouldIncludeSupplementalContext } from "./context-visibility.ts";
import { getMatrixHelpText, parseMatrixCommand } from "./matrix-commands.ts";
import { MatrixErrorReporter } from "./matrix-errors.ts";
import {
  createMatrixRoomHistoryTracker,
  type PreparedMatrixRoomHistory,
} from "./matrix-history.ts";
import {
  buildMatrixFormattedText,
  prefixEditedMatrixFormattedBody,
  resolveInboundMatrixMentions,
  stripMatrixMentionPrefix,
} from "./matrix-format.ts";
import { MatrixReactionManager } from "./matrix-reactions.ts";
import {
  fetchMatrixPollSnapshot,
  isMatrixPollEventType,
  resolveMatrixPollPrecheckText,
} from "./matrix-polls.ts";
import { MatrixMessageStreamer } from "./matrix-stream.ts";
import { chunkMatrixText } from "./matrix-text.ts";
import type {
  Attachment,
  ChannelAdapter,
  ConfirmationButton,
  OutgoingMessage,
  UnifiedMessage,
} from "./types.ts";

const TYPING_TIMEOUT_MS = 5000;
const TYPING_REFRESH_MS = 4000;
const ERROR_REPORT_COOLDOWN_MS = 5 * 60 * 1000;
const MATRIX_TMP_DIR = join(MY_CLAW_DIR, "tmp");
const MATRIX_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
const MATRIX_PENDING_ACTION_TTL_MS = 6 * 60 * 60 * 1000;
const MATRIX_PENDING_ACTION_LIMIT = 128;
const MATRIX_REACTION_BUTTON_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

type MatrixChatType = "dm" | "group";

type MatrixCommandHandler = (
  chatId: string,
  userId: string,
  chatType: MatrixChatType,
  command: string,
  args: string,
  meta?: { roomId?: string; threadId?: string },
) => Promise<OutgoingMessage | string | undefined>;

type MatrixActionHandler = (ctx: {
  chatId: string;
  userId: string;
  chatType: MatrixChatType;
  data: string;
  messageId: string;
  threadId?: string;
  reactionKey?: string;
}) => Promise<
  | {
      text?: string;
      buttons?: ConfirmationButton[];
      answerText?: string;
    }
  | undefined
>;

type TypingRef = {
  interval: ReturnType<typeof setInterval>;
  count: number;
};

type MatrixEventContent = Record<string, unknown>;
type MatrixRoomConfig = NonNullable<MatrixChannelConfig["groups"]>[string];
type PendingMatrixAction = {
  buttons: ConfirmationButton[];
  threadId?: string;
  expiresAt: number;
};
type IngressTail = Promise<void>;
type MatrixMediaInfo = {
  mimetype?: string;
  size?: number;
  w?: number;
  h?: number;
  duration?: number;
};
type MatrixEncryptedFile = {
  url: string;
  key?: Record<string, unknown>;
  iv?: string;
  hashes?: Record<string, string>;
  v?: string;
};

type MatrixCryptoFacade = {
  encryptMedia?: (
    buffer: Buffer,
  ) => Promise<{
    buffer: Buffer;
    file: Omit<MatrixEncryptedFile, "url">;
  }>;
  decryptMedia?: (
    file: MatrixEncryptedFile,
    opts?: { maxBytes?: number; readIdleTimeoutMs?: number },
  ) => Promise<Buffer>;
  isRoomEncrypted?: (roomId: string) => Promise<boolean>;
};

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveMatrixMessageAttachmentSummary(params: {
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
  const body = trimString(params.body);
  const filename = trimString(params.filename);

  if (!marker) return body ?? filename;
  if (body && filename && body !== filename) return `${body}\n\n${marker}`;
  if (body && !/\.[A-Za-z0-9]{2,8}$/.test(body)) return `${body}\n\n${marker}`;
  return marker;
}

function relationRecord(content: MatrixEventContent): Record<string, unknown> | undefined {
  const relation = content["m.relates_to"];
  return relation && typeof relation === "object" ? (relation as Record<string, unknown>) : undefined;
}

function relationEventId(content: MatrixEventContent): string | undefined {
  const relation = relationRecord(content);
  const replyTo = relation?.["m.in_reply_to"];
  if (!replyTo || typeof replyTo !== "object") return undefined;
  return trimString((replyTo as Record<string, unknown>).event_id);
}

function threadRelationId(content: MatrixEventContent): string | undefined {
  const relation = relationRecord(content);
  return relation?.rel_type === RelationType.Thread ? trimString(relation.event_id) : undefined;
}

function extFromFilename(filename?: string): string {
  const ext = filename ? extname(filename) : "";
  return ext || "";
}

function normalizeMatrixUserId(value?: string): string {
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

function matrixUserListIncludes(list: string[] | undefined, userId: string): boolean {
  const normalizedUserId = normalizeMatrixUserId(userId);
  if (!normalizedUserId) return false;

  return (list ?? []).some((entry) => normalizeMatrixUserId(entry) === normalizedUserId);
}

function limitRecentItems<T>(items: T[], limit: number): T[] {
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

function buildRelation(threadId?: string, replyToId?: string): Record<string, unknown> | undefined {
  if (threadId?.trim()) return buildThreadRelation(threadId.trim(), replyToId);
  return buildReplyRelation(replyToId);
}

function buildReplaceRelation(eventId: string, threadId?: string): Record<string, unknown> {
  const relation: Record<string, unknown> = {
    rel_type: RelationType.Replace,
    event_id: eventId,
  };
  if (threadId?.trim()) {
    relation["m.in_reply_to"] = { event_id: threadId.trim() };
  }
  return relation;
}

function normalizeRoomKey(value: string): string {
  return value.trim();
}

function matrixAttachmentTypeFromMsgType(msgtype?: string): Attachment["type"] {
  switch (msgtype) {
    case MsgType.Image:
      return "image";
    case MsgType.Audio:
      return "audio";
    case MsgType.Video:
      return "video";
    default:
      return "file";
  }
}

function messageBody(content: MatrixEventContent): string {
  return typeof content.body === "string" ? content.body : "";
}

function threadRootId(event: MatrixEvent): string | undefined {
  const relation = event.getRelation();
  if (relation?.rel_type === RelationType.Thread && typeof relation.event_id === "string") {
    return relation.event_id;
  }
  const thread = event.getThread();
  const rootId = thread?.id;
  return typeof rootId === "string" && rootId.length > 0 ? rootId : undefined;
}

function replyToEventId(event: MatrixEvent): string | undefined {
  const relation = event.getRelation();
  const replyTo = relation?.["m.in_reply_to"]?.event_id;
  return typeof replyTo === "string" && replyTo.length > 0 ? replyTo : undefined;
}

function resolveAutoJoinAllowed(roomId: string, config: MatrixChannelConfig): boolean {
  const mode = config.autoJoin ?? "off";
  if (mode === "always") return true;
  if (mode === "off") return false;
  const allowlist = config.autoJoinAllowlist ?? [];
  return allowlist.includes("*") || allowlist.includes(roomId);
}

export class MatrixAdapter implements ChannelAdapter {
  readonly platform = "matrix" as const;
  private runtime;
  private messageHandler?: (message: UnifiedMessage) => Promise<void>;
  private commandHandler?: MatrixCommandHandler;
  private actionHandler?: MatrixActionHandler;
  private reactions: MatrixReactionManager;
  private errorReporter: MatrixErrorReporter;
  private pendingActions = new Map<string, PendingMatrixAction>();
  private roomHistory = createMatrixRoomHistoryTracker();
  private roomIngressTails = new Map<string, IngressTail>();
  private typingRefs = new Map<string, TypingRef>();
  private selfUserId?: string;

  constructor(
    private config: MatrixChannelConfig,
    private whitelist: Set<string>,
    runtime?: MatrixClientRuntime,
  ) {
    this.runtime =
      runtime ??
      new MatrixClientRuntime({
        homeserver: config.homeserver,
        accessToken: config.accessToken,
        encryption: config.encryption,
        userId: config.userId,
        password: config.password,
        deviceId: config.deviceId,
        initialSyncLimit: config.initialSyncLimit,
      });
    this.reactions = new MatrixReactionManager(this.runtime.sdk, {
      enabled: config.reactions?.enabled ?? false,
      emojis: {
        received: config.reactions?.received ?? "👀",
        thinking: config.reactions?.thinking ?? "🧠",
        tool_use: config.reactions?.toolUse ?? "⚙️",
        done: config.reactions?.done ?? "✅",
        error: config.reactions?.error ?? "⚠️",
      },
    });
    this.errorReporter = new MatrixErrorReporter({
      mode: config.errorPolicy ?? "always",
      onceCooldownMs: ERROR_REPORT_COOLDOWN_MS,
    });
  }

  async start(): Promise<void> {
    this.runtime.onTimeline((payload) => this.handleTimeline(payload.room, payload.event, payload.toStartOfTimeline, payload.removed));
    this.runtime.sdk.on(RoomEvent.MyMembership, this.handleMembershipChange);
    await this.runtime.start();
    this.selfUserId = this.runtime.sdk.getUserId() ?? this.config.userId;
    await matrixLog("info", "matrix adapter started", { homeserver: this.config.homeserver });
  }

  async stop(): Promise<void> {
    this.runtime.sdk.off(RoomEvent.MyMembership, this.handleMembershipChange);
    for (const ref of this.typingRefs.values()) {
      clearInterval(ref.interval);
    }
    this.typingRefs.clear();
    this.pendingActions.clear();
    await this.runtime.stop();
    await matrixLog("info", "matrix adapter stopped");
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    const mediaRefs = extractMediaRefs(message.text);
    const text = stripMediaRefs(message.text);
    const hasMedia = mediaRefs.length > 0 || (message.attachments?.length ?? 0) > 0;

    let actionAnchorEventId: string | undefined;

    const textChunks = chunkMatrixText(text, this.textChunkLimit(), this.chunkMode());
    for (let index = 0; index < textChunks.length; index++) {
      const chunk = textChunks[index]!;
      const formatted = buildMatrixFormattedText(chunk);
      const relation = buildRelation(
        message.threadId,
        this.replyTargetForChunk(message, index, {
          chunkCount: textChunks.length,
          hasMedia,
        }),
      );
      const content: Record<string, unknown> = {
        msgtype: message.notice ? MsgType.Notice : MsgType.Text,
        body: formatted.body,
      };
      if (formatted.formatted_body) {
        content["format"] = "org.matrix.custom.html";
        content["formatted_body"] = formatted.formatted_body;
      }
      if (formatted.mentions) {
        content["m.mentions"] = formatted.mentions;
      }
      if (relation) {
        content["m.relates_to"] = relation;
      }

      const sent = await this.runtime.sdk.sendMessage(chatId, content as never);
      if (index === 0) {
        actionAnchorEventId = sent.event_id;
      }
    }

    if (actionAnchorEventId && message.buttons?.length) {
      this.rememberPendingAction(chatId, actionAnchorEventId, message.buttons, message.threadId);
    }

    if (!hasMedia) return;

    for (const ref of mediaRefs) {
      await this.sendMediaByPath(chatId, ref.path, message.replyToId, message.threadId);
    }
    for (const attachment of message.attachments ?? []) {
      await this.sendAttachment(chatId, attachment, message.replyToId, message.threadId);
    }
  }

  onMessage(handler: (message: UnifiedMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onCommand(handler: MatrixCommandHandler): void {
    this.commandHandler = handler;
  }

  onAction(handler: MatrixActionHandler): void {
    this.actionHandler = handler;
  }

  streamingEnabled(): boolean {
    return this.config.streaming?.enabled === true;
  }

  createStreamer(message: UnifiedMessage): MatrixMessageStreamer {
    const replyToId = this.streamReplyTarget(message);
    return new MatrixMessageStreamer(this.runtime.sdk, {
      roomId: message.chatId,
      threadId: message.threadId,
      replyToId,
      preserveReplyId: (this.config.replyToMode ?? "off") === "all",
      sendFinal: (text, finalReplyToId) =>
        this.send(message.chatId, {
          text,
          replyToId: finalReplyToId,
          threadId: message.threadId,
        }),
      mode: this.config.streaming?.mode ?? "partial",
      minCharsBeforeSend: this.config.streaming?.minChars ?? 30,
      editThrottleMs: this.config.streaming?.throttleMs ?? 1000,
      chunkLimit: this.textChunkLimit(),
    });
  }

  private async handleTimeline(
    room: Room,
    event: MatrixEvent,
    toStartOfTimeline: boolean,
    removed: boolean,
  ): Promise<void> {
    await this.handleTimelineEvent(room, event, toStartOfTimeline, removed);
  }

  private async handleTimelineEvent(
    room: Room,
    event: MatrixEvent,
    toStartOfTimeline: boolean,
    removed: boolean,
  ): Promise<void> {
    if (toStartOfTimeline || removed) return;
    const eventType = event.getType();
    if (eventType === EventType.RoomMessageEncrypted && event.isDecryptionFailure()) {
      return;
    }
    if (eventType === EventType.Reaction) {
      await this.handleReaction(room, event);
      return;
    }
    const sender = event.getSender();
    if (!sender || sender === this.selfUserId) return;

    const chatType = this.isDirectMessage(room) ? "dm" : "group";
    const historyLimit = this.historyLimitForChatType(chatType);
    const ingress =
      chatType === "group" && historyLimit > 0
        ? await this.runRoomIngress(room.roomId, async () =>
            this.handleTimelineEventIngress(room, event, eventType, sender, chatType, historyLimit),
          )
        : await this.handleTimelineEventIngress(room, event, eventType, sender, chatType, historyLimit);
    if (!ingress) return;

    const { content, text, rootThreadId, replyId, selfDisplayName, preparedRoomHistory, shouldProcess } = ingress;
    const roomId = room.roomId;
    const mentions = resolveInboundMatrixMentions({
      content,
      text,
      userId: this.selfUserId ?? this.config.userId,
      displayName: selfDisplayName,
    });
    if (this.isBotUser(sender)) {
      const allowBotsMode = this.allowBotsModeForRoom(room);
      if (allowBotsMode === "off") return;
      if (allowBotsMode === "mentions" && chatType === "group" && !mentions.mentionedBot) return;
    }

    const commandText = this.commandText(text, room, selfDisplayName);
    const parsedCommand = commandText ? parseMatrixCommand(commandText) : null;
    if (parsedCommand && this.commandHandler) {
      if (parsedCommand.command === "help") {
        await this.send(roomId, {
          text: getMatrixHelpText(),
          replyToId: event.getId(),
          threadId: rootThreadId,
        });
        return;
      }

      try {
        const response = await this.commandHandler(
          roomId,
          sender,
          chatType,
          parsedCommand.command,
          parsedCommand.args,
          { roomId, threadId: rootThreadId },
        );
        if (!response) return;
        if (typeof response === "string") {
          await this.send(roomId, {
            text: response,
            replyToId: event.getId(),
            threadId: rootThreadId,
          });
          return;
        }
        await this.send(roomId, {
          ...response,
          replyToId: response.replyToId ?? event.getId(),
          threadId: response.threadId ?? rootThreadId,
        });
      } catch (err) {
        await this.reportProcessingError(roomId, event.getId(), err, rootThreadId);
      }
      return;
    }

    if (!shouldProcess) {
      return;
    }

    const unified = await this.normalizeMessage(
      room,
      event,
      chatType,
      text,
      content,
      rootThreadId,
      replyId,
      preparedRoomHistory,
      selfDisplayName,
    );
    await this.processMessage(roomId, unified, preparedRoomHistory);
  }

  private async handleTimelineEventIngress(
    room: Room,
    event: MatrixEvent,
    eventType: string,
    sender: string,
    chatType: MatrixChatType,
    historyLimit: number,
  ): Promise<
    | {
        content: MatrixEventContent;
        text: string;
        rootThreadId?: string;
        replyId?: string;
        selfDisplayName?: string;
        preparedRoomHistory?: PreparedMatrixRoomHistory;
        shouldProcess: boolean;
      }
    | undefined
  > {
    if (!this.isRoomAllowed(room, chatType)) return undefined;
    if (!this.isAllowedByPolicy(sender, room, chatType)) return undefined;

    const prepared = await this.prepareTimelineEvent(room, event, eventType, sender, chatType);
    if (!prepared) return undefined;

    const getPollSnapshotText = async (): Promise<string | undefined> => {
      if (!prepared.isPollEvent) return undefined;
      return await fetchMatrixPollSnapshot(this.runtime.sdk, room.roomId, {
        event_id: event.getId() ?? undefined,
        sender,
        type: eventType,
        content: event.getContent() as MatrixEventContent,
      });
    };

    const shouldProcess = this.shouldProcessRoomMessage(
      room,
      prepared.text,
      prepared.content,
      prepared.selfDisplayName,
    );

    if (!shouldProcess) {
      if (chatType === "group" && historyLimit > 0) {
        const pendingText =
          this.resolvePendingRoomHistoryText(prepared.text, prepared.content) ||
          (await getPollSnapshotText()) ||
          "";
        if (pendingText) {
          this.roomHistory.recordPending(room.roomId, {
            messageId: event.getId() ?? "",
            senderId: sender,
            text: pendingText,
          });
        }
      }
      return { ...prepared, shouldProcess: false, preparedRoomHistory: undefined };
    }

    let content = prepared.content;
    let text = prepared.text;
    if (prepared.isPollEvent) {
      const pollSnapshotText = await getPollSnapshotText();
      if (!pollSnapshotText) return undefined;
      content = {
        ...prepared.content,
        msgtype: MsgType.Text,
        body: pollSnapshotText,
      };
      text = pollSnapshotText;
    }

    const preparedRoomHistory =
      chatType === "group" && historyLimit > 0
        ? this.roomHistory.prepareTrigger(room.roomId, historyLimit, {
            messageId: event.getId() ?? "",
            senderId: sender,
            text: this.resolvePendingRoomHistoryText(text, content),
          })
        : undefined;

    return {
      ...prepared,
      content,
      text,
      preparedRoomHistory,
      shouldProcess: true,
    };
  }

  private async runRoomIngress<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.roomIngressTails.get(roomId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const chain = previous.catch(() => {}).then(() => current);
    this.roomIngressTails.set(roomId, chain);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      releaseCurrent();
      if (this.roomIngressTails.get(roomId) === chain) {
        this.roomIngressTails.delete(roomId);
      }
    }
  }

  private async prepareTimelineEvent(
    room: Room,
    event: MatrixEvent,
    eventType: string,
    sender: string,
    chatType: MatrixChatType,
  ): Promise<
    | {
        content: MatrixEventContent;
        text: string;
        rootThreadId?: string;
        replyId?: string;
        selfDisplayName?: string;
        isPollEvent: boolean;
      }
    | undefined
  > {
    const originalContent = event.getContent() as MatrixEventContent;
    const isPollEvent = isMatrixPollEventType(eventType);
    if (eventType !== EventType.RoomMessage && !isPollEvent) return undefined;
    if (eventType === EventType.RoomMessage && event.isRelation(RelationType.Replace)) return undefined;

    const text = isPollEvent
      ? resolveMatrixPollPrecheckText(eventType, originalContent)
      : messageBody(originalContent);

    return {
      content: originalContent,
      text,
      rootThreadId: this.resolveInboundThreadId(chatType, event),
      replyId: replyToEventId(event),
      selfDisplayName: this.selfDisplayNameForRoom(room),
      isPollEvent,
    };
  }

  private async processMessage(
    roomId: string,
    message: UnifiedMessage,
    preparedRoomHistory?: PreparedMatrixRoomHistory,
  ): Promise<void> {
    if (!this.messageHandler) return;

    await this.reactions.set(roomId, message.id, "received");
    this.startTyping(roomId);

    try {
      await this.reactions.set(roomId, message.id, "thinking");
      await this.runtime.sdk.sendReadReceipt(this.findRoomEvent(roomId, message.id) ?? null).catch(() => {});
      await this.messageHandler(message);
      if (preparedRoomHistory) {
        this.roomHistory.consumeHistory(roomId, preparedRoomHistory);
      }
      await this.reactions.set(roomId, message.id, "done");
    } catch (err) {
      await this.reactions.set(roomId, message.id, "error");
      await this.reportProcessingError(roomId, message.id, err, message.threadId);
    } finally {
      this.stopTyping(roomId);
    }
  }

  private async handleReaction(room: Room, event: MatrixEvent): Promise<void> {
    const sender = event.getSender();
    if (!sender || sender === this.selfUserId || !this.actionHandler) return;

    const chatType = this.isDirectMessage(room) ? "dm" : "group";
    if (!this.isRoomAllowed(room, chatType)) return;
    if (!this.isAllowedByPolicy(sender, room, chatType)) return;

    const reaction = this.extractReactionAnnotation(event.getContent() as MatrixEventContent);
    if (!reaction) return;

    const pending = this.resolvePendingAction(room.roomId, reaction.eventId);
    if (!pending) return;

    const action = this.resolveActionForReaction(pending.buttons, reaction.key);
    if (!action) return;

    try {
      const response = await this.actionHandler({
        chatId: room.roomId,
        userId: sender,
        chatType,
        data: action,
        messageId: reaction.eventId,
        threadId: pending.threadId,
        reactionKey: reaction.key,
      });
      if (!response) return;
      await this.applyActionResponse(room.roomId, reaction.eventId, pending.threadId, response);
    } catch (err) {
      await this.reportProcessingError(room.roomId, reaction.eventId, err, pending.threadId);
    }
  }

  private async reportProcessingError(
    roomId: string,
    replyToId: string | undefined,
    err: unknown,
    threadId?: string,
  ): Promise<void> {
    const errorKey = this.errorReporter.errorKey(err);
    if (!this.errorReporter.shouldReport(errorKey)) return;

    await this.send(roomId, {
      text: "An error occurred while processing your message.",
      replyToId,
      threadId,
      notice: true,
    }).catch((sendErr) => {
      void matrixLog("error", "matrix error reporting failed", { roomId, error: String(sendErr) });
    });
  }

  private extractReactionAnnotation(
    content: MatrixEventContent,
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

  private resolveActionForReaction(buttons: ConfirmationButton[], key: string): string | undefined {
    const index = MATRIX_REACTION_BUTTON_EMOJIS.findIndex((emoji) => emoji === key);
    if (index < 0) return undefined;
    return buttons[index]?.action;
  }

  private rememberPendingAction(
    roomId: string,
    eventId: string,
    buttons: ConfirmationButton[],
    threadId?: string,
  ): void {
    const key = this.pendingActionKey(roomId, eventId);
    if (buttons.length === 0) {
      this.pendingActions.delete(key);
      return;
    }

    this.prunePendingActions();
    this.pendingActions.set(key, {
      buttons,
      threadId,
      expiresAt: Date.now() + MATRIX_PENDING_ACTION_TTL_MS,
    });

    while (this.pendingActions.size > MATRIX_PENDING_ACTION_LIMIT) {
      const oldest = this.pendingActions.keys().next().value;
      if (typeof oldest !== "string") break;
      this.pendingActions.delete(oldest);
    }
  }

  private resolvePendingAction(roomId: string, eventId: string): PendingMatrixAction | undefined {
    const key = this.pendingActionKey(roomId, eventId);
    const pending = this.pendingActions.get(key);
    if (!pending) return undefined;
    if (pending.expiresAt < Date.now()) {
      this.pendingActions.delete(key);
      return undefined;
    }
    return pending;
  }

  private pendingActionKey(roomId: string, eventId: string): string {
    return `${roomId}:${eventId}`;
  }

  private prunePendingActions(): void {
    const now = Date.now();
    for (const [key, pending] of this.pendingActions.entries()) {
      if (pending.expiresAt < now) {
        this.pendingActions.delete(key);
      }
    }
  }

  private async applyActionResponse(
    roomId: string,
    eventId: string,
    threadId: string | undefined,
    response: { text?: string; buttons?: ConfirmationButton[]; answerText?: string },
  ): Promise<void> {
    if (response.text?.trim()) {
      await this.editPendingActionMessage(roomId, eventId, response.text, threadId);
    } else if (response.answerText?.trim()) {
      await this.send(roomId, {
        text: response.answerText,
        replyToId: eventId,
        threadId,
        notice: true,
      });
    }

    if (response.buttons?.length) {
      this.rememberPendingAction(roomId, eventId, response.buttons, threadId);
      return;
    }

    this.pendingActions.delete(this.pendingActionKey(roomId, eventId));
  }

  private async editPendingActionMessage(
    roomId: string,
    eventId: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    const formatted = buildMatrixFormattedText(text);
    const newContent: Record<string, unknown> = {
      msgtype: MsgType.Text,
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
      msgtype: MsgType.Text,
      body: `* ${formatted.body}`,
      "m.new_content": newContent,
      "m.relates_to": buildReplaceRelation(eventId, threadId),
    };
    if (formatted.formatted_body) {
      content["format"] = "org.matrix.custom.html";
      content["formatted_body"] = prefixEditedMatrixFormattedBody(formatted.formatted_body);
    }
    if (formatted.mentions) {
      content["m.mentions"] = formatted.mentions;
    }

    await this.runtime.sdk.sendMessage(roomId, content as never);
  }

  private async normalizeMessage(
    room: Room,
    event: MatrixEvent,
    chatType: MatrixChatType,
    text: string,
    content: MatrixEventContent,
    threadId?: string,
    replyToId?: string,
    preparedRoomHistory?: PreparedMatrixRoomHistory,
    selfDisplayName = this.selfDisplayNameForRoom(room),
  ): Promise<UnifiedMessage> {
    const attachments = await this.extractAttachments(content);
    let replyContext = replyToId
      ? await this.resolveReplyContext(room.roomId, replyToId)
      : undefined;
    let threadContext =
      threadId && threadId !== replyToId
        ? await this.resolveThreadContext(room.roomId, threadId)
        : undefined;
    const contextVisibility = this.contextVisibility();
    if (
      replyContext?.sender &&
      !this.shouldIncludeContextSender(room.roomId, chatType, "quote", replyContext.sender, contextVisibility)
    ) {
      replyContext = undefined;
    }
    if (
      threadContext?.sender &&
      !this.shouldIncludeContextSender(room.roomId, chatType, "thread", threadContext.sender, contextVisibility)
    ) {
      threadContext = undefined;
    }
    const roomContext = await this.resolveRoomHistoryContext(room.roomId, chatType, preparedRoomHistory, contextVisibility);
    const mentions = resolveInboundMatrixMentions({
      content,
      text,
      userId: this.selfUserId ?? this.config.userId,
      displayName: selfDisplayName,
    });
    const normalizedText = this.resolveNormalizedInboundText({
      content,
      text,
      attachments,
    });

    return {
      id: event.getId() ?? "",
      platform: "matrix",
      userId: event.getSender() ?? "",
      chatId: room.roomId,
      chatType,
      text: normalizedText,
      attachments,
      isForwarded: false,
      replyToId,
      replyToText: replyContext?.body,
      replyToSender: replyContext?.sender,
      threadId,
      threadRootText: threadContext?.text,
      roomContext,
      mentionsBot: mentions.mentionedBot,
      sessionScope: chatType === "dm" ? this.config.dm?.sessionScope ?? "per-user" : undefined,
      raw: event,
    };
  }

  private async extractAttachments(content: MatrixEventContent): Promise<Attachment[]> {
    const mediaUrl = trimString(content.url);
    const encryptedFile = this.encryptedMediaFile(content);
    const info = content.info as MatrixMediaInfo | undefined;
    const filename = typeof content.filename === "string" ? content.filename : undefined;
    const msgtype = typeof content.msgtype === "string" ? content.msgtype : undefined;

    if (!mediaUrl?.startsWith("mxc://") && !encryptedFile?.url?.startsWith("mxc://")) {
      return [];
    }

    const tooLarge = typeof info?.size === "number" && info.size > this.mediaMaxBytes();
    const attachmentType = matrixAttachmentTypeFromMsgType(msgtype);
    const summaryText = resolveMatrixMessageAttachmentSummary({
      body: messageBody(content),
      filename,
      msgtype,
      tooLarge,
    });

    if (tooLarge) {
      return [
        {
          type: attachmentType,
          mimeType: info?.mimetype,
          filename,
          sizeBytes: info?.size,
          width: info?.w,
          height: info?.h,
          durationMs: info?.duration,
          summaryText,
        },
      ];
    }

    try {
      const downloaded = await this.downloadMatrixAttachment({
        mxcUrl: mediaUrl ?? encryptedFile?.url,
        encryptedFile,
        filename,
        mimeType: info?.mimetype,
      });

      return [
        {
          type: attachmentType,
          url: downloaded.httpUrl,
          path: downloaded.path,
          mimeType: info?.mimetype ?? downloaded.mimeType,
          filename,
          sizeBytes: info?.size,
          width: info?.w,
          height: info?.h,
          durationMs: info?.duration,
          summaryText,
        },
      ];
    } catch (err) {
      await matrixLog("warn", "matrix attachment resolution failed", {
        error: String(err),
        filename,
      });

      return [
        {
          type: attachmentType,
          mimeType: info?.mimetype,
          filename,
          sizeBytes: info?.size,
          width: info?.w,
          height: info?.h,
          durationMs: info?.duration,
          summaryText: resolveMatrixMessageAttachmentSummary({
            body: messageBody(content),
            filename,
            msgtype,
            unavailable: true,
          }),
        },
      ];
    }
  }

  private encryptedMediaFile(content: MatrixEventContent): MatrixEncryptedFile | undefined {
    const file = content.file;
    if (!file || typeof file !== "object") return undefined;
    const raw = file as Record<string, unknown>;
    const url = trimString(raw.url);
    if (!url) return undefined;
    return {
      url,
      key: raw.key && typeof raw.key === "object" ? (raw.key as Record<string, unknown>) : undefined,
      iv: trimString(raw.iv),
      hashes: raw.hashes && typeof raw.hashes === "object" ? (raw.hashes as Record<string, string>) : undefined,
      v: trimString(raw.v),
    };
  }

  private async downloadMatrixAttachment(params: {
    mxcUrl?: string;
    encryptedFile?: MatrixEncryptedFile;
    filename?: string;
    mimeType?: string;
  }): Promise<{ path?: string; httpUrl?: string; mimeType?: string }> {
    const mxcUrl = params.mxcUrl?.trim();
    if (!mxcUrl) return {};

    const httpUrl = this.runtime.sdk.mxcUrlToHttp(
      mxcUrl,
      undefined,
      undefined,
      undefined,
      true,
      false,
      true,
    ) ?? this.runtime.sdk.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, true) ?? undefined;

    try {
      let buffer: Buffer;
      let resolvedMimeType = params.mimeType;

      if (params.encryptedFile) {
        const crypto = this.resolveMatrixCrypto();
        if (!crypto?.decryptMedia) {
          throw new Error("Encrypted Matrix media decryption is unavailable");
        }
        buffer = await crypto.decryptMedia(params.encryptedFile, {
          maxBytes: this.mediaMaxBytes(),
          readIdleTimeoutMs: MATRIX_MEDIA_DOWNLOAD_TIMEOUT_MS,
        });
      } else {
        const response = await fetch(httpUrl ?? mxcUrl, {
          headers: { Accept: "*/*" },
        });
        if (!response.ok) {
          throw new Error(`Matrix media download failed: HTTP ${response.status}`);
        }
        buffer = Buffer.from(await response.arrayBuffer());
        resolvedMimeType = resolvedMimeType ?? response.headers.get("content-type") ?? undefined;
      }

      if (buffer.byteLength > this.mediaMaxBytes()) {
        throw new Error("Matrix media exceeds size limit");
      }

      const extension =
        extFromFilename(params.filename) ||
        this.extFromMime(resolvedMimeType ?? "");
      await mkdir(MATRIX_TMP_DIR, { recursive: true });
      const localPath = `${MATRIX_TMP_DIR}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extension}`;
      await writeFile(localPath, buffer);

      return {
        path: localPath,
        httpUrl,
        mimeType: resolvedMimeType,
      };
    } catch (err) {
      throw err;
    }
  }

  private async resolveReplyContext(
    roomId: string,
    eventId: string,
  ): Promise<{ body?: string; sender?: string } | undefined> {
    const event = await this.fetchEventContent(roomId, eventId);
    if (!event) return undefined;

    return {
      body: this.summarizeEventContent(event.content),
      sender: trimString(event.sender),
    };
  }

  private async resolveThreadContext(
    roomId: string,
    eventId: string,
  ): Promise<{ text?: string; sender?: string } | undefined> {
    const event = await this.fetchEventContent(roomId, eventId);
    if (!event) return undefined;

    const body = this.summarizeEventContent(event.content);
    const sender = trimString(event.sender);
    if (body && sender) return { text: `Matrix thread root from ${sender}:\n${body}`, sender };
    if (body) return { text: body, sender };
    if (sender) return { text: `Matrix thread root from ${sender}`, sender };
    return undefined;
  }

  private async fetchEventContent(
    roomId: string,
    eventId: string,
  ): Promise<{ sender?: string; content: MatrixEventContent } | undefined> {
    try {
      const raw = await this.runtime.sdk.fetchRoomEvent(roomId, eventId);
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

  private summarizeEventContent(content: MatrixEventContent): string | undefined {
    const body = messageBody(content);
    const filename = trimString(content.filename);
    const msgtype = trimString(content.msgtype);
    const mediaSummary = resolveMatrixMessageAttachmentSummary({ body, filename, msgtype });
    return mediaSummary ?? (body || undefined);
  }

  private resolveNormalizedInboundText(params: {
    content: MatrixEventContent;
    text: string;
    attachments: Attachment[];
  }): string {
    const msgtype = trimString(params.content.msgtype);
    if (!this.isMediaMsgType(msgtype)) {
      return params.text;
    }

    const summary = params.attachments
      .map((attachment) => attachment.summaryText?.trim())
      .filter((value): value is string => Boolean(value))
      .join("\n\n");

    return summary || params.text;
  }

  private isMediaMsgType(msgtype?: string): boolean {
    return msgtype === MsgType.Image || msgtype === MsgType.Audio || msgtype === MsgType.Video || msgtype === MsgType.File;
  }

  private async resolveRoomHistoryContext(
    roomId: string,
    chatType: MatrixChatType,
    preparedRoomHistory?: PreparedMatrixRoomHistory,
    visibility: ReturnType<MatrixAdapter["contextVisibility"]> = this.contextVisibility(),
  ): Promise<string | undefined> {
    const limit = chatType === "dm"
      ? Math.max(0, this.config.dm?.historyLimit ?? this.config.historyLimit ?? 0)
      : Math.max(0, this.config.historyLimit ?? 0);
    if (limit <= 0) return undefined;

    const recent = limitRecentItems(
      (preparedRoomHistory?.history ?? []).filter((entry) =>
        this.shouldIncludeContextSender(roomId, chatType, "history", entry.senderId, visibility)
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

  private async sendMediaByPath(
    roomId: string,
    filePath: string,
    replyToId?: string,
    threadId?: string,
  ): Promise<void> {
    const buffer = Buffer.from(await readFile(filePath));
    const name = basename(filePath);
    const mimeType = this.mimeFromExt(extname(filePath));
    const upload = await this.uploadMedia(roomId, buffer, {
      name,
      type: mimeType,
    });
    const content = this.buildMediaContent({
      body: name,
      filename: name,
      msgtype: this.msgTypeFromMime(mimeType),
      url: upload.url,
      file: upload.file,
      mimeType,
      size: buffer.byteLength,
      replyToId,
      threadId,
    });
    await this.runtime.sdk.sendMessage(roomId, content as never);
  }

  private async sendAttachment(
    roomId: string,
    attachment: Attachment,
    replyToId?: string,
    threadId?: string,
  ): Promise<void> {
    const source = attachment.path ?? attachment.url;
    if (!source) return;

    if (attachment.path) {
      await this.sendMediaByPath(roomId, attachment.path, replyToId, threadId);
      return;
    }

    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Matrix attachment fetch failed: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = attachment.mimeType ?? response.headers.get("content-type") ?? "application/octet-stream";
    const name = source.split("/").pop() ?? `file${this.extFromMime(mimeType)}`;
    const upload = await this.uploadMedia(roomId, buffer, {
      name,
      type: mimeType,
    });
    const content = this.buildMediaContent({
      body: name,
      filename: name,
      msgtype: this.msgTypeFromMime(mimeType),
      url: upload.url,
      file: upload.file,
      mimeType,
      size: buffer.byteLength,
      replyToId,
      threadId,
    });
    await this.runtime.sdk.sendMessage(roomId, content as never);
  }

  private async uploadMedia(
    roomId: string,
    buffer: Buffer,
    opts: { name?: string; type?: string },
  ): Promise<{ url: string; file?: MatrixEncryptedFile }> {
    const crypto = this.resolveMatrixCrypto();
    const shouldEncrypt = (await crypto?.isRoomEncrypted?.(roomId)) === true && typeof crypto?.encryptMedia === "function";
    if (shouldEncrypt && crypto?.encryptMedia) {
      const encrypted = await crypto.encryptMedia(buffer);
      const upload = await this.runtime.sdk.uploadContent(encrypted.buffer, {
        ...opts,
        includeFilename: false,
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
    const upload = await this.runtime.sdk.uploadContent(buffer, opts);
    return { url: upload.content_uri };
  }

  private buildMediaContent(params: {
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
      this.effectiveReplyToId({ text: params.body, replyToId: params.replyToId, threadId: params.threadId }),
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

  private commandText(text: string, room: Room, selfDisplayName?: string): string {
    const direct = this.isDirectMessage(room);
    if (direct) return text.trim();
    return stripMatrixMentionPrefix({
      text,
      userId: this.selfUserId,
      displayName: selfDisplayName,
    }).trim();
  }

  private shouldProcessRoomMessage(
    room: Room,
    text: string,
    content: MatrixEventContent,
    selfDisplayName = this.selfDisplayNameForRoom(room),
  ): boolean {
    if (this.isDirectMessage(room)) {
      return this.config.dm?.enabled !== false;
    }

    if ((this.config.groupPolicy ?? "allowlist") === "disabled") {
      return false;
    }

    const roomConfig = this.resolveRoomConfig(room.roomId);
    const requireMention = roomConfig?.autoReply === true
      ? false
      : roomConfig?.autoReply === false
        ? true
        : roomConfig?.requireMention ?? true;
    if (!requireMention) return true;

    const mentions = resolveInboundMatrixMentions({
      content,
      text,
      userId: this.selfUserId ?? this.config.userId,
      displayName: selfDisplayName,
    });
    if (mentions.mentionedBot) return true;

    const command = this.commandText(text, room, selfDisplayName);
    return command.startsWith("/");
  }

  private isAllowedByPolicy(userId: string, room: Room, chatType: MatrixChatType): boolean {
    if (this.whitelist.has(userId)) return true;

    if (chatType === "dm") {
      const dmPolicy = this.config.dm?.policy ?? "allowlist";
      if (dmPolicy === "open") return true;
      if (dmPolicy === "disabled") return false;
      return matrixUserListIncludes(this.config.dm?.allowFrom, userId);
    }

    const groupPolicy = this.config.groupPolicy ?? "allowlist";
    if (groupPolicy === "open") return true;
    if (groupPolicy === "disabled") return false;

    const roomConfig = this.resolveRoomConfig(room.roomId);
    if (!roomConfig) return false;
    if (matrixUserListIncludes(roomConfig.users, userId)) return true;
    return matrixUserListIncludes(this.config.groupAllowFrom, userId);
  }

  private isRoomAllowed(room: Room, chatType: MatrixChatType): boolean {
    if (chatType === "dm") {
      if (this.config.dm?.enabled === false) return false;
      return (this.config.dm?.policy ?? "allowlist") !== "disabled";
    }

    const groupPolicy = this.config.groupPolicy ?? "allowlist";
    if (groupPolicy === "disabled") return false;
    if (groupPolicy === "open") return true;
    if (!this.hasConfiguredGroupRooms()) return false;

    const roomConfig = this.resolveRoomConfig(room.roomId);
    if (!roomConfig) return false;
    return roomConfig.enabled !== false;
  }

  private hasConfiguredGroupRooms(): boolean {
    return Object.keys(this.config.groups ?? {}).length > 0;
  }

  private resolveRoomConfig(roomId: string): MatrixRoomConfig | null {
    const entries = Object.entries(this.config.groups ?? {});
    const direct = entries.find(
      ([key]) => key !== "*" && normalizeRoomKey(key) === normalizeRoomKey(roomId),
    );
    if (direct) return direct[1];

    return this.config.groups?.["*"] ?? null;
  }

  private isDirectMessage(room: Room): boolean {
    const joined = room.getJoinedMembers().map((member) => member.userId);
    const inviter = room.getDMInviter();
    if (inviter) return true;
    const self = this.selfUserId ?? this.config.userId;
    return Boolean(self && joined.length <= 2 && joined.includes(self));
  }

  private selfDisplayNameForRoom(room: Room): string | undefined {
    const self = this.selfUserId ?? this.config.userId;
    const liveName = self ? trimString(room.getMember(self)?.name) : undefined;
    return liveName ?? this.config.displayName;
  }

  private startTyping(roomId: string): void {
    const existing = this.typingRefs.get(roomId);
    if (existing) {
      existing.count++;
      return;
    }

    const send = () => {
      void this.runtime.sdk.sendTyping(roomId, true, TYPING_TIMEOUT_MS).catch(() => {});
    };
    send();
    const interval = setInterval(send, TYPING_REFRESH_MS);
    this.typingRefs.set(roomId, { interval, count: 1 });
  }

  private stopTyping(roomId: string): void {
    const ref = this.typingRefs.get(roomId);
    if (!ref) return;
    ref.count--;
    if (ref.count <= 0) {
      clearInterval(ref.interval);
      this.typingRefs.delete(roomId);
      void this.runtime.sdk.sendTyping(roomId, false, 0).catch(() => {});
    }
  }

  private findRoomEvent(roomId: string, eventId: string): MatrixEvent | null {
    return this.runtime.sdk.getRoom(roomId)?.findEventById(eventId) ?? null;
  }

  private resolveInboundThreadId(chatType: MatrixChatType, event: MatrixEvent): string | undefined {
    const inboundThreadId = threadRootId(event);
    const configured =
      chatType === "dm"
        ? this.config.dm?.threadReplies ?? this.config.threadReplies ?? "off"
        : this.config.threadReplies ?? "off";

    if (configured === "off") {
      return undefined;
    }
    if (configured === "always") {
      return inboundThreadId ?? event.getId() ?? undefined;
    }
    return inboundThreadId;
  }

  private handleMembershipChange = async (
    room: Room,
    membership: string,
    prevMembership?: string,
  ): Promise<void> => {
    if (membership !== "invite" || prevMembership === "invite") {
      return;
    }
    if (!resolveAutoJoinAllowed(room.roomId, this.config)) {
      return;
    }

    await this.runtime.sdk.joinRoom(room.roomId).catch((err) => {
      void matrixLog("warn", "matrix auto-join failed", { roomId: room.roomId, error: String(err) });
    });
  };

  private effectiveReplyToId(message: OutgoingMessage): string | undefined {
    return message.threadId ? undefined : message.replyToId;
  }

  private replyTargetForChunk(
    message: OutgoingMessage,
    chunkIndex: number,
    params: { chunkCount: number; hasMedia: boolean },
  ): string | undefined {
    if (message.threadId) return undefined;

    const replyToId = message.replyToId;
    if (!replyToId) return undefined;

    const mode = this.config.replyToMode ?? "off";
    if (mode === "off") return undefined;
    const multiPart = params.hasMedia || params.chunkCount > 1;
    if (!multiPart) return replyToId;
    if (mode === "all") return replyToId;
    if (mode === "batched") return replyToId;
    if (mode === "first") return chunkIndex === 0 ? replyToId : undefined;
    return undefined;
  }

  private streamReplyTarget(message: UnifiedMessage): string | undefined {
    if (message.threadId) return undefined;

    const mode = this.config.replyToMode ?? "off";
    if (mode === "off") return undefined;
    return message.id;
  }

  private textChunkLimit(): number {
    const limit = this.config.textChunkLimit;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      return 4000;
    }
    return Math.floor(limit);
  }

  private chunkMode(): "plain" | "line" {
    return (this.config.chunkMode ?? "newline") === "length" ? "plain" : "line";
  }

  private contextVisibility(): "all" | "allowlist" | "allowlist_quote" {
    return this.config.contextVisibility ?? "all";
  }

  private shouldIncludeContextSender(
    roomId: string,
    chatType: MatrixChatType,
    kind: "history" | "thread" | "quote",
    senderId: string,
    visibility: ReturnType<MatrixAdapter["contextVisibility"]>,
  ): boolean {
    if (chatType !== "group") return true;
    if (this.whitelist.has(senderId)) return true;

    const roomConfig = this.resolveRoomConfig(roomId);
    const senderAllowed = roomConfig?.users?.length
      ? matrixUserListIncludes(roomConfig.users, senderId)
      : this.config.groupPolicy === "allowlist" && (this.config.groupAllowFrom?.length ?? 0) > 0
        ? matrixUserListIncludes(this.config.groupAllowFrom, senderId)
        : true;

    return shouldIncludeSupplementalContext({
      mode: visibility,
      kind,
      senderAllowed,
    });
  }

  private allowBotsModeForRoom(room: Room): "off" | "mentions" | "all" {
    const roomConfig = this.resolveRoomConfig(room.roomId);
    const configured = roomConfig?.allowBots ?? this.config.allowBots ?? false;
    if (configured === true) return "all";
    if (configured === "mentions") return "mentions";
    return "off";
  }

  private isBotUser(userId: string): boolean {
    return userId !== this.selfUserId && matrixUserListIncludes(this.config.botUserIds, userId);
  }

  private historyLimitForChatType(chatType: MatrixChatType): number {
    return chatType === "dm"
      ? Math.max(0, this.config.dm?.historyLimit ?? this.config.historyLimit ?? 0)
      : Math.max(0, this.config.historyLimit ?? 0);
  }

  private resolvePendingRoomHistoryText(text: string, content: MatrixEventContent): string {
    const trimmed = text.trim();
    if (trimmed) return trimmed;
    return this.summarizeEventContent(content) ?? "";
  }

  private resolveMatrixCrypto(): MatrixCryptoFacade | undefined {
    return this.runtime.mediaCrypto;
  }

  private mediaMaxBytes(): number {
    return Math.max(1, this.config.mediaMaxMb ?? 25) * 1024 * 1024;
  }

  private mimeFromExt(ext: string): string {
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

  private msgTypeFromMime(mimeType: string): string {
    if (mimeType.startsWith("image/")) return MsgType.Image;
    if (mimeType.startsWith("video/")) return MsgType.Video;
    if (mimeType.startsWith("audio/")) return MsgType.Audio;
    return MsgType.File;
  }

  private extFromMime(mimeType: string): string {
    if (mimeType === "image/jpeg") return ".jpg";
    if (mimeType === "image/png") return ".png";
    if (mimeType === "image/webp") return ".webp";
    if (mimeType === "video/mp4") return ".mp4";
    if (mimeType === "audio/mpeg") return ".mp3";
    if (mimeType === "audio/ogg") return ".ogg";
    return "";
  }
}
