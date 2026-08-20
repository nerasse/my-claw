import type { Tool, ToolResult } from "../tools/types.ts";
import { str, strOpt, bool } from "../tools/types.ts";
import { normalizeUntrusted } from "../agent/prompt/normalize-untrusted.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import { createJob, loadJobs, saveJobs, updateJob, removeJob, parseDeliver, computeNextRun } from "../cron/store.ts";
import type { CronOrigin } from "../cron/types.ts";
import type { CronScheduler } from "../cron/scheduler.ts";
import type { AgentScope } from "../core/config.ts";
import { hooks } from "../hooks/index.ts";

/**
 * The live catalogs a job can reference, injected so the tool never reaches into the registries
 * itself. The agent reads them through `list`: the output carries every name a job may pick, so
 * the model/workspace/skills/mcp/tools arguments never have to be guessed.
 */
export interface CronToolContext {
  models(): string[];
  defaultModel(): string;
  workspaces(): string[];
  skills(): string[];
  mcp(): string[];
  /** The tool names a cron run can use: the cron baseline narrowed like the app shows it. */
  cronTools(): string[];
  /** The cron agent's own scope: what a job with no override inherits. */
  cronAgentSkills(): AgentScope;
  cronAgentMcp(): AgentScope;
}

/** Parses a scope argument into the config shape. Absent means "don't touch"; "inherit" (or
 *  "default"/"unset"/blank) means "clear the field"; "all"/"*" is the wildcard; "none" is an
 *  explicit empty list; anything else is a comma-separated list of names. */
function parseScopeInput(input: string | undefined): { present: boolean; scope: string[] | undefined } {
  if (input === undefined) return { present: false, scope: undefined };
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "" || trimmed === "inherit" || trimmed === "default" || trimmed === "unset") {
    return { present: true, scope: undefined };
  }
  if (trimmed === "all" || trimmed === "*") return { present: true, scope: ["*"] };
  if (trimmed === "none") return { present: true, scope: [] };
  return {
    present: true,
    scope: input
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean),
  };
}

function scopeDisplay(scope: string[] | undefined, inheritedLabel = "inherit"): string {
  if (scope === undefined) return inheritedLabel;
  if (scope.includes("*")) return "all";
  return scope.length === 0 ? "none" : scope.join(", ");
}

function scopeAll(scope: AgentScope): boolean {
  return scope === "all";
}

