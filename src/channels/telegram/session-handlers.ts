import type { MyClawConfig } from "../../core/config.ts";
import { SessionManager } from "../../sessions/manager.ts";
import { compactSession } from "../../sessions/compaction.ts";
import { isSdkBackedModel } from "../../llm/resolver.ts";
import type { OutgoingMessage } from "../types.ts";
import { ModelPicker, formatModelGroupSummary, parseEffortArg } from "../model-picker.ts";
import { SkillRegistry } from "../../skills/registry.ts";
import { loadAllSkills } from "../../skills/loader.ts";
import { hooks } from "../../hooks/index.ts";
import { runRegistry } from "../../core/run-registry.ts";
import { handleAuthCommand } from "../auth-commands.ts";

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
  // SDK-owned sessions must compact through the SDK, not the mirror summarizer.
  sdkCompact?: (session: import("../../sessions/store.ts").SessionData) => Promise<string>;
  // Push an unsolicited message to a chat/thread later (Codex device-code login completion).
  postMessage?: (chatId: string, text: string, threadId?: string) => Promise<void>;
  // Ensure the provider exists + re-run model discovery after a Codex/Claude auth change.
  onAuthChanged?: (provider: "codex" | "claude") => void | Promise<void>;
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
  sdkCompact,
  postMessage,
  onAuthChanged,
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

        const effort = existingSession?.effortOverride ?? config.llm.effort;
        return {
          text: `Current model: ${modelPicker.labelFor(currentModel)}${modelPicker.effortHeaderSuffix(effort)}`,
          buttons: modelPicker.buildButtons(currentModel),
        };
      }

      case "effort": {
        const levels = modelPicker.effortLevels();
        if (levels.length === 0) return "Effort control is not enabled.";
        const existingSession = await sessionManager.peek(sessionId);
        const currentEffort = existingSession?.effortOverride ?? config.llm.effort;
        const requested = args.trim();
        if (requested) {
          const level = parseEffortArg(requested, levels);
          if (!level) return `Unknown effort: ${requested}. Options: ${levels.join(", ")}.`;
          const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
          session.effortOverride = level;
          session.lastActiveAt = new Date().toISOString();
          await sessionManager.persist(sessionId);
          return `Effort set to ${level}`;
        }
        return {
          text: `Effort — current: ${currentEffort ?? "default"}`,
          buttons: modelPicker.buildEffortButtons(currentEffort, { currentModelId: existingSession?.modelOverride ?? config.llm.defaultModel ?? config.llm.model ?? "" }),
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
          "Available models by group:",
          ...formatModelGroupSummary(models, currentModel),
          "",
          "Use /model to open the menu, or /model <name> to switch.",
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
        if (isSdkBackedModel(config.llm, session.modelOverride) && sdkCompact) {
          const outcome = await sdkCompact(session);
          await sessionManager.persist(sessionId);
          return outcome;
        }
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

      case "codex":
      case "claude":
        return handleAuthCommand({
          provider: command,
          args,
          isDm: chatType === "dm",
          postFollowUp: (text) => { void postMessage?.(chatId, text, meta?.threadId); },
          onAuthChanged,
        });

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
    const action = modelPicker.parseCallbackAction(data);
    if (!action) return undefined;

    const sessionId = resolveTelegramSessionId({
      config,
      chatId,
      userId,
      chatType,
      threadId,
    });
    const defaultModel = config.llm.defaultModel ?? config.llm.model ?? "";

    // Navigation re-render without touching the model (no selection yet).
    if (action.kind === "openGroup" || action.kind === "back" || action.kind === "openEffort") {
      const existing = await sessionManager.peek(sessionId);
      const currentModel = existing?.modelOverride ?? defaultModel;
      const currentEffort = existing?.effortOverride ?? config.llm.effort;
      const suffix = modelPicker.effortHeaderSuffix(currentEffort);
      if (action.kind === "openGroup") {
        return {
          text: `${modelPicker.groupLabel(action.groupIndex) ?? "Models"} — current: ${modelPicker.labelFor(currentModel)}${suffix}`,
          buttons: modelPicker.buildGroupButtons(action.groupIndex, currentModel),
          answerText: modelPicker.groupLabel(action.groupIndex),
        };
      }
      // Effort submenu, reachable without re-selecting a model.
      if (action.kind === "openEffort") {
        return {
          text: `Effort — current: ${currentEffort ?? "default"}`,
          buttons: modelPicker.buildEffortButtons(currentEffort, { currentModelId: currentModel }),
          answerText: "Effort",
        };
      }
      return {
        text: `Current model: ${modelPicker.labelFor(currentModel)}${suffix}`,
        buttons: modelPicker.buildButtons(currentModel),
        answerText: "Back",
      };
    }

    // Terminal steps close the menu (text without keyboard).
    if (action.kind === "setEffort") {
      const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
      session.effortOverride = action.level;
      session.lastActiveAt = new Date().toISOString();
      await sessionManager.persist(sessionId);
      const model = session.modelOverride ?? defaultModel;
      return {
        text: `Effort set to ${action.level} — model: ${modelPicker.labelFor(model)}`,
        answerText: `Effort: ${action.level}`,
      };
    }

    if (action.kind === "keepEffort") {
      const existing = await sessionManager.peek(sessionId);
      const model = existing?.modelOverride ?? defaultModel;
      const currentEffort = existing?.effortOverride ?? config.llm.effort;
      return {
        text: `Model: ${modelPicker.labelFor(model)} — effort unchanged (${currentEffort ?? "default"})`,
        answerText: "Effort kept",
      };
    }

    // Selecting a model chains into the effort choice so you can set it in one flow.
    // /effort also works as a standalone shortcut and the Effort > entry in the root menu
    // opens the effort submenu without re-selecting a model.
    const modelId = action.modelId;
    const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
    const currentEffort = session.effortOverride ?? config.llm.effort;
    session.modelOverride = modelId === defaultModel ? undefined : modelId;
    session.lastActiveAt = new Date().toISOString();
    await sessionManager.persist(sessionId);
    const label = modelPicker.labelFor(modelId);

    const levels = modelPicker.effortLevels();
    if (levels.length > 0) {
      return {
        text: `Model changed to ${label} — now choose reasoning effort (current: ${currentEffort ?? "default"})`,
        buttons: modelPicker.buildEffortButtons(currentEffort, { chained: true, currentModelId: modelId }),
        answerText: "Model updated",
      };
    }

    return {
      text: `Model changed to ${label}`,
      answerText: "Model updated",
    };
  };
}
