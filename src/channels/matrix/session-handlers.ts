import { handleStatusCommand } from "../status-command.ts";
import { join } from "node:path";
import type { ModelPricing } from "../../llm/pricing.ts";
import { readFile } from "node:fs/promises";
import { writeJsonFileAtomically } from "../../utils/atomic-write.ts";
import type { EffortLevel, MyClawConfig } from "../../core/config.ts";
import { resolveAgentLlm, tagNameOf } from "../../core/config.ts";
import { SessionManager } from "../../sessions/manager.ts";
import { effectiveEffort, type EffectiveEffort } from "../../llm/resolver.ts";
import { handleCompactCommand } from "../compact-command.ts";
import { chatModel } from "../../llm/chat-model.ts";
import { overrideForPick } from "../../llm/run-model.ts";
import { availabilityWorld } from "../../llm/world.ts";
import type { ApprovalDecision, ConfirmationButton, OutgoingMessage, ToolApprovalRequest } from "../types.ts";
import { ModelPicker, formatEffort, formatModelGroupSummary, parseEffortArg, type PickerTarget } from "../model-picker.ts";
import { SkillRegistry } from "../../skills/registry.ts";
import type { AgentRegistry } from "../../agents/registry.ts";
import { loadAllSkills } from "../../skills/loader.ts";
import { createMatrixApprovalStore, type PersistedPendingMatrixApproval } from "./approval-store.ts";
import { MATRIX_REACTION_BUTTON_EMOJIS } from "./actions.ts";
import { hooks } from "../../hooks/index.ts";
import { runRegistry } from "../../core/run-registry.ts";
import { handleAuthCommand } from "../auth-commands.ts";
import { handleConfigCommand } from "../config-commands.ts";
import { handleAgentModelCommand, applyAgentModel, applyAgentEffort, currentAgentModel, applyAgentContext, toolTypeOf } from "../agent-model-commands.ts";
import { handleSkillsCommand, handleAgentsCommand, handleMcpCommand, handleInstructionsCommand } from "../introspect-commands.ts";
import type { ToolRegistry } from "../../tools/registry.ts";
import type { McpServerStatus } from "../../mcp/manager.ts";
import type { SubAgentInfo } from "../../subagents/types.ts";
import { redactCommandArgs } from "../command-log.ts";
import { log } from "../../utils/logger.ts";
import { contextChoiceFor, formatContextInfo } from "../context-menu.ts";
import { referenceWithRoute, routeChoiceFor, routeLabel, routesFor } from "../route-menu.ts";
import { withoutEndpoint } from "../../llm/model-ref.ts";
import type { ContextOverride } from "../../llm/context-window.ts";

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
  // Breadcrumb the old menu message collapses to when the next step is sent as a new message.
  supersededText?: string;
}

export interface MatrixApprovalHandler {
  requestApproval: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
  cancelApproval: (id: string) => boolean;
  resolveAction: (ctx: MatrixActionContext) => Promise<MatrixActionResponse | undefined>;
  persistPendingApprovals: () => Promise<void>;
  restorePendingApprovals: () => Promise<void>;
}

