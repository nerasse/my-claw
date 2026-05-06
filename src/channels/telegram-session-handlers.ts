import type { MyClawConfig } from "../config.ts";
import { SessionManager } from "../sessions/manager.ts";
import type { OutgoingMessage } from "./types.ts";
import { ModelPicker } from "./model-picker.ts";

type TelegramChatType = "dm" | "group";

interface TelegramCallbackContext {
  chatId: string;
  userId: string;
  chatType: TelegramChatType;
  data: string;
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
) => Promise<OutgoingMessage | string | undefined> {
  return async (chatId, userId, chatType, command, args) => {
    const sessionId = SessionManager.resolveSessionId("telegram", chatType, chatId, userId);

    switch (command) {
      case "new":
        await sessionManager.resetSession(sessionId, "telegram", chatType);
        return "New session started.";

      case "clear":
        await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
        sessionManager.clearHistory(sessionId);
        await sessionManager.persist(sessionId);
        return "History cleared.";

      case "model": {
        const existingSession = await sessionManager.peek(sessionId);
        const currentModel = existingSession?.modelOverride ?? config.llm.model;

        if (args) {
          const match = modelPicker.find(args);
          if (!match) {
            return `Unknown model: ${args}`;
          }

          const session =
            existingSession ??
            (await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType));
          session.modelOverride = match.id === config.llm.model ? undefined : match.id;
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

      case "status": {
        const session = await sessionManager.peek(sessionId);
        const currentModel = session?.modelOverride ?? config.llm.model;
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
  return async ({ chatId, userId, chatType, data }) => {
    const modelId = modelPicker.parseCallback(data);
    if (!modelId) return undefined;

    const sessionId = SessionManager.resolveSessionId("telegram", chatType, chatId, userId);
    const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
    session.modelOverride = modelId === config.llm.model ? undefined : modelId;
    session.lastActiveAt = new Date().toISOString();
    await sessionManager.persist(sessionId);

    return {
      text: `Model changed to ${modelPicker.labelFor(modelId)}`,
      buttons: modelPicker.hasModels() ? modelPicker.buildButtons(modelId) : undefined,
      answerText: "Model updated",
    };
  };
}
