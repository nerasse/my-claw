import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { EventType, MsgType, RoomEvent } from "matrix-js-sdk";
import { MY_CLAW_DIR } from "../config.ts";
import type { MatrixChannelConfig } from "../config.ts";
import { SessionManager } from "../sessions/manager.ts";
import { extractMediaRefs, stripMediaRefs } from "../utils/media.ts";
import { matrixLog } from "../utils/logger.ts";
import { MatrixClientRuntime } from "./matrix-client.ts";
import {
  applyActionResponse as applyMatrixActionResponse,
  editPendingActionMessage as editMatrixPendingActionMessage,
  extractReactionAnnotation as extractMatrixReactionAnnotation,
  rememberPendingAction as rememberMatrixPendingAction,
  resolveActionForReaction as resolveMatrixActionForReaction,
  resolveActionForTextReply as resolveMatrixActionForTextReply,
  resolvePendingAction as resolveMatrixPendingAction,
} from "./matrix/adapter-actions.ts";
import {
  buildRelation,
  extFromFilename,
  limitRecentItems,
  matrixAttachmentTypeFromMsgType,
  messageBody,
  resolveMatrixCaptionAndFilename,
  resolveMatrixMessageAttachmentSummary,
  stripMatrixReplyFallback,
  threadRootId,
  trimString,
} from "./matrix/adapter-helpers.ts";
import { buildTimelineIngress } from "./matrix/adapter-ingress.ts";
import {
  allowBotsModeForRoom as resolveAllowBotsModeForRoom,
  contextVisibility as resolveContextVisibility,
  historyLimitForChatType as resolveHistoryLimitForChatType,
  isAllowedByPolicy as isAllowedByMatrixPolicy,
  isBotUser as isMatrixBotUser,
  isDirectMessage as isDirectMatrixMessage,
  isRoomAllowed as isAllowedMatrixRoom,
  resolveAutoJoinAllowed,
  resolveRoomConfig as resolveConfiguredMatrixRoom,
  selfDisplayNameForRoom as resolveMatrixSelfDisplayNameForRoom,
  shouldIncludeContextSender as shouldIncludeMatrixContextSender,
} from "./matrix/adapter-policy.ts";
import type {
  IngressTail,
  MatrixActionHandler,
  MatrixEventContent,
  MatrixChatType,
  MatrixCommandHandler,
  MatrixCryptoFacade,
  MatrixEncryptedFile,
  MatrixMediaInfo,
  PendingMatrixAction,
  TypingRef,
} from "./matrix/adapter-types.ts";
import { createMatrixInboundBuffer } from "./matrix/inbound-buffer.ts";
import { createMatrixInboundEventDeduper, type MatrixInboundEventDeduper } from "./matrix/inbound-dedupe.ts";
import { createMatrixSyncLifecycle, type MatrixSyncLifecycle } from "./matrix/sync-lifecycle.ts";
import { getMatrixHelpText, parseMatrixCommand } from "./matrix-commands.ts";
import { MatrixErrorReporter } from "./matrix-errors.ts";
import {
  createMatrixRoomHistoryTracker,
  type PreparedMatrixRoomHistory,
} from "./matrix-history.ts";
import {
  buildMatrixFormattedText,
  resolveInboundMatrixMentions,
  stripMatrixMentionPrefix,
} from "./matrix-format.ts";
import { MatrixReactionManager } from "./matrix-reactions.ts";
import { fetchMatrixPollSnapshot } from "./matrix-polls.ts";
import { MatrixMessageStreamer } from "./matrix-stream.ts";
import { chunkMatrixText } from "./matrix-text.ts";
import { buildMatrixApprovalMenu, type MatrixApprovalHandler } from "./matrix-session-handlers.ts";
import { withMatrixRetry } from "./matrix/retry.ts";
import type {
  ApprovalDecision,
  Attachment,
  ChannelAdapter,
  ConfirmationButton,
  OutgoingMessage,
  ToolApprovalRequest,
  UnifiedMessage,
} from "./types.ts";

