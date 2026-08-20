import type { ModelPricing } from "../../llm/pricing.ts";
import type { MyClawConfig } from "../../core/config.ts";
import { resolveAgentLlm, tagNameOf } from "../../core/config.ts";
import { SessionManager } from "../../sessions/manager.ts";
import { effectiveEffort } from "../../llm/resolver.ts";
import { handleSharedSessionCommand } from "../session-commands.ts";
import { chatModel } from "../../llm/chat-model.ts";
import { overrideForPick } from "../../llm/run-model.ts";
import { availabilityWorld } from "../../llm/world.ts";
import type { OutgoingMessage } from "../types.ts";
import { ModelPicker, formatEffort, formatModelGroupSummary, parseEffortArg } from "../model-picker.ts";
import { SkillRegistry } from "../../skills/registry.ts";
import type { AgentRegistry } from "../../agents/registry.ts";
import { hooks } from "../../hooks/index.ts";
import { handleAuthCommand } from "../auth-commands.ts";
import { handleAgentModelCommand, applyAgentModel, applyAgentEffort, currentAgentModel, applyAgentContext, toolTypeOf } from "../agent-model-commands.ts";
import type { ToolRegistry } from "../../tools/registry.ts";
import type { McpServerStatus } from "../../mcp/manager.ts";
import type { SubAgentInfo } from "../../subagents/types.ts";
import { redactCommandArgs } from "../command-log.ts";
import { log } from "../../utils/logger.ts";
import { contextChoiceFor, formatContextInfo } from "../context-menu.ts";
import { referenceWithRoute, routeChoiceFor, routeLabel, routesFor, sortRoutes } from "../route-menu.ts";
import { withoutEndpoint } from "../../llm/model-ref.ts";
import type { ContextOverride } from "../../llm/context-window.ts";

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
  // Introspection commands (/skills, /agents, /mcp, /instructions). Optional so a host or a test
  // can build the handler without them; the commands then report the gap instead of throwing.
  toolRegistry?: ToolRegistry;
  mcpStatus?: () => McpServerStatus[];
  listSubAgents?: (sessionId: string) => Promise<SubAgentInfo[]>;
  // Price table for /status cost reporting. Optional: without it /status reports tokens only.
  pricing?: ModelPricing;
  config: MyClawConfig;
  sessionManager: SessionManager;
  modelPicker: ModelPicker;
  skillRegistry?: SkillRegistry;
  agentRegistry?: AgentRegistry;
  /** Rescan of `agents/`, injected rather than rebuilt from dirs here: the host already owns the
   *  tier list and it changes with `config.workspaces`. */
  reloadAgents?: () => Promise<number>;
  builtinDir?: string;
  customDir?: string;
  workspaceSkillsDir?: string;
  listCronJobs?: () => Promise<Array<{ id: string; name: string; schedule: { display: string }; enabled: boolean; state: string; nextRunAt: string | null }>>;
  // SDK-owned sessions must compact through the SDK, not the mirror summarizer.
  sdkCompact?: (session: import("../../sessions/store.ts").SessionData, stopSignal?: AbortSignal) => Promise<import("../../agent/backend.ts").CompactOutcome>;
  // Push an unsolicited message to a chat/thread later (Codex device-code login completion).
  postMessage?: (chatId: string, text: string, threadId?: string) => Promise<void>;
  // Ensure the provider exists + re-run model discovery after a Codex/Claude auth change.
  onAuthChanged?: (provider: "codex" | "claude") => void | Promise<void>;
  // Apply a config restore through the normal reload path (a restored dotfile fires no fs.watch
  // event, so /config rollback cannot rely on the watcher noticing).
  reloadConfigNow?: () => Promise<{ changed: string[]; rebootRequired: string[] }>;
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
  agentRegistry,
  reloadAgents,
  builtinDir,
  customDir,
  workspaceSkillsDir,
  listCronJobs,
  sdkCompact,
  postMessage,
  onAuthChanged,
  reloadConfigNow,
  toolRegistry,
  mcpStatus,
  listSubAgents,
  pricing,
}: TelegramSessionHandlerDeps): (
  chatId: string,
  userId: string,
  chatType: TelegramChatType,
  command: string,
  args: string,
  meta?: TelegramSessionMeta,
) => Promise<OutgoingMessage | string | undefined> {
  const handler = async (chatId: string, userId: string, chatType: TelegramChatType, command: string, args: string, meta?: TelegramSessionMeta): Promise<OutgoingMessage | string | undefined> => {
    const loggedArgs = redactCommandArgs(command, args);
    hooks.emit("command:received", { command, args: loggedArgs, platform: "telegram", userId });
    const sessionId = resolveTelegramSessionId({
      config,
      chatId,
      userId,
      chatType,
      threadId: meta?.threadId,
    });
    // The session id is the point of this record: it is what ties a command to the session whose
    // history it changed.
    void log("info", "command received", {
      platform: "telegram",
      command,
      args: loggedArgs,
      userId,
      chatId,
      chatType,
      sessionId,
    });

    const shared = await handleSharedSessionCommand({
      command,
      args,
      platform: "telegram",
      chatType,
      sessionId,
      config,
      sessionManager,
      skillRegistry,
      agentRegistry,
      toolRegistry,
      mcpStatus,
      listSubAgents,
      builtinDir,
      customDir,
      workspaceSkillsDir,
      reloadAgents,
      listCronJobs,
      pricing,
      reloadConfigNow,
      sdkCompact,
    });
    if (shared !== undefined) return shared;

    switch (command) {
      case "model": {
        // `/model <agent>` targets a persisted default; anything else is this chat's own override.
        const agentOutcome = await handleAgentModelCommand(args, {
          config,
          modelPicker,
          listSubAgents: listSubAgents ? () => listSubAgents(sessionId) : (async () => []),
          listAgents: () => agentRegistry?.names() ?? [],
          reloadConfigNow,
          isDm: chatType === "dm",
        });
        if (agentOutcome.kind === "message") return agentOutcome.text;
        if (agentOutcome.kind === "menu") {
          const agentContext = contextChoiceFor(config, agentOutcome.currentModel, undefined, toolTypeOf(agentOutcome.target));
          return {
            text: `${agentOutcome.heading} — actuel : ${modelPicker.labelFor(agentOutcome.currentModel)}\n${formatContextInfo(config, agentOutcome.currentModel, undefined, toolTypeOf(agentOutcome.target))}`,
            buttons: modelPicker.buildButtons(agentOutcome.currentModel, agentOutcome.target, {
              contextChoice: agentContext.available,
              routeChoice: routeChoiceFor(config, agentOutcome.currentModel).available,
            }),
          };
        }

        const existingSession = await sessionManager.peek(sessionId);
        const currentModel = chatModel(config, existingSession?.modelOverride);

        if (args) {
          const match = modelPicker.find(args);
          if (!match) {
            return `Unknown model: ${args}`;
          }

          const session =
            existingSession ??
            (await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType));
          const previousModel = chatModel(config, session.modelOverride);
          session.modelOverride = overrideForPick(config, { agent: "main" }, match.id, availabilityWorld());
          session.lastActiveAt = new Date().toISOString();
          await sessionManager.persist(sessionId);
          hooks.emit("session:model:changed", { sessionId, previousModel, newModel: match.id });
          return `Model changed to ${modelPicker.labelFor(match.id)}\n${formatContextInfo(config, match.id, session.contextOverride)}`;
        }

        if (!modelPicker.hasModels()) {
          return `Current model: ${currentModel}\n${formatContextInfo(config, currentModel, existingSession?.contextOverride)}`;
        }

        const effort = effectiveEffort(config.llm, currentModel, existingSession?.effortOverride);
        return {
          text: `Current model: ${modelPicker.labelFor(currentModel)}${modelPicker.effortHeaderSuffix(effort)}\n${formatContextInfo(config, currentModel, existingSession?.contextOverride)}`,
          buttons: modelPicker.buildButtons(currentModel, undefined, {
            routeChoice: routeChoiceFor(config, currentModel).available,
          }),
        };
      }

      case "effort": {
        const existingSession = await sessionManager.peek(sessionId);
        // Levels are per model: listing the global set would offer values the current model rejects.
        const activeModel = chatModel(config, existingSession?.modelOverride);
        const effort = effectiveEffort(config.llm, activeModel, existingSession?.effortOverride);
        const levels = modelPicker.effortLevelsFor(activeModel);
        if (effort.source === "unsupported" || levels.length === 0) {
          return `Effort has no effect on ${modelPicker.labelFor(activeModel)}.`;
        }
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
          text: `Effort — current: ${formatEffort(effort)}\n${formatContextInfo(config, activeModel, existingSession?.contextOverride)}`,
          buttons: modelPicker.buildEffortButtons(effort, { currentModelId: activeModel }),
        };
      }

      case "models": {
        const existingSession = await sessionManager.peek(sessionId);
        const currentModel = chatModel(config, existingSession?.modelOverride);
        const effort = effectiveEffort(config.llm, currentModel, existingSession?.effortOverride);
        const models = config.llm.models ?? [];
        if (models.length === 0) {
          return `Current model: ${modelPicker.labelFor(currentModel)}${modelPicker.effortHeaderSuffix(effort)}\n${formatContextInfo(config, currentModel, existingSession?.contextOverride)}`;
        }
        return [
          `Current model: ${modelPicker.labelFor(currentModel)}${modelPicker.effortHeaderSuffix(effort)}`,
          formatContextInfo(config, currentModel, existingSession?.contextOverride),
          "Available models by group:",
          ...formatModelGroupSummary(models, currentModel),
          "",
          "Use /model to open the menu, or /model <name> to switch.",
        ].join("\n");
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
    // `undefined` means the switch had no branch for it: Telegram answers nothing at all, so
    // without this line an unknown command leaves no trace of having been typed.
    if (result === undefined) {
      void log("info", "command not recognized", { platform: "telegram", command, userId, chatId });
    }
    return result;
  };
}

