import type { MyClawConfig } from "../config.ts";
import { SessionManager } from "../sessions/manager.ts";
import type { ConfirmationButton, OutgoingMessage } from "./types.ts";
import { ModelPicker } from "./model-picker.ts";

type MatrixChatType = "dm" | "group";
const MATRIX_REACTION_BUTTON_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

interface MatrixActionContext {
  chatId: string;
  userId: string;
  chatType: MatrixChatType;
  data: string;
  messageId: string;
  threadId?: string;
}

interface MatrixActionResponse {
  text?: string;
  buttons?: ConfirmationButton[];
  answerText?: string;
}

interface MatrixSessionHandlerDeps {
  config: MyClawConfig;
  sessionManager: SessionManager;
  modelPicker: ModelPicker;
}

function resolveMatrixSessionId(params: {
  config: MyClawConfig;
  chatId: string;
  userId: string;
  chatType: MatrixChatType;
  roomId?: string;
  threadId?: string;
}): string {
  return SessionManager.resolveSessionId("matrix", params.chatType, params.chatId, params.userId, {
    roomId: params.roomId ?? params.chatId,
    threadId: params.threadId,
    sessionScope:
      params.chatType === "dm" ? params.config.channels.matrix?.dm?.sessionScope ?? "per-user" : undefined,
  });
}

function resolveMatrixModelSelection(
  rawArgs: string,
  config: MyClawConfig,
  modelPicker: ModelPicker,
): { id: string; label: string } | null {
  const args = rawArgs.trim();
  if (!args) return null;

  if (/^\d+$/.test(args)) {
    const index = Number(args) - 1;
    const model = config.llm.models?.[index];
    return model ? { id: model.id, label: model.label } : null;
  }

  const match = modelPicker.find(args);
  return match ? { id: match.id, label: match.label } : null;
}

function buildMatrixModelMenu(params: {
  config: MyClawConfig;
  modelPicker: ModelPicker;
  currentModel: string;
  heading?: string;
}): OutgoingMessage | string {
  if (!params.modelPicker.hasModels()) {
    return `${params.heading ? `${params.heading}\n` : ""}Current model: ${params.modelPicker.labelFor(params.currentModel)}`.trim();
  }

  const models = params.config.llm.models ?? [];
  return {
    text: [
      ...(params.heading ? [params.heading, ""] : []),
      `Current model: ${params.modelPicker.labelFor(params.currentModel)}`,
      "React to this message or send `/model <number|name>`:",
      ...models.map((model, index) => {
        const prefix = MATRIX_REACTION_BUTTON_EMOJIS[index] ?? `${index + 1}.`;
        const suffix = model.id === params.currentModel ? " [selected]" : "";
        return `${prefix} ${model.label}${suffix}`;
      }),
    ].join("\n"),
    buttons: params.modelPicker.buildButtons(params.currentModel),
  };
}

export function createMatrixCommandHandler({
  config,
  sessionManager,
  modelPicker,
}: MatrixSessionHandlerDeps): (
  chatId: string,
  userId: string,
  chatType: MatrixChatType,
  command: string,
  args: string,
  meta?: { roomId?: string; threadId?: string },
  ) => Promise<OutgoingMessage | string | undefined> {
  return async (chatId, userId, chatType, command, args, meta) => {
    const sessionId = resolveMatrixSessionId({
      config,
      chatId,
      userId,
      chatType,
      roomId: meta?.roomId,
      threadId: meta?.threadId,
    });

    switch (command) {
      case "new":
        await sessionManager.resetSession(sessionId, "matrix", chatType);
        return "New session started.";

      case "clear":
        await sessionManager.getOrCreateWithMeta(sessionId, "matrix", chatType);
        sessionManager.clearHistory(sessionId);
        await sessionManager.persist(sessionId);
        return "History cleared.";

      case "model": {
        const existingSession = await sessionManager.peek(sessionId);
        const currentModel = existingSession?.modelOverride ?? config.llm.model;

        if (args) {
          const match = resolveMatrixModelSelection(args, config, modelPicker);
          if (!match) {
            return `Unknown model: ${args}`;
          }

          const session =
            existingSession ??
            (await sessionManager.getOrCreateWithMeta(sessionId, "matrix", chatType));
          session.modelOverride = match.id === config.llm.model ? undefined : match.id;
          session.lastActiveAt = new Date().toISOString();
          await sessionManager.persist(sessionId);
          return `Model changed to ${match.label}`;
        }

        return buildMatrixModelMenu({ config, modelPicker, currentModel });
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

export function createMatrixActionHandler({
  config,
  sessionManager,
  modelPicker,
  }: MatrixSessionHandlerDeps): (
  ctx: MatrixActionContext,
) => Promise<MatrixActionResponse | undefined> {
  return async ({ chatId, userId, chatType, data, threadId }) => {
    const modelId = modelPicker.parseCallback(data);
    if (!modelId) return undefined;

    const sessionId = resolveMatrixSessionId({
      config,
      chatId,
      userId,
      chatType,
      roomId: chatId,
      threadId,
    });
    const session = await sessionManager.getOrCreateWithMeta(sessionId, "matrix", chatType);
    session.modelOverride = modelId === config.llm.model ? undefined : modelId;
    session.lastActiveAt = new Date().toISOString();
    await sessionManager.persist(sessionId);

    return buildMatrixModelMenu({
      config,
      modelPicker,
      currentModel: modelId,
      heading: `Model changed to ${modelPicker.labelFor(modelId)}`,
    }) as OutgoingMessage;
  };
}
