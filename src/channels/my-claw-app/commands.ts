import type { MyClawConfig } from "../../core/config.ts";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionManager } from "../../sessions/manager.ts";
import type { SessionData } from "../../sessions/store.ts";
import type { OutgoingMessage } from "../types.ts";
import { loadAllSkills } from "../../skills/loader.ts";
import type { SkillRegistry } from "../../skills/registry.ts";
import type { AgentRegistry } from "../../agents/registry.ts";
import type { ToolRegistry } from "../../tools/registry.ts";
import type { ModelPicker } from "../model-picker.ts";
import { handleAuthCommand } from "../auth-commands.ts";
import { redactCommandArgs } from "../command-log.ts";
import { handleConfigCommand } from "../config-commands.ts";
import { handleSkillsCommand, handleAgentsCommand, handleMcpCommand, handleInstructionsCommand } from "../introspect-commands.ts";
import { handleAgentModelCommand } from "../agent-model-commands.ts";
import { handleStatusCommand, statusReport } from "../status-command.ts";
import { formatModelGroupSummary } from "../model-picker.ts";
import { formatContextInfo, contextChoiceFor } from "../context-menu.ts";
import { getHelpText } from "../commands-catalog.ts";
import { effectiveEffort } from "../../llm/resolver.ts";
import { handleCompactCommand } from "../compact-command.ts";
import { chatModel } from "../../llm/chat-model.ts";
import type { ContextOverride } from "../../llm/context-window.ts";
import { parseEffortArg, formatEffort } from "../model-picker.ts";
import { runRegistry } from "../../core/run-registry.ts";
import { loadJobs } from "../../cron/store.ts";
import { hooks } from "../../hooks/index.ts";
import { log } from "../../utils/logger.ts";
import type { UndoMode } from "./undo.ts";
import type { MyClawAppCommandHandler } from "./controllers.ts";
import {
  handleRetryCommand,
  handleBranchesCommand,
  handleForkCommand,
  handleUndoCommand,
  handleRedoCommand,
} from "../branch-commands.ts";

/**
 * Text slash commands for the my-claw-app channel:
 * the command runs on the server, and only its output travels back. The interactive model menu
 * is not reachable from here -- the app has real `model.*` frames for that -- so every branch
 * returns plain text.
 */
export interface MyClawAppCommandDeps {
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
  listCronJobs?: () => ReturnType<typeof loadJobs>;
  postMessage?: (owner: string, text: string, threadId?: string) => Promise<void>;
  onAuthChanged?: (provider: "codex" | "claude") => void | Promise<void>;
  reloadConfigNow?: () => Promise<{ changed: string[]; rebootRequired: string[] }>;
  toolRegistry?: ToolRegistry;
  mcpStatus?: () => import("../../mcp/manager.ts").McpServerStatus[];
  listSubAgents?: (sessionId: string) => Promise<import("../../subagents/types.ts").SubAgentInfo[]>;
  pricing?: import("../../llm/pricing.ts").ModelPricing;
  /**
   * `/undo` without an argument asks the owner which mode via the app sheet. The adapter wires
   * it: it broadcasts `undo.prompt` and awaits `undo.choose`. Absent on a surface that cannot
   * show a sheet (then `/undo` defaults to soft).
   */
  undoPrompt?: (input: {
    sessionId: string;
    owner: string;
    threadId: string;
    diff: Array<{ root: string; additions: number; deletions: number }>;
    turnPreview: string;
  }) => Promise<UndoMode | null>;
}

/**
 * `/instructions` answers with the prompt dump as a file attachment, which the other two channels
 * upload. A command result on this channel is plain text, so the dump goes inline and the temp
 * file the helper wrote is removed here: stringifying the message object sent "[object Object]"
 * to the device and leaked the file on every call. Inlining is safe here and not on the others:
 * a frame carries the whole text, where their splitter would cut 14 KB inside a code fence.
 */
export async function instructionsText(result: OutgoingMessage | string): Promise<string> {
  if (typeof result === "string") return result;
  const dump = result.attachments?.[0]?.path;
  if (!dump) return result.text;
  const prompt = await readFile(dump, "utf-8").catch(() => "");
  await rm(dirname(dump), { recursive: true, force: true }).catch(() => {});
  return prompt ? `${result.text}\n\n---\n\n${prompt}` : result.text;
}