interface MatrixSessionHandlerDeps {
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
  approvalHandler?: MatrixApprovalHandler;
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
  // Push an unsolicited message to a room/thread later (Codex device-code login completion).
  postMessage?: (roomId: string, text: string, threadId?: string) => Promise<void>;
  // Ensure the provider exists + re-run model discovery after a Codex/Claude auth change.
  onAuthChanged?: (provider: "codex" | "claude") => void | Promise<void>;
  // Apply a config restore through the normal reload path (a restored dotfile fires no fs.watch
  // event, so /config rollback cannot rely on the watcher noticing).
  reloadConfigNow?: () => Promise<{ changed: string[]; rebootRequired: string[] }>;
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

// Renders any menu level (root or group) from its button list. Reaction emojis / number replies
// map to button positions, so deriving the text from the buttons keeps them in sync per level.
function buildMatrixMenuFromButtons(params: {
  modelPicker: ModelPicker;
  currentModel: string;
  buttons: ConfirmationButton[];
  heading?: string;
  effort: EffectiveEffort;
  contextInfo?: string;
}): OutgoingMessage {
  const { buttons } = params;
  const instruction =
    buttons.length > MATRIX_REACTION_BUTTON_EMOJIS.length
      ? `Reply with a number/name for any option, react to this message for the first ${MATRIX_REACTION_BUTTON_EMOJIS.length}, or send \`/model <number|name>\`:`
      : "Reply with a number/name/letter, react to this message, or send `/model <number|name>`:";
  return {
    text: [
      ...(params.heading ? [params.heading, ""] : []),
      `Current model: ${params.modelPicker.labelFor(params.currentModel)}${params.modelPicker.effortHeaderSuffix(params.effort)}`,
      ...(params.contextInfo ? [params.contextInfo] : []),
      instruction,
      ...buttons.map((button, index) => `${MATRIX_REACTION_BUTTON_EMOJIS[index] ?? `${index + 1}.`} ${button.label}`),
    ].join("\n"),
    buttons,
  };
}

/**
 * Agent menu, rendered like the session one so the numbered replies and reactions keep working.
 * The effort line is left out: effort is a per-session choice and this menu writes config.
 */
function buildMatrixAgentModelMenu(params: {
  modelPicker: ModelPicker;
  outcome: { target: PickerTarget; currentModel: string; heading: string };
  contextInfo: string;
  contextChoice: boolean;
  routeChoice: boolean;
}): OutgoingMessage {
  const { modelPicker, outcome } = params;
  const buttons = modelPicker.buildButtons(outcome.currentModel, outcome.target, {
    contextChoice: params.contextChoice,
    routeChoice: params.routeChoice,
  });
  const instruction =
    buttons.length > MATRIX_REACTION_BUTTON_EMOJIS.length
      ? `Réponds avec un numéro/nom, réagis pour les ${MATRIX_REACTION_BUTTON_EMOJIS.length} premiers, ou envoie \`/model ${outcome.target} <nom>\` :`
      : `Réponds avec un numéro/nom, réagis à ce message, ou envoie \`/model ${outcome.target} <nom>\` :`;
  return {
    text: [
      outcome.heading,
      "",
      `Actuel : ${modelPicker.labelFor(outcome.currentModel)}`,
      params.contextInfo,
      instruction,
      ...buttons.map((button, index) => `${MATRIX_REACTION_BUTTON_EMOJIS[index] ?? `${index + 1}.`} ${button.label}`),
    ].join("\n"),
    buttons,
  };
}

function buildMatrixModelMenu(params: {
  config: MyClawConfig;
  modelPicker: ModelPicker;
  currentModel: string;
  effort: EffectiveEffort;
  heading?: string;
  contextInfo?: string;
}): OutgoingMessage | string {
  if (!params.modelPicker.hasModels()) {
    return `${params.heading ? `${params.heading}\n` : ""}Current model: ${params.modelPicker.labelFor(params.currentModel)}\n${params.contextInfo ?? ""}`.trim();
  }
  return buildMatrixMenuFromButtons({
    modelPicker: params.modelPicker,
    currentModel: params.currentModel,
    buttons: params.modelPicker.buildButtons(params.currentModel, undefined, {
      routeChoice: routeChoiceFor(params.config, params.currentModel).available,
    }),
    heading: params.heading,
    effort: params.effort,
    contextInfo: params.contextInfo,
  });
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
  effort: EffectiveEffort;
  contextInfo: string;
}): string {
  const header = `Current model: ${params.modelPicker.labelFor(params.currentModel)}${params.modelPicker.effortHeaderSuffix(params.effort)}\n${params.contextInfo}`;
  const models = params.config.llm.models ?? [];
  if (models.length === 0) {
    return header;
  }

  return [
    header,
    "Available models by group:",
    ...formatModelGroupSummary(models, params.currentModel),
    "",
    "Use `/model` to open the interactive menu, or `/model <name>` to switch.",
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
    // Atomic write: a restart may read this file while a fire-and-forget persist is still in
    // flight, and a plain writeFile could hand the reader a truncated JSON mid-write.
    await writeJsonFileAtomically(storagePath, snapshot, true);
  };

  const restore = async () => {
    if (!storagePath) return;
    const raw = await readFile(storagePath, "utf-8").catch(() => "[]");
    // A torn file (crash mid-write of a pre-atomic version) must not kill the boot path:
    // the approvals are lost, but the channel still comes up.
    let parsed: PersistedPendingMatrixApproval[];
    try {
      parsed = JSON.parse(raw) as PersistedPendingMatrixApproval[];
    } catch {
      parsed = [];
    }
    matrixApprovalStore.restore(parsed);
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
}: MatrixSessionHandlerDeps): (
  chatId: string,
  userId: string,
  chatType: MatrixChatType,
  command: string,
  args: string,
  meta?: { roomId?: string; threadId?: string },
  ) => Promise<OutgoingMessage | string | undefined> {
  const handler = async (chatId: string, userId: string, chatType: MatrixChatType, command: string, args: string, meta?: { roomId?: string; threadId?: string }): Promise<OutgoingMessage | string | undefined> => {
    const loggedArgs = redactCommandArgs(command, args);
    hooks.emit("command:received", { command, args: loggedArgs, platform: "matrix", userId });
    const sessionId = resolveMatrixSessionId({
      config,
      chatId,
      userId,
      chatType,
      roomId: meta?.roomId,
      threadId: meta?.threadId,
    });
    // Matrix commands were entirely absent from the logs, which is why a session recreation
    // could not be attributed to any command after the fact.
    void log("info", "command received", {
      platform: "matrix",
      command,
      args: loggedArgs,
      userId,
      chatId,
      chatType,
      sessionId,
    });

    switch (command) {
      case "new":
        await sessionManager.resetSession(sessionId, "matrix", chatType);
        return "New session started.";

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
          return buildMatrixAgentModelMenu({
            modelPicker,
            outcome: agentOutcome,
            contextInfo: formatContextInfo(config, agentOutcome.currentModel, undefined, toolTypeOf(agentOutcome.target)),
            contextChoice: contextChoiceFor(config, agentOutcome.currentModel, undefined, toolTypeOf(agentOutcome.target)).available,
            routeChoice: routeChoiceFor(config, agentOutcome.currentModel).available,
          });
        }

        const existingSession = await sessionManager.peek(sessionId);
        const currentModel = chatModel(config, existingSession?.modelOverride);

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
          const previousModel = chatModel(config, session.modelOverride);
          session.modelOverride = overrideForPick(config, { agent: "main" }, match.id, availabilityWorld());
          session.lastActiveAt = new Date().toISOString();
          await sessionManager.persist(sessionId);
          hooks.emit("session:model:changed", { sessionId, previousModel, newModel: match.id });
          return `Model changed to ${match.label}\n${formatContextInfo(config, match.id, session.contextOverride)}`;
        }

        return buildMatrixModelMenu({
          config,
          modelPicker,
          currentModel,
          effort: effectiveEffort(config.llm, currentModel, existingSession?.effortOverride),
          contextInfo: formatContextInfo(config, currentModel, existingSession?.contextOverride),
        });
      }

      case "models": {
        const existingSession = await sessionManager.peek(sessionId);
        const currentModel = chatModel(config, existingSession?.modelOverride);
        return buildMatrixModelsList({
          config,
          modelPicker,
          currentModel,
          effort: effectiveEffort(config.llm, currentModel, existingSession?.effortOverride),
          contextInfo: formatContextInfo(config, currentModel, existingSession?.contextOverride),
        });
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
          const session = await sessionManager.getOrCreateWithMeta(sessionId, "matrix", chatType);
          session.effortOverride = level;
          session.lastActiveAt = new Date().toISOString();
          await sessionManager.persist(sessionId);
          return `Effort set to ${level}`;
        }
        return buildMatrixMenuFromButtons({
          modelPicker,
          currentModel: activeModel,
          buttons: modelPicker.buildEffortButtons(effort, { currentModelId: activeModel }),
          effort,
          heading: `Effort — current: ${formatEffort(effort)}`,
          contextInfo: formatContextInfo(config, activeModel, existingSession?.contextOverride),
        });
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
        // Text channel: the summary would flood the room, so only the outcome line is sent.
        // The app renders it collapsed instead (docs/compaction.md).
        const outcome = await handleCompactCommand({
          config,
          session,
          instructions: args.trim() || undefined,
          sdkCompact,
          persist: () => sessionManager.persist(sessionId),
        });
        return outcome.text;
      }

      case "reload":
      case "reload-skills": {
        if (!skillRegistry || !builtinDir || !customDir || !workspaceSkillsDir) {
          return "Skill registry not available.";
        }
        const allSkills = await loadAllSkills({
          builtInDir: builtinDir,
          customDir: customDir,
          workspaceDir: workspaceSkillsDir,
          workspaces: Object.entries(config.workspaces ?? {}).map(([key, dir]) => ({ key, dir: join(dir, "skills") })),
        });
        skillRegistry.setAll(allSkills);
        hooks.emit("skills:reloaded", { count: allSkills.size });
        return `Skills reloaded. ${allSkills.size} skills available.`;
      }

      case "reload-agents": {
        if (!reloadAgents) return "Agent registry not available.";
        const count = await reloadAgents();
        return `Agents reloaded. ${count} agents available.`;
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

      case "help":
      case "commands":
        return undefined;

      case "stop":
        return runRegistry.stop(sessionId) ? "Stopped." : "Nothing running.";

      case "status": {
        return handleStatusCommand({
          config,
          sessionId,
          session: await sessionManager.peek(sessionId),
          liveRuns: runRegistry.list(sessionId),
          compacting: runRegistry.isCompacting(sessionId),
          pricing,
        });
      }

      case "codex":
      case "claude": {
        const roomId = meta?.roomId ?? chatId;
        return handleAuthCommand({
          provider: command,
          args,
          isDm: chatType === "dm",
          postFollowUp: (text) => { void postMessage?.(roomId, text, meta?.threadId); },
          onAuthChanged,
        });
      }

      case "config":
        return handleConfigCommand({
          args,
          isDm: chatType === "dm",
          workspaceDir: process.env["MY_CLAW_WORKSPACE"] ?? "",
          applyReload: reloadConfigNow,
        });

      // The four introspection commands share one body per channel (docs/agent-scoping.md).
      case "skills":
      case "agents":
      case "mcp":
      case "instructions": {
        if (!skillRegistry || !toolRegistry || !agentRegistry) {
          return "Introspection indisponible : les registres ne sont pas injectes.";
        }
        const params = {
          args,
          config,
          skillRegistry,
          agentRegistry,
          toolRegistry,
          // Absent means the host wired no MCP manager or sub-agent runner, which reads as "none"
          // rather than crashing a read-only command.
          mcpStatus: mcpStatus ?? (() => []),
          listSubAgents: listSubAgents ? () => listSubAgents(sessionId) : (async () => []),
          platform: "matrix",
        };
        if (command === "skills") return handleSkillsCommand(params);
        if (command === "agents") return handleAgentsCommand(params);
        if (command === "mcp") return handleMcpCommand(params);
        return handleInstructionsCommand(params);
      }

      default:
        return undefined;
    }
  };
  return async (chatId, userId, chatType, command, args, meta) => {
    const result = await handler(chatId, userId, chatType, command, args, meta);
    const responseText = typeof result === "string" ? result : typeof result === "object" && result?.text ? result.text : undefined;
    hooks.emit("command:handled", { command, platform: "matrix", response: responseText });
    // Matrix answers "Unknown command" for this case, so record what was actually typed.
    if (result === undefined) {
      void log("info", "command not recognized", { platform: "matrix", command, userId, chatId });
    }
    return result;
  };
}

