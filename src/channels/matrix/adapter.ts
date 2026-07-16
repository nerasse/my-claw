import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { EventType, MsgType, RoomEvent } from "matrix-js-sdk";
import { MY_CLAW_DIR } from "../../core/config.ts";
import { LruMap } from "../../utils/lru-map.ts";
import type { MatrixChannelConfig } from "../../core/config.ts";
import { SessionManager } from "../../sessions/manager.ts";
import { extractMediaRefs, stripMediaRefs } from "../../utils/media.ts";
import { matrixLog } from "../../utils/logger.ts";
import { MatrixClientRuntime } from "./client.ts";
import {
  applyActionResponse as applyMatrixActionResponse,
  editPendingActionMessage as editMatrixPendingActionMessage,
  extractReactionAnnotation as extractMatrixReactionAnnotation,
  pendingActionKey as matrixPendingActionKey,
  rememberPendingAction as rememberMatrixPendingAction,
  resolveActionForReaction as resolveMatrixActionForReaction,
  resolveActionForTextReply as resolveMatrixActionForTextReply,
  resolvePendingAction as resolveMatrixPendingAction,
} from "./actions.ts";
import {
  buildRelation,
  extFromFilename,
  matrixAttachmentTypeFromMsgType,
  messageBody,
  resolveMatrixMessageAttachmentSummary,
  stripMatrixReplyFallback,
  threadRootId,
  trimString,
} from "./helpers.ts";
import { buildTimelineIngress } from "./ingress.ts";
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
} from "./policy.ts";
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
} from "./types.ts";
import { createMatrixInboundBuffer } from "./inbound-buffer.ts";
import { createMatrixInboundEventDeduper, type MatrixInboundEventDeduper } from "./inbound-dedupe.ts";
import { createMatrixSyncLifecycle, type MatrixSyncLifecycle } from "./sync-lifecycle.ts";
import { getMatrixHelpText, parseMatrixCommand } from "./commands.ts";
import { MatrixErrorReporter, matrixUserFacingError } from "./errors.ts";
import {
  createMatrixRoomHistoryTracker,
  type PreparedMatrixRoomHistory,
} from "./history.ts";
import {
  buildMatrixFormattedText,
  resolveInboundMatrixMentions,
  stripMatrixMentionPrefix,
} from "./format.ts";
import { MatrixReactionManager } from "./reactions.ts";
import { fetchMatrixPollSnapshot } from "./polls.ts";
import { MatrixMessageStreamer } from "./stream.ts";
import { chunkMatrixText } from "./text.ts";
import { buildMatrixApprovalMenu, type MatrixApprovalHandler } from "./session-handlers.ts";
import type {
  ApprovalDecision,
  Attachment,
  ChannelAdapter,
  ConfirmationButton,
  OutgoingMessage,
  ToolApprovalRequest,
  UnifiedMessage,
} from "../types.ts";
import {
  chunkMode,
  extFromMime,
  outboundTxnId,
  replyTargetForChunk,
  sendAttachment,
  sendMatrixMessage,
  sendMediaByPath,
  streamReplyTarget,
  textChunkLimit,
} from "./send.ts";
import {
  resolveNormalizedInboundText,
  resolvePendingRoomHistoryText,
  resolveReplyContext,
  resolveRoomHistoryContext,
  resolveThreadContext,
} from "./context.ts";

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
const MATRIX_SHORT_TEXT_HOLD_DELAY_MS = 250;
const MATRIX_ENCRYPTED_INGRESS_ESCALATION_COUNT = 3;
const MATRIX_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const MATRIX_ATTACHMENT_SUMMARY_LINE = /^\[matrix .+ attachment(?: unavailable| too large)?\]$/;

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
  reactionEventIds?: string[];
  expiresAt: number;
};

