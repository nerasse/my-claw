import type { MyClawConfig } from "../../core/config.ts";
import { SessionManager } from "../../sessions/manager.ts";
import { compactSession } from "../../sessions/compaction.ts";
import type { OutgoingMessage } from "../types.ts";
import { ModelPicker } from "../model-picker.ts";
import { SkillRegistry } from "../../skills/registry.ts";
import { loadAllSkills } from "../../skills/loader.ts";
import { hooks } from "../../hooks/index.ts";
import { runRegistry } from "../../core/run-registry.ts";

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
  skillRegistry?: SkillRegistry;
  builtinDir?: string;
  customDir?: string;
  workspaceSkillsDir?: string;
  listCronJobs?: () => Promise<Array<{ id: string; name: string; schedule: { display: string }; enabled: boolean; state: string; nextRunAt: string | null }>>;
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
  skillRegistry,
  builtinDir,
  customDir,
  workspaceSkillsDir,
  listCronJobs,
}: TelegramSessionHandlerDeps): (
  chatId: string,
  userId: string,
  chatType: TelegramChatType,
  command: string,
  args: string,
  meta?: TelegramSessionMeta,
) => Promise<OutgoingMessage | string | undefined> {
  const handler = async (chatId: string, userId: string, chatType: TelegramChatType, command: string, args: string, meta?: TelegramSessionMeta): Promise<OutgoingMessage | string | undefined> => {
    hooks.emit("command:received", { command, args, platform: "telegram", userId });
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
          const previousModel = session.modelOverride ?? config.llm.defaultModel ?? config.llm.model ?? "";
          session.modelOverride = match.id === (config.llm.defaultModel ?? config.llm.model) ? undefined : match.id;
          session.lastActiveAt = new Date().toISOString();
          await sessionManager.persist(sessionId);
          hooks.emit("session:model:changed", { sessionId, previousModel, newModel: match.id });
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

      case "models": {
        const existingSession = await sessionManager.peek(sessionId);
        const currentModel = existingSession?.modelOverride ?? config.llm.defaultModel ?? config.llm.model ?? "";
        const models = config.llm.models ?? [];
        if (models.length === 0) {
          return `Current model: ${modelPicker.labelFor(currentModel)}`;
        }
        return [
          `Current model: ${modelPicker.labelFor(currentModel)}`,
          "Available models:",
          ...models.map((m, i) => {
            const suffix = m.id === currentModel ? " [selected]" : "";
            return `${i + 1}. ${m.label} (${m.id})${suffix}`;
          }),
          "",
          "Use /model <number|name> to switch.",
        ].join("\n");
      }

      case "verbose": {
        const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
        session.verbose = session.verbose === false ? undefined : false;
        session.lastActiveAt = new Date().toISOString();
        await sessionManager.persist(sessionId);
        return `Verbose mode: ${session.verbose === false ? "OFF" : "ON"}`;
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

      case "reload": {
        if (!skillRegistry || !builtinDir || !customDir || !workspaceSkillsDir) {
          return "Skill registry not available.";
        }
        const allSkills = await loadAllSkills({ builtInDir: builtinDir, customDir, workspaceDir: workspaceSkillsDir });
        skillRegistry.setAll(allSkills);
        hooks.emit("skills:reloaded", { count: allSkills.size });
        return `Skills reloaded. ${allSkills.size} skills available.`;
      }

      case "cron": {
        if (!listCronJobs) return "Cron not available.";
        const jobs = await listCronJobs();
        if (jobs.length === 0) return "No scheduled tasks.";
        const lines = jobs.map((j) => {
          const status = j.enabled ? j.state : "paused";
          const next = j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : "-";
          return `${j.id} | ${j.name} | ${j.schedule.display} | ${status} | next: ${next}`;
        });
        return lines.join("\n");
      }

      case "stop":
        return runRegistry.stop(sessionId) ? "Stopped." : "Nothing running.";

      case "status": {
        const session = await sessionManager.peek(sessionId);
        const currentModel = session?.modelOverride ?? config.llm.defaultModel ?? config.llm.model ?? "";
        const live = runRegistry.list(sessionId);
        const liveLine = live.length > 0
          ? `Active run: ${live.map((r) => (r.depth === 0 ? "main" : `${r.label}[${r.depth}]`)).join(", ")}`
          : undefined;
        if (!session) {
          return [`Model: ${currentModel}`, "Session: none active", ...(liveLine ? [liveLine] : [])].join("\n");
        }
        const lines = [
          `Model: ${currentModel}`,
          `Session: ${sessionId}`,
          `Messages: ${session.messages.length}`,
          `Created: ${session.createdAt}`,
          `Last active: ${session.lastActiveAt}`,
        ];
        if (liveLine) lines.push(liveLine);
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
  return async (chatId, userId, chatType, command, args, meta) => {
    const result = await handler(chatId, userId, chatType, command, args, meta);
    const responseText = typeof result === "string" ? result : typeof result === "object" && result?.text ? result.text : undefined;
    hooks.emit("command:handled", { command, platform: "telegram", response: responseText });
    return result;
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