const TYPING_TIMEOUT_MS = 5000;
const TYPING_REFRESH_MS = 4000;
const ERROR_REPORT_COOLDOWN_MS = 5 * 60 * 1000;
const MATRIX_TMP_DIR = join(MY_CLAW_DIR, "tmp");
const MATRIX_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
const MATRIX_PENDING_ACTION_TTL_MS = 6 * 60 * 60 * 1000;
const MATRIX_PENDING_ACTION_LIMIT = 128;
const MATRIX_TEXT_BATCH_THRESHOLD = 160;
const MATRIX_TEXT_BATCH_DELAY_MS = 600;
const MATRIX_TEXT_BATCH_SPLIT_DELAY_MS = 2_000;
const MATRIX_TEXT_BATCH_SPLIT_THRESHOLD = 3_900;
const MATRIX_ENCRYPTED_INGRESS_ESCALATION_COUNT = 3;

type PendingBufferedMatrixIngress = {
  batchKey: string;
  roomId: string;
  eventId: string;
  message: UnifiedMessage;
  histories: PreparedMatrixRoomHistory[];
  committers: Array<() => Promise<void>>;
  releasers: Array<() => Promise<void>>;
  timer: ReturnType<typeof setTimeout>;
};

type PersistedPendingMatrixAction = {
  roomId: string;
  eventId: string;
  buttons: ConfirmationButton[];
  threadId?: string;
  stateKey?: string;
  expiresAt: number;
};

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
  private inboundBuffer = createMatrixInboundBuffer();
  private pendingBufferedIngress = new Map<string, PendingBufferedMatrixIngress>();
  private typingRefs = new Map<string, TypingRef>();
  private encryptedIngressSkips = new Map<string, number>();
  private selfUserId?: string;
  private timelineOff?: () => void;
  private inboundDeduper?: MatrixInboundEventDeduper;
  private syncLifecycle: MatrixSyncLifecycle;

  constructor(
    private config: MatrixChannelConfig,
    private whitelist: Set<string>,
    runtime?: MatrixClientRuntime,
  ) {
    this.selfUserId = config.userId;
    this.syncLifecycle = createMatrixSyncLifecycle({
      dropPreStartupMessages: false,
      startupGraceMs: 0,
    });
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
    if (!this.inboundDeduper) {
      this.inboundDeduper = await createMatrixInboundEventDeduper({
        storagePath: this.runtime.getStoragePaths().inboundDedupePath,
      });
    }
    this.syncLifecycle = createMatrixSyncLifecycle({
      startupMs: Date.now(),
      startupGraceMs: 0,
      dropPreStartupMessages: !this.runtime.hasPersistedSyncState(),
    });
    this.timelineOff = this.runtime.onTimeline((payload) =>
      this.handleTimeline(payload.room, payload.event, payload.toStartOfTimeline, payload.removed, payload.liveEvent)
    );
    await this.restorePendingActions().catch(() => undefined);
    this.runtime.sdk.on(RoomEvent.MyMembership, this.handleMembershipChange);
    await this.runtime.start();
    this.selfUserId = this.runtime.sdk.getUserId() ?? this.config.userId;
    await matrixLog("info", "matrix adapter started", { homeserver: this.config.homeserver });
  }

  async stop(): Promise<void> {
    this.timelineOff?.();
    this.timelineOff = undefined;
    this.runtime.sdk.off(RoomEvent.MyMembership, this.handleMembershipChange);
    for (const ref of this.typingRefs.values()) {
      clearInterval(ref.interval);
    }
    for (const pending of this.pendingBufferedIngress.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingBufferedIngress.clear();
    this.typingRefs.clear();
    await this.persistPendingActions().catch(() => undefined);
    this.pendingActions.clear();
    await this.inboundDeduper?.stop().catch(() => undefined);
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

      const sent = await this.sendMatrixMessage(chatId, content, this.outboundTxnId(`text-${index}`));
      if (index === 0) {
        actionAnchorEventId = sent.event_id;
      }
    }

    if (actionAnchorEventId && message.buttons?.length) {
      this.rememberPendingAction(chatId, actionAnchorEventId, message.buttons, message.threadId, message.stateKey);
      await this.reactions.seedChoices(chatId, actionAnchorEventId, message.buttons.length);
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

  runtimeStoragePaths() {
    return this.runtime.getStoragePaths();
  }

  async confirmTool(request: ToolApprovalRequest, approvalHandler: MatrixApprovalHandler): Promise<ApprovalDecision> {
    const approvalPromise = approvalHandler.requestApproval(request);
    try {
      await this.send(request.chatId, {
        ...buildMatrixApprovalMenu({ request }),
        replyToId: request.messageId,
        threadId: request.threadId,
        notice: true,
        stateKey: "approval",
      });
    } catch (err) {
      approvalHandler.cancelApproval(request.id);
      throw err;
    }
    return await approvalPromise;
  }

  private async handleTimeline(
    room: Room,
    event: MatrixEvent,
    toStartOfTimeline: boolean,
    removed: boolean,
    liveEvent: boolean,
  ): Promise<void> {
    await this.handleTimelineEvent(room, event, toStartOfTimeline, removed, liveEvent);
  }

  private async handleTimelineEvent(
    room: Room,
    event: MatrixEvent,
    toStartOfTimeline: boolean,
    removed: boolean,
    liveEvent: boolean,
  ): Promise<void> {
    if (!liveEvent || toStartOfTimeline || removed) return;
    if (this.syncLifecycle.shouldDropEvent(event)) {
      return;
    }
    const eventType = event.getType();
    if (eventType === EventType.RoomMessageEncrypted) {
      if (liveEvent && !this.runtime.encryptionReady()) {
        await this.noteEncryptedIngressSkip(room.roomId, event.getId());
      }
      return;
    }
    const eventId = event.getId()?.trim() || "";
    let claimedInboundEvent = false;
    const commitInboundEventIfClaimed = async (): Promise<void> => {
      if (!claimedInboundEvent || !this.inboundDeduper || !eventId) {
        return;
      }
      await this.inboundDeduper.commitEvent({ roomId: room.roomId, eventId });
      claimedInboundEvent = false;
    };
    if (eventType === EventType.Reaction) {
      if (eventId && this.inboundDeduper) {
        claimedInboundEvent = this.inboundDeduper.claimEvent({ roomId: room.roomId, eventId });
        if (!claimedInboundEvent) {
          return;
        }
      }
      try {
        await this.handleReaction(room, event);
        await commitInboundEventIfClaimed();
      } finally {
        if (claimedInboundEvent && this.inboundDeduper && eventId) {
          this.inboundDeduper.releaseEvent({ roomId: room.roomId, eventId });
        }
      }
      return;
    }
    const sender = event.getSender();
    if (!sender || sender === this.selfUserId) {
      return;
    }
    if (this.isSystemMatrixSender(sender)) {
      return;
    }

    if (eventId && this.inboundDeduper) {
      claimedInboundEvent = this.inboundDeduper.claimEvent({ roomId: room.roomId, eventId });
      if (!claimedInboundEvent) {
        return;
      }
    }

    try {
      const chatType = this.isDirectMessage(room) ? "dm" : "group";
      const historyLimit = this.historyLimitForChatType(chatType);
      const ingress =
        chatType === "group" && historyLimit > 0
          ? await this.runRoomIngress(room.roomId, async () =>
              this.handleTimelineEventIngress(room, event, eventType, sender, chatType, historyLimit),
            )
          : await this.handleTimelineEventIngress(room, event, eventType, sender, chatType, historyLimit);
      if (!ingress) {
        await commitInboundEventIfClaimed();
        return;
      }

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
        if (allowBotsMode === "off") {
          await commitInboundEventIfClaimed();
          return;
        }
        if (allowBotsMode === "mentions" && chatType === "group" && !mentions.mentionedBot) {
          await commitInboundEventIfClaimed();
          return;
        }
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
          await commitInboundEventIfClaimed();
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
          if (!response) {
            await commitInboundEventIfClaimed();
            return;
          }
          if (typeof response === "string") {
            await this.send(roomId, {
              text: response,
              replyToId: event.getId(),
              threadId: rootThreadId,
            });
            await commitInboundEventIfClaimed();
            return;
          }
          await this.send(roomId, {
            ...response,
            replyToId: response.replyToId ?? event.getId(),
            threadId: response.threadId ?? rootThreadId,
          });
          await commitInboundEventIfClaimed();
        } catch (err) {
          await this.reportProcessingError(roomId, event.getId(), err, rootThreadId);
        }
        return;
      }

      if (!shouldProcess) {
        await commitInboundEventIfClaimed();
        return;
      }

      if (replyId) {
        const pending = this.resolvePendingAction(roomId, replyId);
        if (pending && this.actionHandler) {
          const action = this.resolveActionForTextReply(pending.buttons, text);
          if (action) {
            try {
              const response = await this.actionHandler({
                chatId: roomId,
                userId: sender,
                chatType,
                data: action,
                messageId: event.getId() ?? "",
                threadId: pending.threadId,
              });
              if (response) {
                await this.applyActionResponse(roomId, replyId, pending.threadId, response, pending.stateKey);
              }
              await commitInboundEventIfClaimed();
            } catch (err) {
              await this.reportProcessingError(roomId, event.getId(), err, pending.threadId);
            }
            return;
          }
        }
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
      if (this.shouldBufferInboundMessage(unified, chatType, rootThreadId)) {
        const buffered = await this.bufferOrProcessMessage({
          roomId,
          eventId: unified.id,
          message: unified,
          preparedRoomHistory,
          commitInboundEventIfClaimed,
          releaseInboundEventIfClaimed: async () => {
            if (claimedInboundEvent && this.inboundDeduper && eventId) {
              this.inboundDeduper.releaseEvent({ roomId: room.roomId, eventId });
              claimedInboundEvent = false;
            }
          },
        });
        if (buffered) {
          claimedInboundEvent = false;
        }
      } else {
        await this.processMessage(roomId, unified, preparedRoomHistory);
        await commitInboundEventIfClaimed();
      }
    } finally {
      if (claimedInboundEvent && this.inboundDeduper && eventId) {
        this.inboundDeduper.releaseEvent({ roomId: room.roomId, eventId });
      }
    }
  }

  private async handleTimelineEventIngress(
    room: Room,
    event: MatrixEvent,
    eventType: string,
    sender: string,
    chatType: MatrixChatType,
    historyLimit: number,
  ) {
    return await buildTimelineIngress({
      context: {
        config: this.config,
        whitelist: this.whitelist,
        selfUserId: this.selfUserId,
        roomHistory: this.roomHistory,
        resolveRoomConfig: (roomId) => this.resolveRoomConfig(roomId),
        isDirectMessage: (targetRoom) => this.isDirectMessage(targetRoom),
        selfDisplayNameForRoom: (targetRoom) => this.selfDisplayNameForRoom(targetRoom),
        resolveInboundThreadId: (targetChatType, targetEvent) => this.resolveInboundThreadId(targetChatType, targetEvent),
        resolvePendingRoomHistoryText: (text, content) => this.resolvePendingRoomHistoryText(text, content),
        shouldProcessRoomMessage: (targetRoom, text, content, selfDisplayName) =>
          this.shouldProcessRoomMessage(targetRoom, text, content, selfDisplayName),
        isAllowedByPolicy: (userId, targetRoom, targetChatType) =>
          this.isAllowedByPolicy(userId, targetRoom, targetChatType),
        isRoomAllowed: (targetRoom, targetChatType) => this.isRoomAllowed(targetRoom, targetChatType),
        historyLimitForChatType: (targetChatType) => this.historyLimitForChatType(targetChatType),
      },
      room,
      event,
      eventType,
      sender,
      chatType,
      historyLimit,
      fetchPollSnapshot: fetchMatrixPollSnapshot,
      sdk: this.runtime.sdk,
    });
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

  private async bufferOrProcessMessage(params: {
    roomId: string;
    eventId: string;
    message: UnifiedMessage;
    preparedRoomHistory?: PreparedMatrixRoomHistory;
    commitInboundEventIfClaimed: () => Promise<void>;
    releaseInboundEventIfClaimed: () => Promise<void>;
  }): Promise<boolean> {
    const batchKey = this.inboundBatchKey(params.message);
    const coalesced = this.inboundBuffer.coalesce(batchKey, {
      eventId: params.eventId,
      senderId: params.message.userId,
      chatType: params.message.chatType,
      text: params.message.text,
      content: params.message.raw && typeof params.message.raw === "object"
        ? ((params.message.raw as MatrixEvent).getContent() as MatrixEventContent)
        : {},
      attachments: params.message.attachments,
      threadId: params.message.threadId,
      replyToId: params.message.replyToId,
      mode: params.message.attachments.length > 0 ? "media" : "text",
      timestampMs: Date.now(),
    });
    const bufferedItem = coalesced.item;

    const existing = coalesced.mergedIntoEventId
      ? this.pendingBufferedIngress.get(coalesced.mergedIntoEventId)
      : this.pendingBufferedIngress.get(bufferedItem.eventId);
    if (existing) {
      if (coalesced.mergedIntoEventId) {
        this.pendingBufferedIngress.delete(coalesced.mergedIntoEventId);
      }
      existing.message = {
        ...existing.message,
        id: bufferedItem.eventId,
        text: bufferedItem.text,
        attachments: bufferedItem.attachments ?? [],
      };
      existing.eventId = bufferedItem.eventId;
      if (params.preparedRoomHistory) {
        existing.histories.push(params.preparedRoomHistory);
      }
      existing.committers.push(params.commitInboundEventIfClaimed);
      existing.releasers.push(params.releaseInboundEventIfClaimed);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        void this.flushBufferedMessage(existing.batchKey, existing.eventId);
      }, this.bufferedIngressDelayMs(params.message.text));
      this.pendingBufferedIngress.set(existing.eventId, existing);
      return true;
    }

    const pending: PendingBufferedMatrixIngress = {
      batchKey,
      roomId: params.roomId,
      eventId: bufferedItem.eventId,
      message: {
        ...params.message,
        id: bufferedItem.eventId,
        text: bufferedItem.text,
        attachments: bufferedItem.attachments ?? [],
      },
      histories: params.preparedRoomHistory ? [params.preparedRoomHistory] : [],
      committers: [params.commitInboundEventIfClaimed],
      releasers: [params.releaseInboundEventIfClaimed],
      timer: setTimeout(() => {
        void this.flushBufferedMessage(batchKey, bufferedItem.eventId);
      }, this.bufferedIngressDelayMs(params.message.text)),
    };
    this.pendingBufferedIngress.set(bufferedItem.eventId, pending);
    return true;
  }

  private async flushBufferedMessage(batchKey: string, eventId: string): Promise<void> {
    const pending = this.pendingBufferedIngress.get(eventId);
    if (!pending || pending.batchKey !== batchKey) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingBufferedIngress.delete(eventId);
    this.inboundBuffer.clear(batchKey, eventId);

    try {
      await this.processMessage(pending.roomId, pending.message, pending.histories.at(-1));
      for (const commit of pending.committers) {
        await commit();
      }
    } catch (err) {
      for (const release of pending.releasers) {
        await release();
      }
      throw err;
    }
  }

  private shouldBufferInboundMessage(
    message: UnifiedMessage,
    chatType: MatrixChatType,
    rootThreadId?: string,
  ): boolean {
    if (chatType !== "group") {
      return false;
    }
    const batchKey = this.inboundBatchKey(message);
    if (rootThreadId) {
      if (message.replyToId && message.replyToId !== rootThreadId) {
        return false;
      }
      if (message.attachments.length > 0) {
        return true;
      }
      return message.text.trim().length > 0 || this.inboundBuffer.canCoalesce(batchKey, {
        eventId: message.id,
        senderId: message.userId,
        chatType: message.chatType,
        text: message.text,
        content: {},
        attachments: message.attachments,
        threadId: message.threadId,
        replyToId: message.replyToId,
        mode: message.attachments.length > 0 ? "media" : "text",
        timestampMs: Date.now(),
      });
    }
    if (message.attachments.length > 0) {
      return true;
    }
    if (message.text.length >= MATRIX_TEXT_BATCH_THRESHOLD) {
      return true;
    }
    return this.inboundBuffer.canCoalesce(batchKey, {
      eventId: message.id,
      senderId: message.userId,
      chatType: message.chatType,
      text: message.text,
      content: {},
      attachments: message.attachments,
      threadId: message.threadId,
      replyToId: message.replyToId,
      mode: message.attachments.length > 0 ? "media" : "text",
      timestampMs: Date.now(),
    });
  }

  private inboundBatchKey(message: UnifiedMessage): string {
    const sessionId = SessionManager.resolveSessionId("matrix", message.chatType, message.chatId, message.userId, {
      roomId: message.chatId,
      threadId: message.threadId,
      sessionScope: message.sessionScope,
    });
    return `${message.chatId}|${sessionId}`;
  }

  protected bufferedIngressDelayMs(latestText: string): number {
    return latestText.length >= MATRIX_TEXT_BATCH_SPLIT_THRESHOLD
      ? MATRIX_TEXT_BATCH_SPLIT_DELAY_MS
      : MATRIX_TEXT_BATCH_DELAY_MS;
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
      throw err;
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
      await this.applyActionResponse(room.roomId, reaction.eventId, pending.threadId, response, pending.stateKey);
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
    return extractMatrixReactionAnnotation(content);
  }

  private resolveActionForReaction(buttons: ConfirmationButton[], key: string): string | undefined {
    return resolveMatrixActionForReaction(buttons, key);
  }

  private resolveActionForTextReply(buttons: ConfirmationButton[], text: string): string | undefined {
    return resolveMatrixActionForTextReply(buttons, text);
  }

  private rememberPendingAction(
    roomId: string,
    eventId: string,
    buttons: ConfirmationButton[],
    threadId?: string,
    stateKey?: string,
  ): void {
    rememberMatrixPendingAction({
      pendingActions: this.pendingActions,
      roomId,
      eventId,
      buttons,
      threadId,
      stateKey,
      ttlMs: MATRIX_PENDING_ACTION_TTL_MS,
      limit: MATRIX_PENDING_ACTION_LIMIT,
    });
    void this.persistPendingActions().catch(() => undefined);
  }

  private resolvePendingAction(roomId: string, eventId: string): PendingMatrixAction | undefined {
    return resolveMatrixPendingAction(this.pendingActions, roomId, eventId);
  }

  private async applyActionResponse(
    roomId: string,
    eventId: string,
    threadId: string | undefined,
    response: { text?: string; buttons?: ConfirmationButton[]; answerText?: string },
    stateKey?: string,
  ): Promise<void> {
    await applyMatrixActionResponse({
      pendingActions: this.pendingActions,
      roomId,
      eventId,
      threadId,
      stateKey,
      response,
      send: (chatId, message) => this.send(chatId, message),
      editPendingActionMessage: (params) =>
        this.editPendingActionMessage(params.roomId, params.eventId, params.text, params.threadId, params.notice),
      ttlMs: MATRIX_PENDING_ACTION_TTL_MS,
      limit: MATRIX_PENDING_ACTION_LIMIT,
    });
    await this.persistPendingActions().catch(() => undefined);
  }

  private async persistPendingActions(): Promise<void> {
    const entries: PersistedPendingMatrixAction[] = [];
    const now = Date.now();
    for (const pending of this.pendingActions.values()) {
      if (pending.expiresAt <= now) {
        continue;
      }
      entries.push({
        roomId: pending.roomId,
        eventId: pending.eventId,
        buttons: pending.buttons,
        threadId: pending.threadId,
        stateKey: pending.stateKey,
        expiresAt: pending.expiresAt,
      });
    }
    await mkdir(this.runtime.getStoragePaths().rootDir, { recursive: true });
    await writeFile(this.runtime.getStoragePaths().pendingActionsPath, JSON.stringify(entries, null, 2));
  }

  private async restorePendingActions(): Promise<void> {
    const raw = await readFile(this.runtime.getStoragePaths().pendingActionsPath, "utf-8").catch(() => "[]");
    const parsed = JSON.parse(raw) as PersistedPendingMatrixAction[];
    const now = Date.now();
    this.pendingActions.clear();
    for (const entry of parsed) {
      if (!entry || entry.expiresAt <= now) {
        continue;
      }
      rememberMatrixPendingAction({
        pendingActions: this.pendingActions,
        roomId: entry.roomId,
        eventId: entry.eventId,
        buttons: entry.buttons,
        threadId: entry.threadId,
        stateKey: entry.stateKey,
        ttlMs: Math.max(1, entry.expiresAt - now),
        limit: MATRIX_PENDING_ACTION_LIMIT,
      });
    }
  }

  private async editPendingActionMessage(
    roomId: string,
    eventId: string,
    text: string,
    threadId?: string,
    notice?: boolean,
  ): Promise<void> {
    await editMatrixPendingActionMessage({
      sendMessage: async (targetRoomId, content) => {
        await this.sendMatrixMessage(targetRoomId, content, this.outboundTxnId(`edit-${eventId}`));
      },
      roomId,
      eventId,
      text,
      threadId,
      notice,
    });
  }

  private async noteEncryptedIngressSkip(roomId: string, eventId?: string | null): Promise<void> {
    const count = (this.encryptedIngressSkips.get(roomId) ?? 0) + 1;
    this.encryptedIngressSkips.set(roomId, count);

    if (count === 1) {
      await matrixLog("warn", "matrix encrypted message skipped: crypto unavailable", {
        roomId,
        eventId,
      });
      return;
    }

    if (count === MATRIX_ENCRYPTED_INGRESS_ESCALATION_COUNT) {
      await matrixLog("warn", "matrix encrypted messages continue to be skipped: crypto unavailable", {
        roomId,
        eventId,
        skippedCount: count,
      });
    }
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
    const strippedText = stripMatrixReplyFallback(text, Boolean(replyToId));
    const mentions = resolveInboundMatrixMentions({
      content,
      text: strippedText,
      userId: this.selfUserId ?? this.config.userId,
      displayName: selfDisplayName,
    });
    const normalizedText = this.resolveNormalizedInboundText({
      content,
      text: strippedText,
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
      isForwarded: this.isForwardedMatrixMessage(event, content),
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
        const response = await this.fetchWithTimeout(httpUrl ?? mxcUrl, {
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

    const caption = resolveMatrixCaptionAndFilename({
      body: params.text,
      filename: trimString(params.content.filename),
    }).caption?.trim();

    return summary || caption || params.text;
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
    await this.sendMatrixMessage(roomId, content, this.outboundTxnId(`media-${name}`));
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

    const response = await this.fetchWithTimeout(source);
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
    await this.sendMatrixMessage(roomId, content, this.outboundTxnId(`attachment-${name}`));
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
      const upload = await withMatrixRetry({
        task: () =>
          this.runtime.sdk.uploadContent(encrypted.buffer, {
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
      task: () => this.runtime.sdk.uploadContent(buffer, opts),
    });
    return { url: upload.content_uri };
  }

  private async sendMatrixMessage(
    roomId: string,
    content: Record<string, unknown>,
    txnId = this.outboundTxnId("message"),
  ): Promise<{ event_id: string }> {
    return await withMatrixRetry({
      task: () => this.runtime.sdk.sendMessage(roomId, content as never, txnId),
    });
  }

  private outboundTxnId(prefix: string): string {
    return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
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
    return isAllowedByMatrixPolicy(this.config, this.whitelist, this.resolveRoomConfig(room.roomId), userId, chatType);
  }

  private isRoomAllowed(room: Room, chatType: MatrixChatType): boolean {
    return isAllowedMatrixRoom(this.config, this.resolveRoomConfig(room.roomId), chatType);
  }

  private resolveRoomConfig(roomId: string) {
    return resolveConfiguredMatrixRoom(this.config, roomId);
  }

  private isDirectMessage(room: Room): boolean {
    return isDirectMatrixMessage(room, this.selfUserId, this.config.userId);
  }

  private selfDisplayNameForRoom(room: Room): string | undefined {
    return resolveMatrixSelfDisplayNameForRoom(room, this.selfUserId, this.config.userId, this.config.displayName);
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
    return resolveContextVisibility(this.config);
  }

  private shouldIncludeContextSender(
    roomId: string,
    chatType: MatrixChatType,
    kind: "history" | "thread" | "quote",
    senderId: string,
    visibility: ReturnType<MatrixAdapter["contextVisibility"]>,
  ): boolean {
    return shouldIncludeMatrixContextSender({
      config: this.config,
      whitelist: this.whitelist,
      roomConfig: this.resolveRoomConfig(roomId),
      roomId,
      chatType,
      kind,
      senderId,
      visibility,
    });
  }

  private allowBotsModeForRoom(room: Room): "off" | "mentions" | "all" {
    return resolveAllowBotsModeForRoom(this.config, this.resolveRoomConfig(room.roomId));
  }

  private isBotUser(userId: string): boolean {
    return isMatrixBotUser(this.config, this.selfUserId, userId);
  }

  private historyLimitForChatType(chatType: MatrixChatType): number {
    return resolveHistoryLimitForChatType(this.config, chatType);
  }

  private resolvePendingRoomHistoryText(text: string, content: MatrixEventContent): string {
    const trimmed = text.trim();
    if (trimmed) return trimmed;
    return this.summarizeEventContent(content) ?? "";
  }

  private isForwardedMatrixMessage(event: MatrixEvent, content: MatrixEventContent): boolean {
    const sender = event.getSender();
    if (this.isBridgeRelaySender(sender)) {
      return true;
    }

    return Object.keys(content).some((key) =>
      key.includes("double_puppet") ||
      key === "uk.half-shot.bridge" ||
      key.endsWith(".bridge")
    );
  }

  private isBridgeRelaySender(userId?: string): boolean {
    const trimmed = userId?.trim();
    if (!trimmed) {
      return false;
    }
    const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    const separator = withoutAt.indexOf(":");
    const localpart = separator >= 0 ? withoutAt.slice(0, separator) : withoutAt;
    return localpart.startsWith("_");
  }

  private isSystemMatrixSender(userId?: string): boolean {
    const trimmed = userId?.trim();
    if (!trimmed) {
      return true;
    }
    const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    const separator = withoutAt.indexOf(":");
    const localpart = separator >= 0 ? withoutAt.slice(0, separator) : withoutAt;
    if (!localpart) {
      return true;
    }
    return localpart === "server" || localpart === "appservice";
  }

  private resolveMatrixCrypto(): MatrixCryptoFacade | undefined {
    return this.runtime.mediaCrypto;
  }

  private async fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.mediaDownloadTimeoutMs());
    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private mediaMaxBytes(): number {
    return Math.max(1, this.config.mediaMaxMb ?? 25) * 1024 * 1024;
  }

  protected mediaDownloadTimeoutMs(): number {
    return MATRIX_MEDIA_DOWNLOAD_TIMEOUT_MS;
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
