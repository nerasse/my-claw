import type { Room } from "matrix-js-sdk";
import type { MatrixChannelConfig } from "../../config.ts";
import { shouldIncludeSupplementalContext } from "../context-visibility.ts";
import type { MatrixChatType, MatrixRoomConfig } from "./adapter-types.ts";
import { matrixUserListIncludes, normalizeRoomKey, trimString } from "./adapter-helpers.ts";

export function resolveAutoJoinAllowed(roomId: string, config: MatrixChannelConfig): boolean {
  const mode = config.autoJoin ?? "off";
  if (mode === "always") return true;
  if (mode === "off") return false;
  const allowlist = config.autoJoinAllowlist ?? [];
  return allowlist.includes("*") || allowlist.includes(roomId);
}

export function resolveRoomConfig(config: MatrixChannelConfig, roomId: string): MatrixRoomConfig | null {
  const entries = Object.entries(config.groups ?? {});
  const direct = entries.find(([key]) => key !== "*" && normalizeRoomKey(key) === normalizeRoomKey(roomId));
  if (direct) return direct[1];
  return config.groups?.["*"] ?? null;
}

export function hasConfiguredGroupRooms(config: MatrixChannelConfig): boolean {
  return Object.keys(config.groups ?? {}).length > 0;
}

export function isDirectMessage(room: Room, selfUserId?: string, fallbackUserId?: string): boolean {
  const joined = room.getJoinedMembers().map((member) => member.userId);
  const inviter = room.getDMInviter();
  if (inviter) return true;
  const self = selfUserId ?? fallbackUserId;
  return Boolean(self && joined.length <= 2 && joined.includes(self));
}

export function selfDisplayNameForRoom(
  room: Room,
  selfUserId?: string,
  fallbackUserId?: string,
  configDisplayName?: string,
): string | undefined {
  const self = selfUserId ?? fallbackUserId;
  const liveName = self ? trimString(room.getMember(self)?.name) : undefined;
  return liveName ?? configDisplayName;
}

export function isAllowedByPolicy(
  config: MatrixChannelConfig,
  whitelist: Set<string>,
  roomConfig: MatrixRoomConfig | null,
  userId: string,
  chatType: MatrixChatType,
): boolean {
  if (whitelist.has(userId)) return true;

  if (chatType === "dm") {
    const dmPolicy = config.dm?.policy ?? "allowlist";
    if (dmPolicy === "open") return true;
    if (dmPolicy === "disabled") return false;
    return matrixUserListIncludes(config.dm?.allowFrom, userId);
  }

  const groupPolicy = config.groupPolicy ?? "allowlist";
  if (groupPolicy === "open") return true;
  if (groupPolicy === "disabled") return false;

  if (!roomConfig) return false;
  if (matrixUserListIncludes(roomConfig.users, userId)) return true;
  return matrixUserListIncludes(config.groupAllowFrom, userId);
}

export function isRoomAllowed(
  config: MatrixChannelConfig,
  roomConfig: MatrixRoomConfig | null,
  chatType: MatrixChatType,
): boolean {
  if (chatType === "dm") {
    if (config.dm?.enabled === false) return false;
    return (config.dm?.policy ?? "allowlist") !== "disabled";
  }

  const groupPolicy = config.groupPolicy ?? "allowlist";
  if (groupPolicy === "disabled") return false;
  if (groupPolicy === "open") return true;
  if (!hasConfiguredGroupRooms(config)) return false;

  if (!roomConfig) return false;
  return roomConfig.enabled !== false;
}

export function allowBotsModeForRoom(
  config: MatrixChannelConfig,
  roomConfig: MatrixRoomConfig | null,
): "off" | "mentions" | "all" {
  const configured = roomConfig?.allowBots ?? config.allowBots ?? false;
  if (configured === true) return "all";
  if (configured === "mentions") return "mentions";
  return "off";
}

export function isBotUser(config: MatrixChannelConfig, selfUserId: string | undefined, userId: string): boolean {
  return userId !== selfUserId && matrixUserListIncludes(config.botUserIds, userId);
}

export function historyLimitForChatType(config: MatrixChannelConfig, chatType: MatrixChatType): number {
  return chatType === "dm"
    ? Math.max(0, config.dm?.historyLimit ?? config.historyLimit ?? 0)
    : Math.max(0, config.historyLimit ?? 0);
}

export function contextVisibility(config: MatrixChannelConfig): "all" | "allowlist" | "allowlist_quote" {
  return config.contextVisibility ?? "all";
}

export function shouldIncludeContextSender(params: {
  config: MatrixChannelConfig;
  whitelist: Set<string>;
  roomConfig: MatrixRoomConfig | null;
  roomId: string;
  chatType: MatrixChatType;
  kind: "history" | "thread" | "quote";
  senderId: string;
  visibility: "all" | "allowlist" | "allowlist_quote";
}): boolean {
  if (params.chatType !== "group") return true;
  if (params.whitelist.has(params.senderId)) return true;

  const senderAllowed = params.roomConfig?.users?.length
    ? matrixUserListIncludes(params.roomConfig.users, params.senderId)
    : params.config.groupPolicy === "allowlist" && (params.config.groupAllowFrom?.length ?? 0) > 0
      ? matrixUserListIncludes(params.config.groupAllowFrom, params.senderId)
      : true;

  return shouldIncludeSupplementalContext({
    mode: params.visibility,
    kind: params.kind,
    senderAllowed,
  });
}
