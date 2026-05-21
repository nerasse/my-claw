import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { MyClawConfig } from "../../core/config.ts";
import { SessionManager } from "../../sessions/manager.ts";
import { compactSession } from "../../sessions/compaction.ts";
import type { ApprovalDecision, ConfirmationButton, OutgoingMessage, ToolApprovalRequest } from "../types.ts";
import { ModelPicker } from "../model-picker.ts";
import { SkillRegistry } from "../../skills/registry.ts";
import { loadAllSkills } from "../../skills/loader.ts";
import { createMatrixApprovalStore, type PersistedPendingMatrixApproval } from "./approval-store.ts";
import { MATRIX_REACTION_BUTTON_EMOJIS } from "./actions.ts";

type MatrixChatType = "dm" | "group";

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

export interface MatrixApprovalHandler {
  requestApproval: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
  cancelApproval: (id: string) => boolean;
  resolveAction: (ctx: MatrixActionContext) => Promise<MatrixActionResponse | undefined>;
  persistPendingApprovals: () => Promise<void>;
  restorePendingApprovals: () => Promise<void>;
}

interface MatrixSessionHandlerDeps {
  config: MyClawConfig;
  sessionManager: SessionManager;
  modelPicker: ModelPicker;
  approvalHandler?: MatrixApprovalHandler;
  skillRegistry?: SkillRegistry;
  builtinDir?: string;
  customDir?: string;
  workspaceSkillsDir?: string;
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
      models.length > MATRIX_REACTION_BUTTON_EMOJIS.length
        ? "Reply with a number/name for any option, react to this message for the first 10, or send `/model <number|name>`:"
        : "Reply with a number/name, react to this message, or send `/model <number|name>`:",
      ...models.map((model, index) => {
        const prefix = MATRIX_REACTION_BUTTON_EMOJIS[index] ?? `${index + 1}.`;
        const suffix = model.id === params.currentModel ? " [selected]" : "";
        return `${prefix} ${model.label}${suffix}`;
      }),
    ].join("\n"),
    buttons: params.modelPicker.buildButtons(params.currentModel),
  };
}

export function buildMatrixApprovalMenu(params: {
  request: ToolApprovalRequest;
  expired?: boolean;
  decision?: ApprovalDecision;
}): OutgoingMessage {
  const args = JSON.stringify(params.request.args, null, 2);
  const heading = params.expired
    ? `Approval expired for tool \`${params.request.toolName}\`.`
    : params.decision === "deny"
      ? `Tool \`${params.request.toolName}\` denied.`
      : params.decision === "allow-session"
        ? `Tool \`${params.request.toolName}\` approved for this session.`
        : params.decision === "allow-once"
          ? `Tool \`${params.request.toolName}\` approved once.`
          : `Approval required for tool \`${params.request.toolName}\`.`;
  const text = [
    heading,
    "",
    `Tool: ${params.request.toolName}`,
    `Session: ${params.request.sessionId}`,
    `Requested by: ${params.request.userId}`,
    `Message: ${params.request.messageId}`,
    "",
    "Arguments:",
    "```json",
    args,
    "```",
    params.expired || params.decision
      ? ""
      : "Reply with `1`, `2`, `3`, or the button label. You can also react: 1️⃣ allow once, 2️⃣ allow for this session, 3️⃣ deny.",
  ].join("\n");
  return {
    text,
    buttons: params.expired || params.decision
      ? undefined
      : [
          { label: "Allow once", action: `apr:once:${params.request.id}` },
          { label: "Allow session", action: `apr:session:${params.request.id}` },
          { label: "Deny", action: `apr:deny:${params.request.id}` },
        ],
  };
}

function buildMatrixModelsList(params: {
  config: MyClawConfig;
  modelPicker: ModelPicker;
  currentModel: string;
}): string {
  const models = params.config.llm.models ?? [];
  if (models.length === 0) {
    return `Current model: ${params.modelPicker.labelFor(params.currentModel)}`;
  }

  return [
    `Current model: ${params.modelPicker.labelFor(params.currentModel)}`,
    "Available models:",
    ...models.map((model, index) => {
      const suffix = model.id === params.currentModel ? " [selected]" : "";
      return `${index + 1}. ${model.label} (${model.id})${suffix}`;
    }),
    "",
    "Use `/model <number|name>` to switch, or `/model` to reopen the interactive menu.",
  ].join("\n");
}

function parseApprovalAction(data: string): { id: string; decision: ApprovalDecision } | null {
  const match = /^apr:(once|session|deny):(.+)$/.exec(data.trim());
  if (!match) return null;
  const mode = match[1];
  const id = match[2];
  if (!id) return null;
  if (mode === "once") return { id, decision: "allow-once" };
  if (mode === "session") return { id, decision: "allow-session" };
  return { id, decision: "deny" };
}

