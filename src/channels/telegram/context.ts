import type { Context } from "grammy";
import type { UnifiedMessage } from "../types.ts";
import type { TelegramChannelConfig } from "../../core/config.ts";
import {
  shouldIncludeTelegramContextSender,
  resolveTelegramGroupConfig,
  type TelegramSender,
  type TelegramChatType,
} from "./policy.ts";

type GrammyMessage = NonNullable<Context["message"]>;
type AnyGrammyMessage = GrammyMessage | NonNullable<GrammyMessage["reply_to_message"]>;

export const MAX_HISTORY_SCOPE_ENTRIES = 200;
export const MAX_MESSAGE_CONTEXT_ENTRIES = 10_000;
export const MAX_THREAD_ROOT_ENTRIES = 2_000;

export interface TelegramHistoryEntry {
  messageId: string;
  senderId: string;
  senderLabel: string;
  text: string;
}

export interface TelegramStoredMessageContext extends TelegramHistoryEntry {
  scopeKey: string;
}

export function shouldIncludeContextSender(
  config: TelegramChannelConfig,
  whitelist: Set<string>,
  chatId: string,
  chatType: UnifiedMessage["chatType"],
  kind: "history" | "thread" | "quote",
  sender: TelegramSender | undefined,
  threadId?: string,
): boolean {
  return shouldIncludeTelegramContextSender({
    config,
    whitelist,
    groupConfig: resolveTelegramGroupConfig(config, chatId, threadId),
    chatType: chatType as TelegramChatType,
    kind,
    sender,
  });
}

export function contextTextForMessage(message: UnifiedMessage): string | undefined {
  const text = message.text.trim();
  if (text) return text;

  const attachmentSummary = message.attachments
    .map((attachment) => {
      if (attachment.summaryText?.trim()) return attachment.summaryText.trim();
      if (attachment.filename?.trim()) return `[${attachment.type}: ${attachment.filename.trim()}]`;
      return `[${attachment.type}]`;
    })
    .join(" ")
    .trim();

  return attachmentSummary || undefined;
}

export function contextTextFromRawMessage(
  message: AnyGrammyMessage,
  getMessageText: (msg: AnyGrammyMessage) => string | undefined,
): string | undefined {
  const text = getMessageText(message)?.trim() ?? "";
  if (text) return text;
  if (message.photo?.length) return "[image]";
  if (message.video) return "[video]";
  if (message.voice) return "[voice message]";
  if (message.audio) return "[audio]";
  if (message.document) {
    return message.document.file_name?.trim()
      ? `[file: ${message.document.file_name.trim()}]`
      : "[file]";
  }
  if (message.sticker) return "[sticker]";
  return undefined;
}

export function senderLabel(from: GrammyMessage["from"] | undefined): string {
  if (!from) return "unknown";
  if (from.username?.trim()) return `@${from.username.trim()}`;
  const name = [from.first_name, from.last_name]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ")
    .trim();
  if (name) return name;
  return String(from.id);
}

