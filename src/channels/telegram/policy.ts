import type { TelegramChannelConfig } from "../../core/config.ts";
import { shouldIncludeSupplementalContext, type ContextVisibilityKind } from "../context-visibility.ts";

export type TelegramChatType = "dm" | "group";

export type TelegramSender = {
  id: string | number;
  username?: string;
  is_bot?: boolean;
};

export type TelegramGroupConfig = NonNullable<TelegramChannelConfig["groups"]>[string];

function normalizeTelegramPrincipal(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

export function telegramUserListIncludes(list: string[] | undefined, sender: TelegramSender | undefined): boolean {
  if (!sender || !list?.length) {
    return false;
  }

  const senderId = String(sender.id).trim();
  const senderUsername = sender.username ? normalizeTelegramPrincipal(sender.username) : undefined;
  return list.some((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return false;
    if (trimmed === senderId) return true;
    return Boolean(senderUsername && normalizeTelegramPrincipal(trimmed) === senderUsername);
  });
}

export function resolveTelegramGroupConfig(
  config: TelegramChannelConfig,
  chatId: string,
  threadId?: string,
): TelegramGroupConfig | null {
  const groups = config.groups ?? {};
  if (threadId) {
    return groups[`${chatId}:${threadId}`] ?? groups[`${chatId}:*`] ?? groups[chatId] ?? groups["*"] ?? null;
  }
  return groups[chatId] ?? groups["*"] ?? null;
}

export function hasConfiguredTelegramGroups(config: TelegramChannelConfig): boolean {
  return Object.keys(config.groups ?? {}).length > 0;
}

export function isTelegramChatAllowed(
  config: TelegramChannelConfig,
  groupConfig: TelegramGroupConfig | null,
  chatType: TelegramChatType,
): boolean {
  if (chatType === "dm") {
    if (config.dm?.enabled === false) return false;
    return (config.dm?.policy ?? "allowlist") !== "disabled";
  }

  const groupPolicy = config.groupPolicy ?? "allowlist";
  if (groupPolicy === "disabled") return false;
  if (groupPolicy === "open") return true;
  if (!hasConfiguredTelegramGroups(config)) return false;
  if (!groupConfig) return false;
  return groupConfig.enabled !== false;
}

export function isTelegramAllowedByPolicy(params: {
  config: TelegramChannelConfig;
  whitelist: Set<string>;
  groupConfig: TelegramGroupConfig | null;
  sender: TelegramSender | undefined;
  chatType: TelegramChatType;
}): boolean {
  if (!params.sender) return false;
  if (telegramUserListIncludes([...params.whitelist], params.sender)) return true;

  if (params.chatType === "dm") {
    const dmPolicy = params.config.dm?.policy ?? "allowlist";
    if (dmPolicy === "open") return true;
    if (dmPolicy === "disabled") return false;
    return telegramUserListIncludes(params.config.dm?.allowFrom, params.sender);
  }

  const groupPolicy = params.config.groupPolicy ?? "allowlist";
  if (groupPolicy === "open") return true;
  if (groupPolicy === "disabled") return false;

  if (!params.groupConfig) return false;
  if (telegramUserListIncludes(params.groupConfig.users, params.sender)) return true;
  return telegramUserListIncludes(params.config.groupAllowFrom, params.sender);
}

export function resolveTelegramRequireMention(groupConfig: TelegramGroupConfig | null): boolean {
  if (groupConfig?.autoReply === true) return false;
  if (groupConfig?.autoReply === false) return true;
  return groupConfig?.requireMention ?? true;
}

export function resolveTelegramAllowBotsMode(
  config: TelegramChannelConfig,
  groupConfig: TelegramGroupConfig | null,
): "off" | "mentions" | "all" {
  const configured = groupConfig?.allowBots ?? config.allowBots ?? false;
  if (configured === true) return "all";
  if (configured === "mentions") return "mentions";
  return "off";
}

export function isConfiguredTelegramBotUser(
  config: TelegramChannelConfig,
  selfUserId: string | undefined,
  sender: TelegramSender | undefined,
): boolean {
  if (!sender?.is_bot) return false;
  if (selfUserId && String(sender.id) === selfUserId) return false;
  if ((config.botUserIds?.length ?? 0) === 0) return true;
  return telegramUserListIncludes(config.botUserIds, sender);
}

export function shouldIncludeTelegramContextSender(params: {
  config: TelegramChannelConfig;
  whitelist: Set<string>;
  groupConfig: TelegramGroupConfig | null;
  chatType: TelegramChatType;
  kind: ContextVisibilityKind;
  sender: TelegramSender | undefined;
}): boolean {
  if (params.chatType !== "group") return true;
  if (!params.sender) return false;
  if (telegramUserListIncludes([...params.whitelist], params.sender)) return true;

  const senderAllowed = params.groupConfig?.users?.length
    ? telegramUserListIncludes(params.groupConfig.users, params.sender)
    : params.config.groupPolicy === "allowlist" && (params.config.groupAllowFrom?.length ?? 0) > 0
      ? telegramUserListIncludes(params.config.groupAllowFrom, params.sender)
      : true;

  return shouldIncludeSupplementalContext({
    mode: params.config.contextVisibility ?? "all",
    kind: params.kind,
    senderAllowed,
  });
}