export function createMatrixApprovalHandler(storagePath?: string): MatrixApprovalHandler {
  const matrixApprovalStore = createMatrixApprovalStore(undefined, { unrefTimers: true });
  const persist = async () => {
    if (!storagePath) return;
    const snapshot = matrixApprovalStore.snapshot();
    const dir = storagePath.slice(0, storagePath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(storagePath, JSON.stringify(snapshot, null, 2));
  };

  const restore = async () => {
    if (!storagePath) return;
    const raw = await readFile(storagePath, "utf-8").catch(() => "[]");
    matrixApprovalStore.restore(JSON.parse(raw) as PersistedPendingMatrixApproval[]);
  };

  return {
    async requestApproval(request) {
      const resultPromise = matrixApprovalStore.request(request);
      await persist().catch(() => undefined);
      return await resultPromise;
    },

    cancelApproval(id) {
      const cancelled = matrixApprovalStore.cancel(id);
      void persist().catch(() => undefined);
      return cancelled;
    },

    async resolveAction({ data, userId }) {
      const parsed = parseApprovalAction(data);
      if (!parsed) return undefined;
      const pending = matrixApprovalStore.peek(parsed.id);
      if (pending && pending.userId !== userId) {
        return {
          text: `Only the requesting user (${pending.userId}) can approve or deny this tool call.`,
        };
      }
      const resolved = matrixApprovalStore.resolve(parsed.id, parsed.decision);
      if (!resolved) {
        return {
          text: "Approval request expired or already resolved.",
        };
      }
      await persist().catch(() => undefined);
      return buildMatrixApprovalMenu({
        request: resolved.request,
        expired: resolved.expired,
        decision: resolved.expired ? undefined : parsed.decision,
      });
    },

    async persistPendingApprovals() {
      await persist();
    },

    async restorePendingApprovals() {
      await restore();
    },
  };
}

export function createMatrixCommandHandler({
  config,
  sessionManager,
  modelPicker,
  skillRegistry,
  builtinDir,
  customDir,
  workspaceSkillsDir,
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
          const match = resolveMatrixModelSelection(args, config, modelPicker);
          if (!match) {
            return [
              `Unknown model: ${args}`,
              "Use `/models` to browse configured models or `/model` to reopen the interactive menu.",
            ].join("\n");
          }

          const session =
            existingSession ??
            (await sessionManager.getOrCreateWithMeta(sessionId, "matrix", chatType));
          session.modelOverride = match.id === (config.llm.defaultModel ?? config.llm.model) ? undefined : match.id;
          session.lastActiveAt = new Date().toISOString();
          await sessionManager.persist(sessionId);
          return `Model changed to ${match.label}`;
        }

        return buildMatrixModelMenu({ config, modelPicker, currentModel });
      }

      case "models": {
        const existingSession = await sessionManager.peek(sessionId);
        const currentModel = existingSession?.modelOverride ?? config.llm.defaultModel ?? config.llm.model ?? "";
        return buildMatrixModelsList({ config, modelPicker, currentModel });
      }

      case "verbose": {
        const session = await sessionManager.getOrCreateWithMeta(sessionId, "matrix", chatType);
        session.verbose = session.verbose === false ? undefined : false;
        session.lastActiveAt = new Date().toISOString();
        await sessionManager.persist(sessionId);
        return `Verbose mode: ${session.verbose === false ? "OFF" : "ON"}`;
      }

      case "compact": {
        const session = await sessionManager.getOrCreateWithMeta(sessionId, "matrix", chatType);
        const result = await compactSession(config, session, args.trim() || undefined);
        if (!result.ok) {
          return result.reason ?? "Compaction failed.";
        }
        await sessionManager.persist(sessionId);
        return `Context compacted: ${result.beforeCount} → ${result.afterCount} messages.`;
      }

      case "reload":
      case "reload-skills": {
        if (!skillRegistry || !builtinDir || !customDir || !workspaceSkillsDir) {
          return "Skill registry not available.";
        }
        const allSkills = await loadAllSkills({ builtInDir: builtinDir, customDir, workspaceDir: workspaceSkillsDir });
        skillRegistry.setAll(allSkills);
        return `Skills reloaded. ${allSkills.size} skills available.`;
      }

      case "help":
      case "commands":
        return undefined;

      case "status": {
        const session = await sessionManager.peek(sessionId);
        const currentModel = session?.modelOverride ?? config.llm.defaultModel ?? config.llm.model ?? "";
        if (!session) return `Model: ${currentModel}\nSession: none active`;
        const lines = [
          `Model: ${currentModel}`,
          `Session: ${sessionId}`,
          `Messages: ${session.messages.length}`,
          `Created: ${session.createdAt}`,
          `Last active: ${session.lastActiveAt}`,
        ];
        if (session.tokenUsage) {
          const u = session.tokenUsage;
          lines.push(`Tokens: ${u.totalTokens.toLocaleString()} (in: ${u.promptTokens.toLocaleString()}, out: ${u.completionTokens.toLocaleString()})`);
          lines.push(`API calls: ${u.apiCalls}`);
        }
        return lines.join("\n");
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
  approvalHandler = createMatrixApprovalHandler(),
}: MatrixSessionHandlerDeps): (
  ctx: MatrixActionContext,
) => Promise<MatrixActionResponse | undefined> {
  return async ({ chatId, userId, chatType, data, threadId }) => {
    const approval = await approvalHandler.resolveAction({
      chatId,
      userId,
      chatType,
      data,
      messageId: "",
      threadId,
    });
    if (approval) {
      return approval;
    }

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
    session.modelOverride = modelId === (config.llm.defaultModel ?? config.llm.model) ? undefined : modelId;
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
