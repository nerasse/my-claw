import { join } from "node:path";
import type { ModelPricing } from "../llm/pricing.ts";
import type { MyClawConfig } from "../core/config.ts";
import type { SessionManager } from "../sessions/manager.ts";
import type { SessionData } from "../sessions/store.ts";
import type { CompactOutcome } from "../agent/backend.ts";
import type { OutgoingMessage } from "./types.ts";
import type { SkillRegistry } from "../skills/registry.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { McpServerStatus } from "../mcp/manager.ts";
import type { SubAgentInfo } from "../subagents/types.ts";
import { loadAllSkills } from "../skills/loader.ts";
import { handleConfigCommand } from "./config-commands.ts";
import { handleSkillsCommand, handleAgentsCommand, handleMcpCommand, handleInstructionsCommand } from "./introspect-commands.ts";
import { handleCompactCommand } from "./compact-command.ts";
import { handleStatusCommand } from "./status-command.ts";
import { runRegistry } from "../core/run-registry.ts";
import { hooks } from "../hooks/index.ts";

/**
 * Slash commands whose body is identical on every channel, down to the platform string.
 * A command that renders a menu, buttons or any channel-specific layout is deliberately absent:
 * it stays in its channel file. The point of this module is that a fix applied here lands on both
 * channels at once, which a duplicated `case` could not guarantee.
 */

/** Cron rows as the host exposes them, narrowed to what the listing prints. */
interface CronJobSummary {
  id: string;
  name: string;
  schedule: { display: string };
  enabled: boolean;
  state: string;
  nextRunAt: string | null;
}

export interface SharedSessionCommandContext {
  command: string;
  args: string;
  /** Channel name, forwarded verbatim to the session store and to the introspection dumps. */
  platform: string;
  chatType: "dm" | "group";
  sessionId: string;
  config: MyClawConfig;
  sessionManager: SessionManager;
  skillRegistry?: SkillRegistry;
  agentRegistry?: AgentRegistry;
  toolRegistry?: ToolRegistry;
  mcpStatus?: () => McpServerStatus[];
  listSubAgents?: (sessionId: string) => Promise<SubAgentInfo[]>;
  builtinDir?: string;
  customDir?: string;
  workspaceSkillsDir?: string;
  /** Rescan of `agents/`, injected rather than rebuilt from dirs here. */
  reloadAgents?: () => Promise<number>;
  listCronJobs?: () => Promise<CronJobSummary[]>;
  // Price table for /status cost reporting. Optional: without it /status reports tokens only.
  pricing?: ModelPricing;
  // Apply a config restore through the normal reload path (a restored dotfile fires no fs.watch
  // event, so /config rollback cannot rely on the watcher noticing).
  reloadConfigNow?: () => Promise<{ changed: string[]; rebootRequired: string[] }>;
}

/**
 * Runs `command` if it is one of the shared ones.
 *
 * `undefined` means "not a shared command": the caller must fall through to its own switch. No
 * shared command ever answers `undefined` itself, so the two meanings cannot collide.
 */
export async function handleSharedSessionCommand(
  ctx: SharedSessionCommandContext,
): Promise<OutgoingMessage | string | undefined> {
  const { command, args, platform, chatType, sessionId, config, sessionManager } = ctx;

  switch (command) {
    case "new":
      await sessionManager.resetSession(sessionId, platform, chatType);
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

    case "verbose": {
      const session = await sessionManager.getOrCreateWithMeta(sessionId, platform, chatType);
      session.verbose = session.verbose === false ? undefined : false;
      session.lastActiveAt = new Date().toISOString();
      await sessionManager.persist(sessionId);
      return `Verbose mode: ${session.verbose === false ? "OFF" : "ON"}`;
    }

    case "compact": {
      const session = await sessionManager.getOrCreateWithMeta(sessionId, platform, chatType);
      // Text channel: the summary would flood the room, so only the outcome line is sent.
      // The app renders it collapsed instead (docs/compaction.md).
      const outcome = await handleCompactCommand({
        config,
        session,
        instructions: args.trim() || undefined,
        persist: () => sessionManager.persist(sessionId),
      });
      return outcome.text;
    }

    case "reload": {
      if (!ctx.skillRegistry || !ctx.builtinDir || !ctx.customDir || !ctx.workspaceSkillsDir) {
        return "Skill registry not available.";
      }
      const allSkills = await loadAllSkills({
        builtInDir: ctx.builtinDir,
        customDir: ctx.customDir,
        workspaceDir: ctx.workspaceSkillsDir,
        workspaces: Object.entries(config.workspaces ?? {}).map(([key, dir]) => ({ key, dir: join(dir, "skills") })),
      });
      ctx.skillRegistry.setAll(allSkills);
      hooks.emit("skills:reloaded", { count: allSkills.size });
      return `Skills reloaded. ${allSkills.size} skills available.`;
    }

    case "reload-agents": {
      if (!ctx.reloadAgents) return "Agent registry not available.";
      const count = await ctx.reloadAgents();
      return `Agents reloaded. ${count} agents available.`;
    }

    case "cron": {
      if (!ctx.listCronJobs) return "Cron not available.";
      const jobs = await ctx.listCronJobs();
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
      return handleStatusCommand({
        config,
        sessionId,
        session: await sessionManager.peek(sessionId),
        liveRuns: runRegistry.list(sessionId),
        compacting: runRegistry.isCompacting(sessionId),
        pricing: ctx.pricing,
      });
    }

    case "config":
      return handleConfigCommand({
        args,
        isDm: chatType === "dm",
        workspaceDir: process.env["MY_CLAW_WORKSPACE"] ?? "",
        applyReload: ctx.reloadConfigNow,
      });

    // The four introspection commands share one body (docs/agent-scoping.md).
    case "skills":
    case "agents":
    case "mcp":
    case "instructions": {
      if (!ctx.skillRegistry || !ctx.toolRegistry || !ctx.agentRegistry) {
        return "Introspection indisponible : les registres ne sont pas injectes.";
      }
      const listSubAgents = ctx.listSubAgents;
      const params = {
        args,
        config,
        skillRegistry: ctx.skillRegistry,
        agentRegistry: ctx.agentRegistry,
        toolRegistry: ctx.toolRegistry,
        // Absent means the host wired no MCP manager or sub-agent runner, which reads as "none"
        // rather than crashing a read-only command.
        mcpStatus: ctx.mcpStatus ?? (() => []),
        listSubAgents: listSubAgents ? () => listSubAgents(sessionId) : (async () => []),
        platform,
      };
      if (command === "skills") return handleSkillsCommand(params);
      if (command === "agents") return handleAgentsCommand(params);
      if (command === "mcp") return handleMcpCommand(params);
      return handleInstructionsCommand(params);
    }

    default:
      return undefined;
  }
}