type PendingMatrixConfirmation = {
  resolve: (accepted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
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
  private pendingConfirmations = new Map<string, PendingMatrixConfirmation>();
  private roomHistory = createMatrixRoomHistoryTracker();
  private roomIngressTails = new Map<string, IngressTail>();
  private inboundBuffer = createMatrixInboundBuffer();
  private pendingBufferedIngress = new Map<string, PendingBufferedMatrixIngress>();
  private typingRefs = new Map<string, TypingRef>();
  private encryptedIngressSkips = new LruMap<string, number>(1000);
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
    for (const pending of this.pendingConfirmations.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingBufferedIngress.clear();
    this.pendingConfirmations.clear();
    this.typingRefs.clear();
    await this.persistPendingActions().catch(() => undefined);
    this.pendingActions.clear();
    await this.inboundDeduper?.stop().catch(() => undefined);
    await this.runtime.stop();
    await matrixLog("info", "matrix adapter stopped");
  }

  /** Replace the access whitelist at runtime (used by the config hot-reload watcher). */
  setWhitelist(whitelist: Set<string>): void {
    this.whitelist = whitelist;
  }

  /**
   * Re-sync sub-managers that snapshot config values at construction (reactions, errorPolicy).
   * Behavioral fields (policy, streaming, history, chunking, threads, etc.) are read live off
   * `this.config`, which the watcher mutates in place, so they need no explicit refresh.
   * Identity/crypto fields (homeserver, accessToken, userId, deviceId, encryption) are NOT
   * applied here -- they require a reboot to avoid corrupting the E2E crypto session.
   */
  applyConfigReload(): void {
    this.reactions.setConfig({
      enabled: this.config.reactions?.enabled ?? false,
      emojis: {
        received: this.config.reactions?.received ?? "👀",
        thinking: this.config.reactions?.thinking ?? "🧠",
        tool_use: this.config.reactions?.toolUse ?? "⚙️",
        done: this.config.reactions?.done ?? "✅",
        error: this.config.reactions?.error ?? "⚠️",
      },
    });
    this.errorReporter.setMode(this.config.errorPolicy ?? "always");
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    const mediaRefs = extractMediaRefs(message.text);
    const text = stripMediaRefs(message.text);
    // If the agent explicitly references files via MEDIA: in its text, trust
    // that and do NOT send programmatic attachments (e.g. TTS auto-audio).
    const hasTextRefs = mediaRefs.length > 0;
    const attachmentsToSend = hasTextRefs ? [] : (message.attachments ?? []);
    const hasMedia = mediaRefs.length > 0 || attachmentsToSend.length > 0;

    let actionAnchorEventId: string | undefined;

    const textChunks = chunkMatrixText(text, textChunkLimit(this.config), chunkMode(this.config));
    for (let index = 0; index < textChunks.length; index++) {
      const chunk = textChunks[index]!;
      const formatted = buildMatrixFormattedText(chunk);
      const relation = buildRelation(
        message.threadId,
        replyTargetForChunk(this.config, message, index, {
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

      const sent = await sendMatrixMessage(this.runtime.sdk, chatId, content, outboundTxnId(`text-${index}`));
      if (index === 0) {
        actionAnchorEventId = sent.event_id;
      }
    }

    if (actionAnchorEventId && message.buttons?.length) {
      this.rememberPendingAction(chatId, actionAnchorEventId, message.buttons, message.threadId, message.stateKey);
      const reactionEventIds = await this.reactions.seedChoices(chatId, actionAnchorEventId, message.buttons.length);
      if (reactionEventIds.length > 0) {
        const pending = this.pendingActions.get(matrixPendingActionKey(chatId, actionAnchorEventId));
        if (pending) {
          pending.reactionEventIds = reactionEventIds;
          void this.persistPendingActions().catch(() => undefined);
        }
      }
    }

    if (!hasMedia) return;

    for (const ref of mediaRefs) {
      await sendMediaByPath(this.runtime.sdk, this.runtime.mediaCrypto, chatId, ref.path, message.replyToId, message.threadId, ref.audioAsVoice, ref.durationMs);
    }
    for (const attachment of attachmentsToSend) {
      await sendAttachment(this.runtime.sdk, this.runtime.mediaCrypto, (url) => this.fetchWithTimeout(url), chatId, attachment, message.replyToId, message.threadId);
    }
  }

  async confirm(chatId: string, text: string, replyToId?: string, threadId?: string): Promise<boolean> {
    const id = crypto.randomUUID().slice(0, 8);
    const decisionPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingConfirmations.delete(id);
        resolve(false);
      }, MATRIX_CONFIRM_TIMEOUT_MS);
      timer.unref?.();
      this.pendingConfirmations.set(id, { resolve, timer });
    });

    try {
      await this.send(chatId, {
        text,
        replyToId,
        threadId,
        notice: true,
        stateKey: "confirm",
        buttons: [
          { label: "Accept", action: `cfm:yes:${id}` },
          { label: "Deny", action: `cfm:no:${id}` },
        ],
      });
    } catch (err) {
      const pending = this.pendingConfirmations.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingConfirmations.delete(id);
        pending.resolve(false);
      }
      throw err;
    }

    return await decisionPromise;
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
    const replyToId = streamReplyTarget(this.config, message);
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
      chunkLimit: textChunkLimit(this.config),
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
        if (parsedCommand.command === "help" || parsedCommand.command === "commands") {
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
            await this.send(roomId, {
              text: `Unknown command: /${parsedCommand.command}\nUse /help or /commands to list available commands.`,
              replyToId: event.getId(),
              threadId: rootThreadId,
              notice: true,
            });
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

      if (replyId) {
        const pending = this.resolvePendingAction(roomId, replyId);
        if (pending) {
          const action = this.resolveActionForTextReply(pending.buttons, text);
          if (action) {
            try {
              const response = await this.resolvePendingActionResponse({
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

      if (!shouldProcess) {
        await commitInboundEventIfClaimed();
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
        resolvePendingRoomHistoryText: (text, content) => resolvePendingRoomHistoryText(text, content),
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
        // A handler/LLM error here would otherwise escape as an unhandled rejection and take the
        // whole process down (index.ts treats unhandledRejection as fatal). Contain it.
        void this.flushBufferedMessage(existing.batchKey, existing.eventId).catch((err) => {
          void matrixLog("error", "buffered flush failed", { batchKey: existing.batchKey, error: String(err) });
        });
      }, this.bufferedIngressDelayForMessage(existing.message));
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
        void this.flushBufferedMessage(batchKey, bufferedItem.eventId).catch((err) => {
          void matrixLog("error", "buffered flush failed", { batchKey, error: String(err) });
        });
      }, this.bufferedIngressDelayForMessage({
        ...params.message,
        id: bufferedItem.eventId,
        text: bufferedItem.text,
        attachments: bufferedItem.attachments ?? [],
      })),
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
    const bufferItem = {
      eventId: message.id,
      senderId: message.userId,
      chatType: message.chatType,
      text: message.text,
      content: {},
      attachments: message.attachments,
      threadId: message.threadId,
      replyToId: message.replyToId,
      mode: (message.attachments.length > 0 ? "media" : "text") as "media" | "text",
      timestampMs: Date.now(),
    };
    if (rootThreadId) {
      if (message.replyToId && message.replyToId !== rootThreadId) {
        return false;
      }
      if (message.attachments.length > 0) {
        return true;
      }
      return message.text.trim().length > 0 || this.inboundBuffer.canCoalesce(batchKey, bufferItem);
    }
    if (message.attachments.length > 0) {
      return true;
    }
    if (message.text.length >= MATRIX_TEXT_BATCH_THRESHOLD) {
      return true;
    }
    if (message.mentionsBot) {
      return this.inboundBuffer.canCoalesce(batchKey, bufferItem);
    }
    if (this.pendingBufferedIngress.size > 0) {
      return this.inboundBuffer.canCoalesce(batchKey, bufferItem);
    }
    return this.inboundBuffer.shouldHold(batchKey, bufferItem);
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

  protected bufferedIngressDelayForMessage(message: UnifiedMessage): number {
    const trimmed = message.text.trim();
    const lines = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const isAttachmentSummary = lines.length > 0 && lines.every((line) => MATRIX_ATTACHMENT_SUMMARY_LINE.test(line));
    if (
      message.chatType === "group" &&
      !message.threadId &&
      !message.replyToId &&
      !message.mentionsBot &&
      trimmed.length > 0 &&
      trimmed.length < MATRIX_TEXT_BATCH_THRESHOLD &&
      !isAttachmentSummary
    ) {
      return MATRIX_SHORT_TEXT_HOLD_DELAY_MS;
    }
    return this.bufferedIngressDelayMs(message.text);
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
      await this.runtime.sdk.sendReadReceipt(this.findRoomEvent(roomId, message.id) ?? null).catch((e) => { matrixLog("debug", "send read receipt failed", { error: String(e) }).catch(() => {}); });
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
    if (!sender || sender === this.selfUserId) return;

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
      const response = await this.resolvePendingActionResponse({
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
      text: matrixUserFacingError(errorKey),
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

  private async resolvePendingActionResponse(ctx: Parameters<MatrixActionHandler>[0]) {
    const confirmation = this.resolveConfirmationAction(ctx.data);
    if (confirmation) {
      return confirmation;
    }
    if (!this.actionHandler) {
      return undefined;
    }
    return await this.actionHandler(ctx);
  }

  private resolveConfirmationAction(data: string): { text: string } | undefined {
    const match = /^cfm:(yes|no):([a-z0-9-]+)$/i.exec(data.trim());
    if (!match) {
      return undefined;
    }
    const accepted = match[1] === "yes";
    const id = match[2] ?? "";
    const pending = this.pendingConfirmations.get(id);
    if (!pending) {
      return { text: "Confirmation expired or already resolved." };
    }
    clearTimeout(pending.timer);
    this.pendingConfirmations.delete(id);
    pending.resolve(accepted);
    return { text: accepted ? "Accepted." : "Denied." };
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
        this.editPendingActionMessage(
          params.roomId,
          params.eventId,
          params.text,
          params.threadId,
          params.notice || stateKey === "confirm",
        ),
      redactReactions: (roomId, eventIds) => this.reactions.redactMany(roomId, eventIds),
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
        reactionEventIds: pending.reactionEventIds,
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
        reactionEventIds: entry.reactionEventIds,
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
        await sendMatrixMessage(this.runtime.sdk, targetRoomId, content, outboundTxnId(`edit-${eventId}`));
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
      ? await resolveReplyContext(this.runtime.sdk, room.roomId, replyToId)
      : undefined;
    let threadContext =
      threadId && threadId !== replyToId
        ? await resolveThreadContext(this.runtime.sdk, room.roomId, threadId)
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
    const roomContext = await resolveRoomHistoryContext(
      this.config,
      room.roomId,
      chatType,
      preparedRoomHistory,
      contextVisibility,
      (senderId) => this.shouldIncludeContextSender(room.roomId, chatType, "history", senderId, contextVisibility),
    );
    const strippedText = stripMatrixReplyFallback(text, Boolean(replyToId));
    const mentions = resolveInboundMatrixMentions({
      content,
      text: strippedText,
      userId: this.selfUserId ?? this.config.userId,
      displayName: selfDisplayName,
    });
    const normalizedText = resolveNormalizedInboundText(content, strippedText, attachments);

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
      const token = this.config.accessToken;
      const response = await this.fetchWithTimeout(httpUrl ?? mxcUrl, {
        headers: {
          Accept: "*/*",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
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
      extFromMime(resolvedMimeType ?? "");
    await mkdir(MATRIX_TMP_DIR, { recursive: true });
    const localPath = `${MATRIX_TMP_DIR}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}${extension}`;
    await writeFile(localPath, buffer);

    return {
      path: localPath,
      httpUrl,
      mimeType: resolvedMimeType,
    };
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
      void this.runtime.sdk.sendTyping(roomId, true, TYPING_TIMEOUT_MS).catch((e) => { matrixLog("debug", "send typing indicator failed", { error: String(e) }).catch(() => {}); });
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
      void this.runtime.sdk.sendTyping(roomId, false, 0).catch((e) => { matrixLog("debug", "stop typing indicator failed", { error: String(e) }).catch(() => {}); });
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
    let inviterId: string | undefined;
    const selfMember = this.selfUserId ? room.getMember(this.selfUserId) : undefined;
    if (selfMember?.events?.member) {
      inviterId = selfMember.events.member.getSender() ?? undefined;
    }
    if (!resolveAutoJoinAllowed(room.roomId, this.config, inviterId)) {
      return;
    }

    await this.runtime.sdk.joinRoom(room.roomId).catch((err) => {
      void matrixLog("warn", "matrix auto-join failed", { roomId: room.roomId, error: String(err) });
    });
  };



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



  private isForwardedMatrixMessage(event: MatrixEvent, content: MatrixEventContent): boolean {
    const sender = event.getSender();
    if (this.isBridgeRelaySender(sender)) {
      return true;
    }

    const unsigned = event.getUnsigned();
    const unsignedRecord = unsigned && typeof unsigned === "object" ? (unsigned as Record<string, unknown>) : {};
    return Object.keys(content).some((key) =>
      key.includes("double_puppet") ||
      key === "uk.half-shot.bridge" ||
      key === "com.beeper.linkpreviews" ||
      key.endsWith(".bridge")
    ) || Object.keys(unsignedRecord).some((key) => key.includes("double_puppet") || key === "uk.half-shot.bridge");
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


}
