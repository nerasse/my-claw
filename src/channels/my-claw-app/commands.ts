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
import { handleConfigCommand } from "../config-commands.ts";
import { handleSkillsCommand, handleAgentsCommand, handleMcpCommand, handleInstructionsCommand } from "../introspect-commands.ts";
import { handleAgentModelCommand } from "../agent-model-commands.ts";
import { handleStatusCommand, statusReport } from "../status-command.ts";
import { formatModelGroupSummary } from "../model-picker.ts";
import { getHelpText } from "../commands-catalog.ts";
import { effectiveEffort } from "../../llm/resolver.ts";
import { handleCompactCommand } from "../compact-command.ts";
import { chatModel } from "../../llm/chat-model.ts";
import { parseEffortArg, formatEffort } from "../model-picker.ts";
import { runRegistry } from "../../core/run-registry.ts";
import { loadJobs } from "../../cron/store.ts";
import { hooks } from "../../hooks/index.ts";
import { log } from "../../utils/logger.ts";
import type { MyClawAppCommandHandler } from "./adapter.ts";

/**
 * Text slash commands for the my-claw-app channel, mirroring the telegram and matrix handlers:
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
  sdkCompact?: (session: SessionData, stopSignal?: AbortSignal) => Promise<string>;
  postMessage?: (owner: string, text: string, threadId?: string) => Promise<void>;
  onAuthChanged?: (provider: "codex" | "claude") => void | Promise<void>;
  reloadConfigNow?: () => Promise<{ changed: string[]; rebootRequired: string[] }>;
  toolRegistry?: ToolRegistry;
  mcpStatus?: () => import("../../mcp/manager.ts").McpServerStatus[];
  listSubAgents?: (sessionId: string) => Promise<import("../../subagents/types.ts").SubAgentInfo[]>;
  pricing?: import("../../llm/pricing.ts").ModelPricing;
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
    hooks.emit("command:received", { command, args, platform: "my-claw-app", userId: owner });
    void log("info", "command received", { platform: "my-claw-app", command, args, sessionId });

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
        return handleCompactCommand({
          config: deps.config,
          session,
          instructions: args.trim() || undefined,
          sdkCompact: deps.sdkCompact,
          persist: () => deps.sessionManager.persist(sessionId),
        });
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
        return statusReport({
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

      case "new":
        await deps.sessionManager.resetSession(sessionId, "my-claw-app", "dm");
        return "New session started.";

      default:
        return undefined;
    }
  };
}