export function createTelegramCallbackHandler({
  config,
  sessionManager,
  modelPicker,
  reloadConfigNow,
}: TelegramSessionHandlerDeps): (
  ctx: TelegramCallbackContext,
) => Promise<TelegramCallbackResponse | undefined> {
  return async ({ chatId, userId, chatType, data, threadId }) => {
    const action = modelPicker.parseCallbackAction(data);
    if (!action) return undefined;

    if (action.kind === "stale") {
      return {
        text: "That menu is out of date (the model list changed). Send /model again.",
        answerText: "Menu out of date",
      };
    }

    const sessionId = resolveTelegramSessionId({
      config,
      chatId,
      userId,
      chatType,
      threadId,
    });
    const defaultModel = config.llm.defaultModel ?? config.llm.model ?? "";

    // The context step is chained after the effort one, so a single flow sets model, effort and
    // window. Terminal when this model has nothing to arbitrate: a lone option is not a choice.
    const chainContext = (model: string, override: ContextOverride | undefined, text: string, answerText: string) => {
      const choice = contextChoiceFor(config, model, override);
      if (!choice.available) return { text, answerText };
      return {
        text: `${text}\n${formatContextInfo(config, model, override)}\nChoisissez maintenant la fenêtre de contexte`,
        buttons: modelPicker.buildContextButtons(choice.tiers, { chained: true }),
        answerText,
      };
    };

    // An agent-targeted menu edits config, never this chat. Handled before the session branches so
    // a target can never fall through into them and silently change the wrong thing.
    if ("target" in action && action.target) {
      const target = action.target;
      const currentModel = currentAgentModel(config, target);
      const agentChoice = contextChoiceFor(config, currentModel, undefined, toolTypeOf(target));
      // The effort this agent would run with: its own pin, unless a tag or a session override
      // speaks first. The config view has no session, so the session never applies here.
      const agentEffort = () =>
        effectiveEffort(config.llm, currentModel, undefined, resolveAgentLlm(config, toolTypeOf(target))?.effort);
      if (action.kind === "select") {
        const text = await applyAgentModel(target, action.modelId, { config, modelPicker, reloadConfigNow });
        // The flow continues: model, then effort, then window, exactly like the session flow.
        // No effort step when the staged model is a tag: the tag's own pin would always win, so
        // writing one here would be dead config.
        const levels = modelPicker.effortLevelsFor(action.modelId);
        const effort = effectiveEffort(config.llm, action.modelId, undefined, resolveAgentLlm(config, toolTypeOf(target))?.effort);
        if (tagNameOf(action.modelId) === undefined && effort.source !== "unsupported" && levels.length > 0) {
          return {
            text: `${text}\nChoisissez maintenant l'effort. Actuel : ${formatEffort(effort)}`,
            buttons: modelPicker.buildEffortButtons(effort, { chained: true, currentModelId: action.modelId, target }),
            answerText: "Config mise à jour",
          };
        }
        return { text, answerText: "Config mise à jour" };
      }
      if (action.kind === "setEffort") {
        const text = await applyAgentEffort(target, action.level, { config, reloadConfigNow });
        if (agentChoice.available) {
          return {
            text: `${text}\n${formatContextInfo(config, currentModel, undefined, toolTypeOf(target))}\nChoisissez maintenant la fenêtre de contexte`,
            buttons: modelPicker.buildContextButtons(agentChoice.tiers, { chained: true, target }),
            answerText: "Config mise à jour",
          };
        }
        return { text, answerText: "Config mise à jour" };
      }
      if (action.kind === "keepEffort") {
        const effort = agentEffort();
        const text = `Effort de l'agent ${target} inchangé : ${formatEffort(effort)}`;
        if (agentChoice.available) {
          return {
            text: `${text}\n${formatContextInfo(config, currentModel, undefined, toolTypeOf(target))}\nChoisissez maintenant la fenêtre de contexte`,
            buttons: modelPicker.buildContextButtons(agentChoice.tiers, { chained: true, target }),
            answerText: "Effort conservé",
          };
        }
        return { text, answerText: "Effort conservé" };
      }
      if (action.kind === "openEffort") {
        return {
          text: `Effort de l'agent ${target} — ${modelPicker.labelFor(currentModel)} — actuel : ${formatEffort(agentEffort())}`,
          buttons: modelPicker.buildEffortButtons(agentEffort(), { currentModelId: currentModel, target }),
          answerText: "Effort",
        };
      }
      if (action.kind === "openRoute") {
        const sort = action.sort ?? "price";
        const routes = sortRoutes(await routesFor(config, currentModel), sort);
        return {
          text: `Route de l'agent ${target} — ${modelPicker.labelFor(currentModel)} — actuelle : ${routeChoiceFor(config, currentModel).current ?? "automatique"}`,
          buttons: modelPicker.buildRouteButtons(
            routes.map((route) => ({ tag: route.tag, label: routeLabel(route) })),
            routeChoiceFor(config, currentModel).current,
            target,
            sort,
          ),
          answerText: "Route",
        };
      }
      if (action.kind === "setRoute") {
        // The route rides inside the reference, so pinning one is the same config write as
        // picking a model: one field, one meaning (docs/model-identity.md).
        const text = await applyAgentModel(target, referenceWithRoute(currentModel, action.endpoint), {
          config,
          modelPicker,
          reloadConfigNow,
        });
        return { text, answerText: action.endpoint ? `Route : ${action.endpoint}` : "Route automatique" };
      }
      if (action.kind === "setContext") {
        return {
          text: await applyAgentContext(target, action.choice, { config, reloadConfigNow }),
          answerText: "Config mise a jour",
        };
      }
      if (action.kind === "openContext") {
        return {
          text: `Fenetre de contexte de l'agent ${target} — ${modelPicker.labelFor(currentModel)}\n${formatContextInfo(config, currentModel, undefined, toolTypeOf(target))}`,
          buttons: modelPicker.buildContextButtons(agentChoice.tiers, { target }),
          answerText: "Contexte",
        };
      }
      const buttons =
        action.kind === "openGroup"
          ? modelPicker.buildGroupButtons(action.groupPath, currentModel, target)
          : modelPicker.buildButtons(currentModel, target, {
              contextChoice: agentChoice.available,
              routeChoice: routeChoiceFor(config, currentModel).available,
            });
      const groupLabel = action.kind === "openGroup" ? modelPicker.groupLabel(action.groupPath) : undefined;
      return {
        text: `Modèle par défaut de l'agent ${target}${groupLabel ? ` — ${groupLabel}` : ""} — actuel : ${modelPicker.labelFor(currentModel)}\n${formatContextInfo(config, currentModel, undefined, toolTypeOf(target))}`,
        buttons,
        answerText: groupLabel ?? "Retour",
      };
    }

    // Navigation re-render without touching the model (no selection yet).
    if (
      action.kind === "openGroup" ||
      action.kind === "back" ||
      action.kind === "openEffort" ||
      action.kind === "openContext" ||
      action.kind === "openRoute"
    ) {
      const existing = await sessionManager.peek(sessionId);
      const currentModel = chatModel(config, existing?.modelOverride);
      const effort = effectiveEffort(config.llm, currentModel, existing?.effortOverride);
      const suffix = modelPicker.effortHeaderSuffix(effort);
      if (action.kind === "openRoute") {
        const sort = action.sort ?? "price";
        const routes = sortRoutes(await routesFor(config, currentModel), sort);
        return {
          text: `Route — ${modelPicker.labelFor(currentModel)} — actuelle : ${routeChoiceFor(config, currentModel).current ?? "automatique"}`,
          buttons: modelPicker.buildRouteButtons(
            routes.map((route) => ({ tag: route.tag, label: routeLabel(route) })),
            routeChoiceFor(config, currentModel).current,
            undefined,
            sort,
          ),
          answerText: "Route",
        };
      }
      if (action.kind === "openGroup") {
        return {
          text: `${modelPicker.groupLabel(action.groupPath) ?? "Models"} — current: ${modelPicker.labelFor(currentModel)}${suffix}\n${formatContextInfo(config, currentModel, existing?.contextOverride)}`,
          buttons: modelPicker.buildGroupButtons(action.groupPath, currentModel),
          answerText: modelPicker.groupLabel(action.groupPath),
        };
      }
      // Effort submenu, reachable without re-selecting a model.
      if (action.kind === "openEffort") {
        return {
          text: `Effort — current: ${formatEffort(effort)}\n${formatContextInfo(config, currentModel, existing?.contextOverride)}`,
          buttons: modelPicker.buildEffortButtons(effort, { currentModelId: currentModel }),
          answerText: "Effort",
        };
      }
      const choice = contextChoiceFor(config, currentModel, existing?.contextOverride);
      if (action.kind === "openContext") {
        return {
          text: `Fenetre de contexte — ${modelPicker.labelFor(currentModel)}\n${formatContextInfo(config, currentModel, existing?.contextOverride)}`,
          buttons: modelPicker.buildContextButtons(choice.tiers),
          answerText: "Contexte",
        };
      }
      return {
        text: `Current model: ${modelPicker.labelFor(currentModel)}${suffix}\n${formatContextInfo(config, currentModel, existing?.contextOverride)}`,
        buttons: modelPicker.buildButtons(currentModel, undefined, {
          contextChoice: choice.available,
          routeChoice: routeChoiceFor(config, currentModel).available,
        }),
        answerText: "Back",
      };
    }

    // Terminal steps close the menu (text without keyboard).
    if (action.kind === "setEffort") {
      const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
      session.effortOverride = action.level;
      session.lastActiveAt = new Date().toISOString();
      await sessionManager.persist(sessionId);
      const model = chatModel(config, session.modelOverride);
      return chainContext(model, session.contextOverride, `Effort réglé sur ${action.level} — modèle : ${modelPicker.labelFor(model)}`, `Effort: ${action.level}`);
    }

    if (action.kind === "setRoute") {
      const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
      const pinned = referenceWithRoute(chatModel(config, session.modelOverride), action.endpoint);
      session.modelOverride = overrideForPick(config, { agent: "main" }, pinned, availabilityWorld());
      session.lastActiveAt = new Date().toISOString();
      await sessionManager.persist(sessionId);
      return {
        text: action.endpoint
          ? `Route épinglée : ${action.endpoint} — modèle : ${modelPicker.labelFor(withoutEndpoint(pinned))}`
          : `Routage automatique — modèle : ${modelPicker.labelFor(pinned)}`,
        answerText: action.endpoint ? `Route : ${action.endpoint}` : "Route automatique",
      };
    }

    if (action.kind === "setContext") {
      const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
      session.contextOverride = action.choice;
      session.lastActiveAt = new Date().toISOString();
      await sessionManager.persist(sessionId);
      return {
        text: `Fenetre de contexte de cette conversation :\n${formatContextInfo(config, chatModel(config, session.modelOverride), session.contextOverride)}`,
        answerText: "Contexte mis a jour",
      };
    }

    if (action.kind === "keepContext") {
      const existing = await sessionManager.peek(sessionId);
      return {
        text: `Fenetre de contexte inchangee :\n${formatContextInfo(config, chatModel(config, existing?.modelOverride), existing?.contextOverride)}`,
        answerText: "Contexte inchange",
      };
    }

    if (action.kind === "keepEffort") {
      const existing = await sessionManager.peek(sessionId);
      const model = chatModel(config, existing?.modelOverride);
      const effort = effectiveEffort(config.llm, model, existing?.effortOverride);
      return chainContext(model, existing?.contextOverride, `Modèle : ${modelPicker.labelFor(model)} — effort inchangé : ${formatEffort(effort)}`, "Effort conservé");
    }

    // Selecting a model chains into the effort choice so you can set it in one flow.
    // /effort also works as a standalone shortcut and the Effort > entry in the root menu
    // opens the effort submenu without re-selecting a model.
    const modelId = action.modelId;
    const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
    // Resolved against the model just picked, not the one being left: the chained step must show
    // the effort that will actually apply from here on.
    const effort = effectiveEffort(config.llm, modelId, session.effortOverride);
    session.modelOverride = modelId === defaultModel ? undefined : modelId;
    session.lastActiveAt = new Date().toISOString();
    await sessionManager.persist(sessionId);
    const label = modelPicker.labelFor(modelId);

    const levels = modelPicker.effortLevelsFor(modelId);
    if (effort.source !== "unsupported" && levels.length > 0) {
      return {
        text: `Model changed to ${label} — now choose reasoning effort. Current: ${formatEffort(effort)}`,
        buttons: modelPicker.buildEffortButtons(effort, { chained: true, currentModelId: modelId }),
        answerText: "Model updated",
      };
    }

    return chainContext(modelId, session.contextOverride, `Modèle changé pour ${label}`, "Modèle mis à jour");
  };
}