export function createMyClawAppCommandHandler(deps: MyClawAppCommandDeps): MyClawAppCommandHandler {
  const sessionIdFor = (owner: string, threadId: string): string =>
    SessionManager.resolveSessionId("my-claw-app", "dm", owner, owner, {
      threadId,
      sessionScope: "per-user",
    });

  return async (owner, threadId, command, args) => {
    const sessionId = sessionIdFor(owner, threadId);
    const defaultModel = deps.config.llm.defaultModel ?? deps.config.llm.model ?? "";
    // Masked before either of these, not after: `/claude set-token <token>` is a live credential
    // and this pair used to put it verbatim in orchestrator-<date>.log (kept 30 days, readable
    // through `logs.tail` and through the agent's own shell) and hand it to every plugin on the
    // hook. The session journal was already masking it, which is what made the gap easy to miss.
    const loggedArgs = redactCommandArgs(command, args);
    hooks.emit("command:received", { command, args: loggedArgs, platform: "my-claw-app", userId: owner });
    void log("info", "command received", { platform: "my-claw-app", command, args: loggedArgs, sessionId });

    const existing = await deps.sessionManager.peek(sessionId);
    const currentModel = chatModel(deps.config, existing?.modelOverride);

    switch (command) {
      case "help":
        return getHelpText("my-claw-app");

      case "model": {
        // An agent name as the first word edits that agent's persisted default (config.json),
        // exactly as on the other channels. The app has no button menus, so the menu outcome
        // becomes a text answer pointing at the typed form.
        const agentOutcome = await handleAgentModelCommand(args, {
          config: deps.config,
          modelPicker: deps.modelPicker,
          listSubAgents: deps.listSubAgents ? () => deps.listSubAgents!(sessionId) : (async () => []),
          listAgents: () => deps.agentRegistry?.names() ?? [],
          reloadConfigNow: deps.reloadConfigNow,
          isDm: true,
        });
        if (agentOutcome.kind === "message") return agentOutcome.text;
        if (agentOutcome.kind === "menu") {
          return `${agentOutcome.heading} — actuel : ${deps.modelPicker.labelFor(agentOutcome.currentModel)}\nUtilise /model <agent> <modèle> pour le changer.`;
        }
        // not-an-agent: the plain `/model <name>` session override below.
        if (!args) {
          const effort = effectiveEffort(deps.config.llm, currentModel, existing?.effortOverride);
          return `Current model: ${deps.modelPicker.labelFor(currentModel)}${deps.modelPicker.effortHeaderSuffix(effort)}\nUse the model menu in the app to switch.`;
        }
        const match = deps.modelPicker.find(args);
        if (!match) return `Unknown model: ${args}`;
        const session =
          existing ?? (await deps.sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm"));
        session.modelOverride = match.id === defaultModel ? undefined : match.id;
        session.lastActiveAt = new Date().toISOString();
        await deps.sessionManager.persist(sessionId);
        hooks.emit("session:model:changed", { sessionId, previousModel: currentModel, newModel: match.id });
        return `Model changed to ${deps.modelPicker.labelFor(match.id)}`;
      }

      case "models": {
        const effort = effectiveEffort(deps.config.llm, currentModel, existing?.effortOverride);
        const models = deps.config.llm.models ?? [];
        if (models.length === 0) {
          return `Current model: ${deps.modelPicker.labelFor(currentModel)}${deps.modelPicker.effortHeaderSuffix(effort)}\nNo models discovered yet.`;
        }
        return [
          `Current model: ${deps.modelPicker.labelFor(currentModel)}${deps.modelPicker.effortHeaderSuffix(effort)}`,
          "Available models by group:",
          ...formatModelGroupSummary(models, currentModel),
          "",
          "Use the model menu in the app, or /model <name> to switch.",
        ].join("\n");
      }

      case "effort": {
        const effort = effectiveEffort(deps.config.llm, currentModel, existing?.effortOverride);
        const levels = deps.modelPicker.effortLevelsFor(currentModel);
        if (effort.source === "unsupported" || levels.length === 0) {
          return `Effort has no effect on ${deps.modelPicker.labelFor(currentModel)}.`;
        }
        if (args) {
          // Same normalisation as the other channels: /effort HIGH is high, not a rejection.
          // The words default/inherit/reset are the deliberate clear: the session hands its
          // effort back to the tag pin or the scope's default, like "default (inherit)" in the
          // picker. The frame `model.effort.set` clears with an empty level instead.
          if (["default", "inherit", "reset"].includes(args.trim().toLowerCase())) {
            const session =
              existing ?? (await deps.sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm"));
            delete session.effortOverride;
            session.lastActiveAt = new Date().toISOString();
            await deps.sessionManager.persist(sessionId);
            return `Effort reset to default.`;
          }
          const level = parseEffortArg(args, levels);
          if (!level) return `Unknown effort: ${args}. Options: ${levels.join(", ")}.`;
          const session =
            existing ?? (await deps.sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm"));
          session.effortOverride = level;
          session.lastActiveAt = new Date().toISOString();
          await deps.sessionManager.persist(sessionId);
          return `Effort set to ${level}`;
        }
        return `Effort — current: ${formatEffort(effort)}. Options: ${levels.join(", ")}.`;
      }

      case "cap": {
        // The conversation's window: the model's own, or a ceiling this chat picked.
        // /cap full hands it back to the model's window; /cap <n> lowers it.
        if (!args) {
          return `${formatContextInfo(deps.config, currentModel, existing?.contextOverride)}\nOptions: full (model window), ${[512_000, 256_000, 128_000, 64_000].join(", ")} tokens.`;
        }
        const normalized = args.trim().toLowerCase();
        let choice: ContextOverride;
        if (normalized === "full") {
          choice = "full";
        } else {
          const tokens = Number(args.trim());
          if (!Number.isInteger(tokens) || tokens <= 0) {
            return `Unknown cap: ${args}. Use full or a positive token count.`;
          }
          choice = tokens;
        }
        const session =
          existing ?? (await deps.sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm"));
        // Same clamp as the picker: a conversation may lower the window, never lift it above
        // what the model can hold.
        const raw = contextChoiceFor(deps.config, currentModel, undefined).raw;
        session.contextOverride = choice === "full" ? "full" : Math.min(choice, raw);
        session.lastActiveAt = new Date().toISOString();
        await deps.sessionManager.persist(sessionId);
        return `Cap set to ${session.contextOverride} tokens` + (session.contextOverride === "full" ? " (model window)" : "");
      }

      case "verbose": {
        const session =
          existing ?? (await deps.sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm"));
        session.verbose = session.verbose === false ? undefined : false;
        session.lastActiveAt = new Date().toISOString();
        await deps.sessionManager.persist(sessionId);
        return `Verbose mode: ${session.verbose === false ? "OFF" : "ON"}`;
      }

      case "compact": {
        const session =
          existing ?? (await deps.sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm"));
        const outcome = await handleCompactCommand({
          config: deps.config,
          session,
          instructions: args.trim() || undefined,
          persist: () => deps.sessionManager.persist(sessionId),
          threadId,
        });
        // A successful compaction answers with nothing: the boundary rule the hook just drew is
        // the whole report, and it is already in the history. A result bubble here would repeat
        // it -- the same summary stored twice, side by side, once folded under the rule and once
        // under the bubble. A failure has no rule to speak for it, so it still answers.
        return outcome.ok ? undefined : outcome.text;
      }

      case "reload": {
        if (!deps.skillRegistry || !deps.builtinDir || !deps.customDir || !deps.workspaceSkillsDir) {
          return "Skill registry not available.";
        }
        const allSkills = await loadAllSkills({
          builtInDir: deps.builtinDir,
          customDir: deps.customDir,
          workspaceDir: deps.workspaceSkillsDir,
          workspaces: Object.entries(deps.config.workspaces ?? {}).map(([key, dir]) => ({ key, dir: join(dir, "skills") })),
        });
        deps.skillRegistry.setAll(allSkills);
        hooks.emit("skills:reloaded", { count: allSkills.size });
        return `Skills reloaded. ${allSkills.size} skills available.`;
      }

      case "reload-agents": {
        if (!deps.reloadAgents) return "Agent registry not available.";
        const count = await deps.reloadAgents();
        return `Agents reloaded. ${count} agents available.`;
      }

      case "cron": {
        if (!deps.listCronJobs) return "Cron not available.";
        const jobs = await deps.listCronJobs();
        if (jobs.length === 0) return "No scheduled tasks.";
        return jobs
          .map((j) => `${j.id} | ${j.name} | ${j.schedule.display} | ${j.enabled ? j.state : "paused"} | next: ${j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : "-"}`)
          .join("\n");
      }

      case "stop":
        return runRegistry.stop(sessionId) ? "Stopped." : "Nothing running.";

      case "status":
        return await statusReport({
          config: deps.config,
          sessionId,
          session: existing,
          liveRuns: runRegistry.list(sessionId),
          compacting: runRegistry.isCompacting(sessionId),
          pricing: deps.pricing,
        });

      case "codex":
      case "claude":
        return handleAuthCommand({
          provider: command,
          args,
          isDm: true,
          postFollowUp: (text) => void deps.postMessage?.(owner, text, threadId),
          onAuthChanged: deps.onAuthChanged,
        });

      case "config":
        return handleConfigCommand({
          args,
          isDm: true,
          workspaceDir: process.env["MY_CLAW_WORKSPACE"] ?? "",
          applyReload: deps.reloadConfigNow,
        });

      case "skills":
      case "agents":
      case "mcp":
      case "instructions": {
        if (!deps.skillRegistry || !deps.toolRegistry || !deps.agentRegistry) {
          return "Introspection unavailable: registries not injected.";
        }
        const params = {
          args,
          config: deps.config,
          skillRegistry: deps.skillRegistry,
          agentRegistry: deps.agentRegistry,
          toolRegistry: deps.toolRegistry,
          mcpStatus: deps.mcpStatus ?? (() => []),
          listSubAgents: deps.listSubAgents ? () => deps.listSubAgents!(sessionId) : (async () => []),
          platform: "my-claw-app",
        };
        if (command === "skills") return handleSkillsCommand(params);
        if (command === "agents") return handleAgentsCommand(params);
        if (command === "mcp") return handleMcpCommand(params);
        return instructionsText(await handleInstructionsCommand(params));
      }

      case "branches":
      case "retry":
      case "fork":
      case "undo":
      case "redo": {
        const sessionLog = await deps.sessionManager.logOf(sessionId);
        const session =
          existing ?? (await deps.sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm"));
        const ctx = {
          sessionManager: deps.sessionManager,
          sessionId,
          session,
          log: sessionLog,
          owner,
          threadId,
          isRunning: () => runRegistry.isRunning(sessionId),
          isCompacting: () => runRegistry.isCompacting(sessionId),
          abortRun: async () => {
            runRegistry.stop(sessionId);
            // A compaction releases its hold once the summarizer has answered the abort: waiting
            // on the hold is exact. A run has no such promise, so it gets a moment for its tools
            // to acknowledge the signal.
            await runRegistry.waitForCompaction(sessionId);
            await new Promise((r) => setTimeout(r, 50));
          },
          persist: async () => {
            session.lastActiveAt = new Date().toISOString();
            await deps.sessionManager.persist(sessionId);
          },
          resolveNewSessionId: (newThreadId: string) => sessionIdFor(owner, newThreadId),
          ...(deps.undoPrompt ? { undoPrompt: deps.undoPrompt } : {}),
        };
        if (command === "branches") {
          const result = await handleBranchesCommand(ctx, args);
          return result.reset ? { text: result.text, reset: result.reset } : result.text;
        }
        if (command === "retry") {
          const result = await handleRetryCommand(ctx, args);
          return result.reset
            ? { text: result.text, reset: result.reset, compose: result.compose }
            : result.text;
        }
        if (command === "undo") {
          // /undo [soft|hard] executes directly. /undo without an argument asks the app:
          // it needs the workspace and the diff, both supplied by this handler. The ask is
          // injected only when the caller (index.ts) wired the prompt handler.
          const result = await handleUndoCommand(ctx, args);
          return result.reset
            ? { text: result.text, reset: result.reset, compose: result.compose }
            : result.text;
        }
        if (command === "redo") {
          const result = await handleRedoCommand(ctx, args);
          return result.reset ? { text: result.text, reset: result.reset } : result.text;
        }
        // fork
        const result = await handleForkCommand(ctx, args);
        return result.newThreadId
          ? { text: result.text, newThreadId: result.newThreadId }
          : result.text;
      }

      default:
        return undefined;
    }
  };
}
