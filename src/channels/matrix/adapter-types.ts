import type { MatrixEvent, Room } from "matrix-js-sdk";
import type { MatrixChannelConfig } from "../../config.ts";
import type { PreparedMatrixRoomHistory } from "../matrix-history.ts";
import type { ConfirmationButton } from "../types.ts";

export type MatrixChatType = "dm" | "group";

export type MatrixCommandHandler = (
  chatId: string,
  userId: string,
  chatType: MatrixChatType,
  command: string,
  args: string,
  meta?: { roomId?: string; threadId?: string },
) => Promise<import("../types.ts").OutgoingMessage | string | undefined>;

export type MatrixActionHandler = (ctx: {
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

export type TypingRef = {
  interval: ReturnType<typeof setInterval>;
  count: number;
};

export type MatrixEventContent = Record<string, unknown>;
export type MatrixRoomConfig = NonNullable<MatrixChannelConfig["groups"]>[string];
export type PendingMatrixAction = {
  roomId: string;
  eventId: string;
  buttons: ConfirmationButton[];
  threadId?: string;
  expiresAt: number;
  stateKey?: string;
};
export type IngressTail = Promise<void>;
export type MatrixMediaInfo = {
  mimetype?: string;
  size?: number;
  w?: number;
  h?: number;
  duration?: number;
};
export type MatrixEncryptedFile = {
  url: string;
  key?: Record<string, unknown>;
  iv?: string;
  hashes?: Record<string, string>;
  v?: string;
};

export type MatrixCryptoFacade = {
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

export type MatrixPreparedTimelineEvent = {
  content: MatrixEventContent;
  text: string;
  rootThreadId?: string;
  replyId?: string;
  selfDisplayName?: string;
  isPollEvent: boolean;
};

export type MatrixTimelineIngress = {
  content: MatrixEventContent;
  text: string;
  rootThreadId?: string;
  replyId?: string;
  selfDisplayName?: string;
  preparedRoomHistory?: PreparedMatrixRoomHistory;
  shouldProcess: boolean;
};

export type MatrixInboundContext = {
  config: MatrixChannelConfig;
  whitelist: Set<string>;
  selfUserId?: string;
  roomHistory: {
    recordPending: (
      roomId: string,
      entry: { messageId: string; senderId: string; text: string },
    ) => void;
    prepareTrigger: (
      roomId: string,
      historyLimit: number,
      trigger: { messageId: string; senderId: string; text: string },
    ) => PreparedMatrixRoomHistory;
  };
  resolveRoomConfig: (roomId: string) => MatrixRoomConfig | null;
  isDirectMessage: (room: Room) => boolean;
  selfDisplayNameForRoom: (room: Room) => string | undefined;
  resolveInboundThreadId: (chatType: MatrixChatType, event: MatrixEvent) => string | undefined;
  resolvePendingRoomHistoryText: (text: string, content: MatrixEventContent) => string;
  shouldProcessRoomMessage: (
    room: Room,
    text: string,
    content: MatrixEventContent,
    selfDisplayName?: string,
  ) => boolean;
  isAllowedByPolicy: (userId: string, room: Room, chatType: MatrixChatType) => boolean;
  isRoomAllowed: (room: Room, chatType: MatrixChatType) => boolean;
  historyLimitForChatType: (chatType: MatrixChatType) => number;
};