export function createCronTool(scheduler: CronScheduler, context: CronToolContext): Tool {
  return {
    name: "cron",
    description: "Manage scheduled tasks. Actions: create, list, update, pause, resume, remove, trigger. A scheduled task runs automatically at the specified interval and its output is delivered to a chat. 'list' also reports the models, workspaces, skills, MCP servers and tools a job can use.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "update", "pause", "resume", "remove", "trigger"],
        },
        name: { type: "string", description: "Human-friendly label (create/update)" },
        prompt: { type: "string", description: "Task instruction for the agent (create/update)" },
        schedule: { type: "string", description: "Schedule: cron expr (e.g. '0 9 * * 1'), 'every Xm/h/d', ISO timestamp, or bare duration like '2h' (create/update)" },
        job_id: { type: "string", description: "Job ID (update/pause/resume/remove/trigger)" },
        deliver: { type: "string", description: "Delivery target: 'origin' (same chat as creation), 'local' (no delivery), or 'platform:chatId'. Default: origin (create/update)" },
        model: { type: "string", description: "Model override for this job; a model from the 'models' list of cron list (create/update)" },
        workspace: { type: "string", description: "Workspace key from config.workspaces the job runs in; absent = the default workspace. The key is validated against the config on the next run, and an unknown key pauses the job (create/update)" },
        skills: { type: "string", description: "Skills scope (create/update): 'inherit' (clear, the cron agent's list applies), 'all' or '*', 'none', or comma-separated names from the 'skills' list of cron list" },
        mcp: { type: "string", description: "MCP scope (create/update): 'inherit' (clear, the cron agent's list applies), 'all' or '*', 'none', or comma-separated server names from the 'mcp' list of cron list" },
        tools: { type: "string", description: "Tools scope (create/update): 'inherit' (clear, the cron agent's set applies), 'all' or '*', 'none', or comma-separated names from the 'tools' list of cron list. Names outside the cron baseline are dropped at run time" },
        reason: { type: "string", description: "Pause reason (pause)" },
        enabled: { type: "boolean", description: "Include disabled jobs in list (list)" },
      },
      required: ["action"],
    },
    async execute(args): Promise<ToolResult> {
      const action = str(args, "action");
      const jobs = await loadJobs();

      const msg = (args.__message as UnifiedMessage | undefined) ?? null;
      const origin: CronOrigin | null = msg && msg.platform === "my-claw-app"
        ? { platform: msg.platform, chatId: msg.chatId, threadId: msg.threadId }
        : null;

      switch (action) {
        case "create": {
          const rawPrompt = str(args, "prompt");
          if (!rawPrompt) return { success: false, output: "Missing 'prompt' for create." };
          // Stored normalised. Rejecting when normalisation changed the text would turn a stray
          // zero-width space into a refusal to schedule; see docs/untrusted-content.md.
          const prompt = normalizeUntrusted(rawPrompt, "cron-prompt");
          const schedule = str(args, "schedule");
          if (!schedule) return { success: false, output: "Missing 'schedule' for create." };

          const deliverInput = strOpt(args, "deliver") ?? "origin";
          if (deliverInput.toLowerCase() === "origin" && !origin) {
            return { success: false, output: "Cannot use 'origin' delivery without an origin chat. Specify a target: 'my-claw-app:owner'." };
          }

          const job = createJob({
            name: strOpt(args, "name"),
            prompt,
            schedule,
            origin,
            deliver: deliverInput,
            model: strOpt(args, "model"),
            workspace: strOpt(args, "workspace"),
            skills: parseScopeInput(strOpt(args, "skills")).scope,
            mcp: parseScopeInput(strOpt(args, "mcp")).scope,
            tools: parseScopeInput(strOpt(args, "tools")).scope,
          });
          jobs.push(job);
          await saveJobs(jobs);
          hooks.emit("cron:job:created", { jobId: job.id, jobName: job.name });
          const workspaceNote = job.workspace ? `\nWorkspace: ${job.workspace}` : "";
          return { success: true, output: `Scheduled task created.\nID: ${job.id}\nName: ${job.name}\nSchedule: ${job.schedule.display}\nNext run: ${job.nextRunAt ?? "none"}${workspaceNote}` };
        }

        case "list": {
          const includeDisabled = bool(args, "enabled", true);
          const visible = includeDisabled ? jobs : jobs.filter((j) => j.enabled);
          const modelIds = context.models();
          const workspaceKeys = context.workspaces();
          const skillNames = context.skills();
          const mcpNames = context.mcp();
          const toolNames = context.cronTools();

          const lines: string[] = [];
          if (visible.length === 0) {
            lines.push("No scheduled tasks.");
          }
          for (const j of visible) {
            const status = j.enabled ? j.state : "paused";
            const next = j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : "-";
            lines.push(`${j.id} | ${j.name} | ${j.schedule.display} | ${status} | next: ${next}`);
            lines.push(`  model: ${j.model ?? "default model"} | workspace: ${j.workspace ?? "default workspace"}`);
            lines.push(`  skills: ${scopeDisplay(j.skills)} | mcp: ${scopeDisplay(j.mcp)} | tools: ${scopeDisplay(j.tools)}`);
            const removed: string[] = [];
            if (j.model && !modelIds.includes(j.model)) removed.push(`${j.model} (model)`);
            if (j.workspace && !workspaceKeys.includes(j.workspace)) removed.push(`${j.workspace} (workspace)`);
            for (const name of j.skills ?? []) if (name !== "*" && !skillNames.includes(name)) removed.push(`${name} (skills)`);
            for (const name of j.mcp ?? []) if (name !== "*" && !mcpNames.includes(name)) removed.push(`${name} (mcp)`);
            for (const name of j.tools ?? []) if (name !== "*" && !toolNames.includes(name)) removed.push(`${name} (tools)`);
            if (removed.length > 0) lines.push(`  removed: ${removed.join(", ")}`);
          }

          lines.push("");
          lines.push(`Context — models: ${modelIds.join(", ") || "none"} (default: ${context.defaultModel()})`);
          lines.push(`Context — workspaces: ${workspaceKeys.join(", ") || "default only"}`);
          lines.push(`Context — skills: ${skillNames.join(", ") || "none"}`);
          lines.push(`Context — mcp: ${mcpNames.join(", ") || "none"}`);
          lines.push(`Context — tools: ${toolNames.join(", ") || "none"}`);
          const cronSkills = context.cronAgentSkills();
          const cronMcp = context.cronAgentMcp();
          const scopeOfAgent = (scope: AgentScope): string => (scopeAll(scope) ? "all" : (scope as string[]).join(", ") || "none");
          lines.push(`Cron agent scope: skills: ${scopeOfAgent(cronSkills)} | mcp: ${scopeOfAgent(cronMcp)} — a job with no override inherits it`);
          return { success: true, output: lines.join("\n") };
        }

        case "update": {
          const jobId = str(args, "job_id");
          if (!jobId) return { success: false, output: "Missing 'job_id' for update." };

          const rawPrompt = strOpt(args, "prompt");
          const prompt = rawPrompt ? normalizeUntrusted(rawPrompt, "cron-prompt") : undefined;

          const schedule = strOpt(args, "schedule");
          const deliver = strOpt(args, "deliver");
          if (deliver?.toLowerCase() === "origin") {
            const job = jobs.find((j) => j.id === jobId);
            if (!job?.origin) {
              return { success: false, output: "Cannot set deliver='origin' because the job has no origin chat." };
            }
          }

          const skills = parseScopeInput(strOpt(args, "skills"));
          const mcp = parseScopeInput(strOpt(args, "mcp"));
          const tools = parseScopeInput(strOpt(args, "tools"));
          // "inherit" means the field leaves the job, but updateJob reads undefined as "don't
          // touch": clearing has to happen before the update so the store's semantics stay.
          if (skills.present && skills.scope === undefined) {
            const target = jobs.find((j) => j.id === jobId);
            if (target) delete target.skills;
          }
          if (mcp.present && mcp.scope === undefined) {
            const target = jobs.find((j) => j.id === jobId);
            if (target) delete target.mcp;
          }
          if (tools.present && tools.scope === undefined) {
            const target = jobs.find((j) => j.id === jobId);
            if (target) delete target.tools;
          }

          const updated = updateJob(jobs, jobId, {
            name: strOpt(args, "name"),
            prompt,
            model: strOpt(args, "model"),
            schedule,
            deliver,
            workspace: strOpt(args, "workspace"),
            ...(skills.present && skills.scope !== undefined ? { skills: skills.scope } : {}),
            ...(mcp.present && mcp.scope !== undefined ? { mcp: mcp.scope } : {}),
            ...(tools.present && tools.scope !== undefined ? { tools: tools.scope } : {}),
          });
          if (!updated) return { success: false, output: `Job not found: ${jobId}` };
          await saveJobs(jobs);
          hooks.emit("cron:job:updated", { jobId: jobId });
          return { success: true, output: `Updated job ${jobId}. Next run: ${updated.nextRunAt ?? "none"}` };
        }

        case "pause": {
          const jobId = str(args, "job_id");
          if (!jobId) return { success: false, output: "Missing 'job_id' for pause." };
          const job = jobs.find((j) => j.id === jobId);
          if (!job) return { success: false, output: `Job not found: ${jobId}` };
          job.enabled = false;
          job.state = "paused";
          job.pausedReason = strOpt(args, "reason") ?? undefined;
          await saveJobs(jobs);
          hooks.emit("cron:job:paused", { jobId });
          return { success: true, output: `Paused job ${jobId}: ${job.name}` };
        }

        case "resume": {
          const jobId = str(args, "job_id");
          if (!jobId) return { success: false, output: "Missing 'job_id' for resume." };
          const job = jobs.find((j) => j.id === jobId);
          if (!job) return { success: false, output: `Job not found: ${jobId}` };
          job.enabled = true;
          job.state = "scheduled";
          job.pausedReason = undefined;
          job.nextRunAt = computeNextRun(job.schedule, job.lastRunAt ?? undefined);
          await saveJobs(jobs);
          hooks.emit("cron:job:resumed", { jobId });
          return { success: true, output: `Resumed job ${jobId}: ${job.name}. Next run: ${job.nextRunAt ?? "none"}` };
        }

        case "remove": {
          const jobId = str(args, "job_id");
          if (!jobId) return { success: false, output: "Missing 'job_id' for remove." };
          const removed = removeJob(jobs, jobId);
          if (!removed) return { success: false, output: `Job not found: ${jobId}` };
          await saveJobs(jobs);
          hooks.emit("cron:job:removed", { jobId });
          return { success: true, output: `Removed job ${jobId}.` };
        }

        case "trigger": {
          const jobId = str(args, "job_id");
          if (!jobId) return { success: false, output: "Missing 'job_id' for trigger." };
          const job = jobs.find((j) => j.id === jobId);
          if (!job) return { success: false, output: `Job not found: ${jobId}` };
          if (!job.enabled) {
            job.enabled = true;
            job.state = "scheduled";
          }
          job.nextRunAt = new Date().toISOString();
          await saveJobs(jobs);
          hooks.emit("cron:job:triggered", { jobId });
          void scheduler.tick();
          return { success: true, output: `Triggered job ${jobId}: ${job.name}. It will run on the next tick.` };
        }

        default:
          return { success: false, output: `Unknown action: ${action}. Use create, list, update, pause, resume, remove, trigger.` };
      }
    },
  };
}
