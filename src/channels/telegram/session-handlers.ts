import type { MyClawConfig } from "../../core/config.ts";
import { SessionManager } from "../../sessions/manager.ts";
import { compactSession } from "../../sessions/compaction.ts";
import type { OutgoingMessage } from "../types.ts";
import { ModelPicker } from "../model-picker.ts";

type TelegramChatType = "dm" | "group";

interface TelegramSessionMeta {
  threadId?: string;
}

interface TelegramCallbackContext {
  chatId: string;
  userId: string;
  chatType: TelegramChatType;
  data: string;
  threadId?: string;
}

interface TelegramCallbackResponse {
  text?: string;
  buttons?: Array<{ label: string; action: string }>;
  answerText?: string;
}

interface TelegramSessionHandlerDeps {
  config: MyClawConfig;
  sessionManager: SessionManager;
  modelPicker: ModelPicker;
}

function resolveTelegramSessionId(params: {
  config: MyClawConfig;
  chatId: string;
  userId: string;
  chatType: TelegramChatType;
  threadId?: string;
}): string {
  return SessionManager.resolveSessionId("telegram", params.chatType, params.chatId, params.userId, {
    threadId: params.threadId,
    sessionScope:
      params.chatType === "dm"
        ? params.config.channels.telegram?.dm?.sessionScope ?? "per-user"
        : undefined,
  });
}

export function createTelegramCommandHandler({
  config,
  sessionManager,
  modelPicker,
}: TelegramSessionHandlerDeps): (
  chatId: string,
  userId: string,
  chatType: TelegramChatType,
  command: string,
  args: string,
  meta?: TelegramSessionMeta,
) => Promise<OutgoingMessage | string | undefined> {
  return async (chatId, userId, chatType, command, args, meta) => {
    const sessionId = resolveTelegramSessionId({
      config,
      chatId,
      userId,
      chatType,
      threadId: meta?.threadId,
    });

    switch (command) {
      case "new":
        await sessionManager.resetSession(sessionId, "telegram", chatType);
        return "New session started.";

      case "clear":
        await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
        sessionManager.clearHistory(sessionId);
        await sessionManager.persist(sessionId);
        return "History cleared.";

      case "archive": {
        const trimmed = args.trim();
        if (!trimmed) {
          return "Usage: /archive all | /archive before <ISO date>\nDeletes archives previously created automatically by /new.";
        }
        if (trimmed === "all") {
          const removed = await sessionManager.purgeArchives({ all: true });
          return `Archived sessions deleted: ${removed}`;
        }
        if (trimmed.startsWith("before ")) {
          const rawDate = trimmed.slice("before ".length).trim();
          const date = new Date(rawDate);
          if (Number.isNaN(date.getTime())) {
            return "Invalid date. Example: /archive before 2026-05-01";
          }
          const removed = await sessionManager.purgeArchives({ before: date });
          return `Archived sessions deleted: ${removed}`;
        }
        return "Usage: /archive all | /archive before <ISO date>\nDeletes archives previously created automatically by /new.";
      }

      case "model": {
        const existingSession = await sessionManager.peek(sessionId);
        const currentModel = existingSession?.modelOverride ?? config.llm.defaultModel ?? config.llm.model ?? "";

        if (args) {
          const match = modelPicker.find(args);
          if (!match) {
            return `Unknown model: ${args}`;
          }

          const session =
            existingSession ??
            (await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType));
          session.modelOverride = match.id === (config.llm.defaultModel ?? config.llm.model) ? undefined : match.id;
          session.lastActiveAt = new Date().toISOString();
          await sessionManager.persist(sessionId);
          return `Model changed to ${modelPicker.labelFor(match.id)}`;
        }

        if (!modelPicker.hasModels()) {
          return `Current model: ${currentModel}`;
        }

        return {
          text: `Current model: ${modelPicker.labelFor(currentModel)}`,
          buttons: modelPicker.buildButtons(currentModel),
        };
      }

      case "compact": {
        const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
        const result = await compactSession(config, session, args.trim() || undefined);
        if (!result.ok) {
          return result.reason ?? "Compaction failed.";
        }
        await sessionManager.persist(sessionId);
        return `Context compacted: ${result.beforeCount} → ${result.afterCount} messages.`;
      }

      case "status": {
        const session = await sessionManager.peek(sessionId);
        const currentModel = session?.modelOverride ?? config.llm.defaultModel ?? config.llm.model ?? "";
        if (!session) return `Model: ${currentModel}\nSession: none active`;
        return [
          `Model: ${currentModel}`,
          `Session: ${sessionId}`,
          `Messages: ${session.messages.length}`,
          `Created: ${session.createdAt}`,
          `Last active: ${session.lastActiveAt}`,
        ].join("\n");
      }

      default:
        return undefined;
    }
  };
}

export function createTelegramCallbackHandler({
  config,
  sessionManager,
  modelPicker,
}: TelegramSessionHandlerDeps): (
  ctx: TelegramCallbackContext,
) => Promise<TelegramCallbackResponse | undefined> {
  return async ({ chatId, userId, chatType, data, threadId }) => {
    const modelId = modelPicker.parseCallback(data);
    if (!modelId) return undefined;

    const sessionId = resolveTelegramSessionId({
      config,
      chatId,
      userId,
      chatType,
      threadId,
    });
    const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
    session.modelOverride = modelId === (config.llm.defaultModel ?? config.llm.model) ? undefined : modelId;
    session.lastActiveAt = new Date().toISOString();
    await sessionManager.persist(sessionId);

    return {
      text: `Model changed to ${modelPicker.labelFor(modelId)}`,
      buttons: modelPicker.hasModels() ? modelPicker.buildButtons(modelId) : undefined,
      answerText: "Model updated",
    };
  };
}