export function createMatrixActionHandler({
  config,
  sessionManager,
  modelPicker,
  reloadConfigNow,
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

    const action = modelPicker.parseCallbackAction(data);
    if (!action) return undefined;

    if (action.kind === "stale") {
      return {
        text: "That menu is out of date (the model list changed). Send /model again.",
        answerText: "Menu out of date",
      };
    }

    const sessionId = resolveMatrixSessionId({
      config,
      chatId,
      userId,
      chatType,
      roomId: chatId,
      threadId,
    });
    const defaultModel = config.llm.defaultModel ?? config.llm.model ?? "";

    // An agent-targeted menu edits config, never this room. Handled before the session branches so
    // a target can never fall through into them and silently change the wrong thing.
    // The context step is chained after the effort one, so a single flow sets model, effort and
    // window. Terminal when this model has nothing to arbitrate: a lone option is not a choice.
    const chainContext = (model: string, override: ContextOverride | undefined, text: string) => {
      const choice = contextChoiceFor(config, model, override);
      if (!choice.available) return { text };
      const buttons = modelPicker.buildContextButtons(choice.tiers, { chained: true });
      return {
        text: [
          `${text}`,
          "",
          "Choisis maintenant la fenêtre de contexte :",
          ...buttons.map((button, index) => `${MATRIX_REACTION_BUTTON_EMOJIS[index] ?? `${index + 1}.`} ${button.label}`),
        ].join("\n"),
        buttons,
        supersededText: "Model menu > Context",
      };
    };

    if ("target" in action && action.target) {
      const target = action.target;
      const currentModel = currentAgentModel(config, target);
      const agentChoice = contextChoiceFor(config, currentModel, undefined, toolTypeOf(target));
      // The effort this agent would run with: its own pin, unless a tag speaks first. The config
      // view has no session, so the session never applies here.
      const agentEffort = () =>
        effectiveEffort(config.llm, currentModel, undefined, resolveAgentLlm(config, toolTypeOf(target))?.effort);
      if (action.kind === "select") {
        const text = await applyAgentModel(target, action.modelId, { config, modelPicker, reloadConfigNow });
        // The flow continues: model, then effort, then window, exactly like the session flow.
        // No effort step when the staged model is a tag: the tag's own pin would always win.
        const levels = modelPicker.effortLevelsFor(action.modelId);
        const effort = effectiveEffort(config.llm, action.modelId, undefined, resolveAgentLlm(config, toolTypeOf(target))?.effort);
        if (tagNameOf(action.modelId) === undefined && effort.source !== "unsupported" && levels.length > 0) {
          return {
            ...buildMatrixMenuFromButtons({
              modelPicker,
              currentModel: action.modelId,
              buttons: modelPicker.buildEffortButtons(effort, { chained: true, currentModelId: action.modelId, target }),
              effort,
              heading: `${text}\nChoisissez maintenant l'effort :`,
              contextInfo: formatContextInfo(config, action.modelId, undefined, toolTypeOf(target)),
            }),
            supersededText: `Agent ${target} > effort`,
          };
        }
        return { text };
      }
      if (action.kind === "setEffort") {
        const text = await applyAgentEffort(target, action.level, { config, reloadConfigNow });
        if (agentChoice.available) {
          return {
            ...buildMatrixMenuFromButtons({
              modelPicker,
              currentModel,
              buttons: modelPicker.buildContextButtons(agentChoice.tiers, { chained: true, target }),
              effort: agentEffort(),
              heading: `${text}\nChoisissez maintenant la fenêtre de contexte :`,
              contextInfo: formatContextInfo(config, currentModel, undefined, toolTypeOf(target)),
            }),
            supersededText: `Agent ${target} > contexte`,
          };
        }
        return { text };
      }
      if (action.kind === "keepEffort") {
        const effort = agentEffort();
        if (agentChoice.available) {
          return {
            ...buildMatrixMenuFromButtons({
              modelPicker,
              currentModel,
              buttons: modelPicker.buildContextButtons(agentChoice.tiers, { chained: true, target }),
              effort,
              heading: `Effort de l'agent ${target} inchangé : ${formatEffort(effort)}\nChoisissez maintenant la fenêtre de contexte :`,
              contextInfo: formatContextInfo(config, currentModel, undefined, toolTypeOf(target)),
            }),
            supersededText: `Agent ${target} > contexte`,
          };
        }
        return { text: `Effort de l'agent ${target} inchangé : ${formatEffort(effort)}` };
      }
      if (action.kind === "openEffort") {
        return {
          ...buildMatrixMenuFromButtons({
            modelPicker,
            currentModel,
            buttons: modelPicker.buildEffortButtons(agentEffort(), { currentModelId: currentModel, target }),
            effort: agentEffort(),
            heading: `Effort de l'agent ${target} — ${modelPicker.labelFor(currentModel)} — actuel : ${formatEffort(agentEffort())}`,
            contextInfo: formatContextInfo(config, currentModel, undefined, toolTypeOf(target)),
          }),
          supersededText: `Agent ${target} > effort`,
        };
      }
      if (action.kind === "openRoute") {
        const routes = await routesFor(config, currentModel);
        return {
          ...buildMatrixMenuFromButtons({
            modelPicker,
            currentModel,
            buttons: modelPicker.buildRouteButtons(
              routes.map((route) => ({ tag: route.tag, label: routeLabel(route) })),
              routeChoiceFor(config, currentModel).current,
              target,
            ),
            effort: agentEffort(),
            heading: `Route de l'agent ${target} — ${modelPicker.labelFor(currentModel)} — actuelle : ${routeChoiceFor(config, currentModel).current ?? "automatique"}`,
            contextInfo: formatContextInfo(config, currentModel, undefined, toolTypeOf(target)),
          }),
          supersededText: `Agent ${target} > route`,
        };
      }
      if (action.kind === "setRoute") {
        // The route rides inside the reference, so pinning one is the same config write as
        // picking a model: one field, one meaning (docs/model-identity.md).
        return {
          text: await applyAgentModel(target, referenceWithRoute(currentModel, action.endpoint), {
            config,
            modelPicker,
            reloadConfigNow,
          }),
        };
      }
      if (action.kind === "setContext") {
        return { text: await applyAgentContext(target, action.choice, { config, reloadConfigNow }) };
      }
      const groupLabel = action.kind === "openGroup" ? modelPicker.groupLabel(action.groupPath) : undefined;
      const buttons =
        action.kind === "openContext"
          ? modelPicker.buildContextButtons(agentChoice.tiers, { target })
          : action.kind === "openGroup"
            ? modelPicker.buildGroupButtons(action.groupPath, currentModel, target)
            : modelPicker.buildButtons(currentModel, target, {
                contextChoice: agentChoice.available,
                routeChoice: routeChoiceFor(config, currentModel).available,
              });
      return {
        text: [
          `Modèle par défaut de l'agent ${target}${groupLabel ? ` — ${groupLabel}` : ""}`,
          "",
          `Actuel : ${modelPicker.labelFor(currentModel)}`,
          formatContextInfo(config, currentModel, undefined, toolTypeOf(target)),
          "Réponds avec un numéro/nom ou réagis à ce message :",
          ...buttons.map((button, index) => `${MATRIX_REACTION_BUTTON_EMOJIS[index] ?? `${index + 1}.`} ${button.label}`),
        ].join("\n"),
        buttons,
        supersededText: groupLabel ? `Agent ${target} > ${groupLabel}` : `Agent ${target}`,
      };
    }

    // Navigation re-renders the target level; the adapter sends it as a NEW message with fresh
    // reactions and collapses the previous menu to the supersededText breadcrumb.
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
      if (action.kind === "openRoute") {
        const routes = await routesFor(config, currentModel);
        return {
          ...buildMatrixMenuFromButtons({
            modelPicker,
            currentModel,
            buttons: modelPicker.buildRouteButtons(
              routes.map((route) => ({ tag: route.tag, label: routeLabel(route) })),
              routeChoiceFor(config, currentModel).current,
            ),
            effort,
            heading: `Route — ${modelPicker.labelFor(currentModel)} — actuelle : ${routeChoiceFor(config, currentModel).current ?? "automatique"}`,
            contextInfo: formatContextInfo(config, currentModel, existing?.contextOverride),
          }),
          supersededText: "Model menu > Route",
        };
      }
      // Effort submenu, reachable without re-selecting a model.
      if (action.kind === "openEffort") {
        return {
          ...buildMatrixMenuFromButtons({
            modelPicker,
            currentModel,
            buttons: modelPicker.buildEffortButtons(effort, { currentModelId: currentModel }),
            effort,
            heading: `Effort — current: ${formatEffort(effort)}`,
            contextInfo: formatContextInfo(config, currentModel, existing?.contextOverride),
          }),
          supersededText: "Model menu > Effort",
        };
      }
      const choice = contextChoiceFor(config, currentModel, existing?.contextOverride);
      if (action.kind === "openContext") {
        return {
          ...buildMatrixMenuFromButtons({
            modelPicker,
            currentModel,
            buttons: modelPicker.buildContextButtons(choice.tiers),
            effort,
            heading: `Fenetre de contexte — ${modelPicker.labelFor(currentModel)}`,
            contextInfo: formatContextInfo(config, currentModel, existing?.contextOverride),
          }),
          supersededText: "Model menu > Context",
        };
      }
      const buttons =
        action.kind === "openGroup"
          ? modelPicker.buildGroupButtons(action.groupPath, currentModel)
          : modelPicker.buildButtons(currentModel, undefined, {
              contextChoice: choice.available,
              routeChoice: routeChoiceFor(config, currentModel).available,
            });
      const groupLabel = action.kind === "openGroup" ? modelPicker.groupLabel(action.groupPath) : undefined;
      return {
        ...buildMatrixMenuFromButtons({
          modelPicker,
          currentModel,
          buttons,
          heading: groupLabel,
          effort,
          contextInfo: formatContextInfo(config, currentModel, existing?.contextOverride),
        }),
        supersededText: groupLabel ? `Model menu > ${groupLabel}` : "Model menu",
      };
    }

    // Terminal steps: text-only responses edit the menu message in place and drop its reactions.
    if (action.kind === "setEffort") {
      const session = await sessionManager.getOrCreateWithMeta(sessionId, "matrix", chatType);
      session.effortOverride = action.level;
      session.lastActiveAt = new Date().toISOString();
      await sessionManager.persist(sessionId);
      const model = chatModel(config, session.modelOverride);
      return chainContext(model, session.contextOverride, `Effort réglé sur ${action.level} — modèle : ${modelPicker.labelFor(model)}`);
    }

    if (action.kind === "setRoute") {
      const session = await sessionManager.getOrCreateWithMeta(sessionId, "matrix", chatType);
      const pinned = referenceWithRoute(chatModel(config, session.modelOverride), action.endpoint);
      session.modelOverride = overrideForPick(config, { agent: "main" }, pinned, availabilityWorld());
      session.lastActiveAt = new Date().toISOString();
      await sessionManager.persist(sessionId);
      return {
        text: action.endpoint
          ? `Route épinglée : ${action.endpoint} — modèle : ${modelPicker.labelFor(withoutEndpoint(pinned))}`
          : `Routage automatique — modèle : ${modelPicker.labelFor(pinned)}`,
      };
    }

    if (action.kind === "setContext") {
      const session = await sessionManager.getOrCreateWithMeta(sessionId, "matrix", chatType);
      session.contextOverride = action.choice;
      session.lastActiveAt = new Date().toISOString();
      await sessionManager.persist(sessionId);
      return { text: `Fenetre de contexte de cette conversation :\n${formatContextInfo(config, chatModel(config, session.modelOverride), session.contextOverride)}` };
    }

    if (action.kind === "keepContext") {
      const existing = await sessionManager.peek(sessionId);
      return { text: `Fenetre de contexte inchangee :\n${formatContextInfo(config, chatModel(config, existing?.modelOverride), existing?.contextOverride)}` };
    }

    if (action.kind === "keepEffort") {
      const existing = await sessionManager.peek(sessionId);
      const model = chatModel(config, existing?.modelOverride);
      const effort = effectiveEffort(config.llm, model, existing?.effortOverride);
      return chainContext(model, existing?.contextOverride, `Modèle : ${modelPicker.labelFor(model)} — effort inchangé : ${formatEffort(effort)}`);
    }

    // Selecting a model chains into the effort choice so you can set it in one flow.
    // /effort also works as a standalone shortcut and the Effort > entry in the root menu
    // opens the effort submenu without re-selecting a model.
    const modelId = action.modelId;
    const session = await sessionManager.getOrCreateWithMeta(sessionId, "matrix", chatType);
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
        ...buildMatrixMenuFromButtons({
          modelPicker,
          currentModel: modelId,
          buttons: modelPicker.buildEffortButtons(effort, { chained: true, currentModelId: modelId }),
          effort,
          heading: `Model changed to ${label} — now choose reasoning effort:`,
          contextInfo: formatContextInfo(config, modelId, session.contextOverride),
        }),
        supersededText: `Model changed to ${label}`,
      };
    }

    return { text: `Model changed to ${label}` };
  };
}