export function historyScopeKey(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}/thread/${threadId}` : `${chatId}/room`;
}

export function threadRootKey(chatId: string, threadId: string): string {
  return `${chatId}/thread-root/${threadId}`;
}

export function messageContextKey(chatId: string, messageId: string): string {
  return `${chatId}/${messageId}`;
}

export function pruneMessageContexts(messageContexts: Map<string, TelegramStoredMessageContext>): void {
  if (messageContexts.size <= MAX_MESSAGE_CONTEXT_ENTRIES) return;
  const toDelete = messageContexts.size - MAX_MESSAGE_CONTEXT_ENTRIES;
  let deleted = 0;
  for (const key of messageContexts.keys()) {
    if (deleted >= toDelete) break;
    messageContexts.delete(key);
    deleted++;
  }
}

export function pruneThreadRoots(threadRoots: Map<string, TelegramHistoryEntry>): void {
  if (threadRoots.size <= MAX_THREAD_ROOT_ENTRIES) return;
  const toDelete = threadRoots.size - MAX_THREAD_ROOT_ENTRIES;
  let deleted = 0;
  for (const key of threadRoots.keys()) {
    if (deleted >= toDelete) break;
    threadRoots.delete(key);
    deleted++;
  }
}

export function rememberInboundContext(
  config: TelegramChannelConfig,
  whitelist: Set<string>,
  historyByScope: Map<string, TelegramHistoryEntry[]>,
  messageContexts: Map<string, TelegramStoredMessageContext>,
  threadRoots: Map<string, TelegramHistoryEntry>,
  message: UnifiedMessage,
): void {
  const raw = message.raw as GrammyMessage;
  const text = contextTextForMessage(message);
  if (!text) return;

  const entry: TelegramHistoryEntry = {
    messageId: message.id,
    senderId: message.userId,
    senderLabel: senderLabel(raw.from),
    text,
  };
  const scopeKey = historyScopeKey(message.chatId, message.threadId);
  const history = historyByScope.get(scopeKey) ?? [];
  history.push(entry);
  if (history.length > MAX_HISTORY_SCOPE_ENTRIES) {
    history.splice(0, history.length - MAX_HISTORY_SCOPE_ENTRIES);
  }
  historyByScope.set(scopeKey, history);

  messageContexts.set(messageContextKey(message.chatId, message.id), { ...entry, scopeKey });
  pruneMessageContexts(messageContexts);

  if (message.threadId) {
    const threadKey = threadRootKey(message.chatId, message.threadId);
    if (!threadRoots.has(threadKey)) {
      threadRoots.set(threadKey, entry);
      pruneThreadRoots(threadRoots);
    }
  }
}

export function resolveReplyContext(
  config: TelegramChannelConfig,
  whitelist: Set<string>,
  messageContexts: Map<string, TelegramStoredMessageContext>,
  chatId: string,
  chatType: UnifiedMessage["chatType"],
  replyMessage: AnyGrammyMessage,
  threadId: string | undefined,
  getMessageText: (msg: AnyGrammyMessage) => string | undefined,
): TelegramHistoryEntry | undefined {
  const messageId = String(replyMessage.message_id);
  const stored = messageContexts.get(messageContextKey(chatId, messageId));
  if (!shouldIncludeContextSender(config, whitelist, chatId, chatType, "quote", replyMessage.from, threadId)) {
    return undefined;
  }

  const text = contextTextFromRawMessage(replyMessage, getMessageText) ?? stored?.text;
  if (!text) return undefined;

  return {
    messageId,
    senderId: replyMessage.from ? String(replyMessage.from.id) : stored?.senderId ?? "unknown",
    senderLabel: senderLabel(replyMessage.from) || stored?.senderLabel || "unknown",
    text,
  };
}

export function resolveThreadRootContext(
  config: TelegramChannelConfig,
  whitelist: Set<string>,
  messageContexts: Map<string, TelegramStoredMessageContext>,
  threadRoots: Map<string, TelegramHistoryEntry>,
  historyByScope: Map<string, TelegramHistoryEntry[]>,
  chatId: string,
  chatType: UnifiedMessage["chatType"],
  threadId: string,
): TelegramHistoryEntry | undefined {
  const entry = threadRoots.get(threadRootKey(chatId, threadId))
    ?? historyByScope.get(historyScopeKey(chatId, threadId))?.[0];
  if (!entry) return undefined;
  const stored = messageContexts.get(messageContextKey(chatId, entry.messageId));
  const sender = stored ? { id: stored.senderId, username: stored.senderLabel.replace(/^@/, "") } : undefined;
  if (!shouldIncludeContextSender(config, whitelist, chatId, chatType, "thread", sender, threadId)) {
    return undefined;
  }
  return entry;
}

export function resolveRoomHistoryContext(
  config: TelegramChannelConfig,
  whitelist: Set<string>,
  messageContexts: Map<string, TelegramStoredMessageContext>,
  historyByScope: Map<string, TelegramHistoryEntry[]>,
  chatId: string,
  chatType: UnifiedMessage["chatType"],
  threadId?: string,
): string | undefined {
  const limit = Math.max(0, config.historyLimit ?? 0);
  if (limit <= 0) return undefined;

  const lines = (historyByScope.get(historyScopeKey(chatId, threadId)) ?? [])
    .filter((entry) => {
      const stored = messageContexts.get(messageContextKey(chatId, entry.messageId));
      const sender = stored ? { id: stored.senderId, username: stored.senderLabel.replace(/^@/, "") } : undefined;
      return shouldIncludeContextSender(config, whitelist, chatId, chatType, "history", sender, threadId);
    })
    .slice(-limit)
    .map((entry) => {
      const body = entry.text.trim();
      return body ? `${entry.senderLabel}: ${body}` : undefined;
    })
    .filter((value): value is string => Boolean(value));

  if (lines.length === 0) return undefined;
  return `${threadId ? "[Recent Thread Context]" : "[Recent Room Context]"}\n${lines.join("\n")}`;
}
