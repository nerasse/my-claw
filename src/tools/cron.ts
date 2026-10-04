import type { Tool, ToolResult } from "../tools/types.ts";
import { str, strOpt, bool, boolOpt } from "../tools/types.ts";
import { normalizeUntrusted } from "../agent/prompt/normalize-untrusted.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import {
  createJob,
  loadJobs,
  mutateJobs,
  updateJob,
  removeJob,
  computeNextRun,
  parseJobTimeout,
} from "../cron/store.ts";
import type { CronDeliver, CronJob, CronOrigin } from "../cron/types.ts";
import { DEFAULT_ALERT_AFTER_MS, type CronScheduler } from "../cron/scheduler.ts";
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
  /** The install-wide limit a job without its own inherits (`cron.timeoutMs`); none when unset. */
  defaultTimeoutMs?(): number | undefined;
  /** When a run still going is first announced, for a job without its own (`cron.alertAfter`). */
  defaultAlertAfterMs?(): number;
  /**
   * The owner's conversation with this title, created in the workspace when there is none: the
   * target of `deliver: "thread:<title>"`. Returns its thread id.
   */
  ensureThread?(owner: string, title: string, workspace?: string): Promise<string>;
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

function deliverDisplay(deliver: CronDeliver): string {
  if (deliver === "local" || deliver === "origin") return deliver;
  return deliver.threadId ? `${deliver.platform}:${deliver.chatId}:${deliver.threadId}` : `${deliver.platform}:${deliver.chatId}`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

const CONVERSATIONS_TOOL = "conversation_search";

/**
 * A job as the agent should check it: every setting the run will use, then the last run and the
 * next one. `create` and `update` answer with it too, so what was stored is read back without
 * opening jobs.json.
 */
function describeJob(job: CronJob, scheduler: CronScheduler, context: CronToolContext): string[] {
  const status = job.enabled ? job.state : "paused";
  const installWall = context.defaultTimeoutMs?.();
  const timeout = job.timeoutMs
    ? `${span(job.timeoutMs)} (job)`
    : installWall !== undefined ? `${span(installWall)} (cron.timeoutMs)` : "none";
  const alert = job.alertAfterMs
    ? `${span(job.alertAfterMs)} (job)`
    : span(context.defaultAlertAfterMs?.() ?? DEFAULT_ALERT_AFTER_MS);
  const conversations = job.conversations === true || (job.tools ?? []).includes(CONVERSATIONS_TOOL);
  const lines = [
    `${job.id} | ${job.name} | ${job.schedule.display} | ${status}${job.pausedReason ? ` (${job.pausedReason})` : ""} | next: ${when(job.nextRunAt)}`,
    `  model: ${job.model ?? "default model"}${job.effort ? ` (effort ${job.effort})` : ""} | workspace: ${job.workspace ?? "default workspace"} | deliver: ${deliverDisplay(job.deliver)} | alert: ${alert} | timeout: ${timeout}`,
    `  skills: ${scopeDisplay(job.skills)} | mcp: ${scopeDisplay(job.mcp)} | tools: ${scopeDisplay(job.tools)}`,
    `  sub-agents: ${job.subagents === false ? "off" : "on"} | browser: ${job.browser === false ? "off" : "on"} | conversations: ${conversations ? "on" : "off"} | notify: ${job.silent ? "silent" : "on"}`,
  ];
  const running = scheduler.runningOf(job.id);
  if (running) {
    lines.push(`  running since ${when(new Date(running.startedAt).toISOString())} (${span(Date.now() - running.startedAt)})`);
  }
  if (job.lastStatus) {
    const parts = [
      `${when(job.lastStartedAt ?? job.lastRunAt)}`,
      job.lastStatus,
      ...(job.lastDurationMs !== undefined ? [span(job.lastDurationMs)] : []),
      ...(job.lastModel ? [job.lastModel] : []),
      ...(job.lastCostUsd !== undefined ? [`${job.lastCostPartial ? ">= " : ""}$${job.lastCostUsd.toFixed(2)}`] : []),
    ];
    lines.push(`  last run: ${parts.join(" · ")}${job.lastError ? ` -- ${job.lastError}` : ""}`);
  } else {
    lines.push("  last run: never");
  }
  return lines;
}

export function createCronTool(scheduler: CronScheduler, context: CronToolContext): Tool {
  /** `thread:<title>` becomes the owner's conversation of that name, created if missing. */
  async function resolveDeliver(input: string | undefined, origin: CronOrigin | null, workspace: string | undefined): Promise<string | undefined> {
    if (input === undefined) return undefined;
    const match = /^thread:(.+)$/i.exec(input.trim());
    if (!match) return input;
    if (!origin) throw new Error("A 'thread:<title>' delivery needs the owner's chat: create or update the job from a conversation.");
    if (!context.ensureThread) throw new Error("This server cannot create a conversation for a job.");
    const threadId = await context.ensureThread(origin.chatId, match[1]!.trim(), workspace);
    return `${origin.platform}:${origin.chatId}:${threadId}`;
  }

  /** Absent: don't touch. 0: clear back to the install's setting. Else the job's own, in ms. */
  function durationArg(args: Record<string, unknown>, key: "timeout" | "alert"): number | undefined {
    const raw = strOpt(args, key);
    if (raw === undefined) return undefined;
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "" || trimmed === "inherit" || trimmed === "default" || trimmed === "none") return 0;
    return parseJobTimeout(raw);
  }

  return {
    name: "cron",
    description: "Manage scheduled tasks. Actions: create, list, update, pause, resume, remove, trigger. A scheduled task runs automatically at the specified interval and its output is delivered to a chat. 'list' shows each job's settings, its last run (status, duration, model, cost) and its next one, plus the models, workspaces, skills, MCP servers and tools a job can use. create and update answer with the job's final settings.",
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
        deliver: { type: "string", description: "Delivery target: 'origin' (the chat the job was created from), 'thread:<title>' (a conversation of that name, created in the job's workspace if it does not exist: one place for a family of jobs), 'local' (no delivery), or 'platform:chatId[:threadId]'. Default: origin (create/update)" },
        model: { type: "string", description: "Model override for this job; a model from the 'models' list of cron list (create/update)" },
        workspace: { type: "string", description: "Workspace key from config.workspaces the job runs in; absent = the default workspace. The key is validated against the config on the next run, and an unknown key pauses the job (create/update)" },
        alert: { type: "string", description: "When a run still going is announced to the owner, e.g. '3h' (then again every cron.alertEvery, 1h by default); 'inherit' clears it back to cron.alertAfter (1h). A long run is never stopped for it: the owner decides (create/update)" },
        timeout: { type: "string", description: "A hard time limit for this job, e.g. '6h' (max 24h); none by default, 'none' clears it. The run is told to wrap up shortly before the limit, then stopped at it. Prefer 'alert' unless a run must never go past a time (create/update)" },
        skills: { type: "string", description: "Skills scope (create/update): 'inherit' (clear, the cron agent's list applies), 'all' or '*', 'none', or comma-separated names from the 'skills' list of cron list" },
        mcp: { type: "string", description: "MCP scope (create/update): 'inherit' (clear, the cron agent's list applies), 'all' or '*', 'none', or comma-separated server names from the 'mcp' list of cron list" },
        tools: { type: "string", description: "Tools scope (create/update): 'inherit' (clear, the cron agent's set applies), 'all' or '*', 'none', or comma-separated names from the 'tools' list of cron list. A list narrows the job to exactly those tools. Names outside the cron baseline are dropped at run time" },
        subagents: { type: "boolean", description: "Sub-agents (create/update): the job may spawn and steer them (spawn, send, agents). Granted unless set to false; a job that cannot see the agents it started leaves orphans. 'list' reports it" },
        browser: { type: "boolean", description: "Browser (create/update): the job may open pages through delegate_browser_task, one task at a time on the shared browser. Granted unless set to false. 'list' reports it" },
        conversations: { type: "boolean", description: "Conversation archive (create/update): the job may use conversation_search to check what was already said or sent in other conversations (duplicate checks, follow-ups). Off unless set to true" },
        reason: { type: "string", description: "Pause reason (pause)" },
        enabled: { type: "boolean", description: "Include disabled jobs in list (list)" },
      },
      required: ["action"],
    },
    async execute(args): Promise<ToolResult> {
      const action = str(args, "action");

      const msg = (args.__message as UnifiedMessage | undefined) ?? null;
      const origin: CronOrigin | null = msg && msg.platform === "my-claw-app"
        ? { platform: msg.platform, chatId: msg.chatId, threadId: msg.threadId }
        : null;

      try {
        switch (action) {
          case "create": {
            const rawPrompt = str(args, "prompt");
            if (!rawPrompt) return { success: false, output: "Missing 'prompt' for create." };
            // Stored normalised. Rejecting when normalisation changed the text would turn a stray
            // zero-width space into a refusal to schedule; see docs/untrusted-content.md.
            const prompt = normalizeUntrusted(rawPrompt, "cron-prompt");
            const schedule = str(args, "schedule");
            if (!schedule) return { success: false, output: "Missing 'schedule' for create." };

            const workspace = strOpt(args, "workspace");
            const deliverInput = strOpt(args, "deliver") ?? "origin";
            if (deliverInput.toLowerCase() === "origin" && !origin) {
              return { success: false, output: "Cannot use 'origin' delivery without an origin chat. Specify a target: 'my-claw-app:owner'." };
            }
            const deliver = await resolveDeliver(deliverInput, origin, workspace);
            const timeoutMs = durationArg(args, "timeout");
            const alertAfterMs = durationArg(args, "alert");
            const conversations = boolOpt(args, "conversations");

            const job = createJob({
              name: strOpt(args, "name"),
              prompt,
              schedule,
              origin,
              deliver,
              model: strOpt(args, "model"),
              workspace,
              skills: parseScopeInput(strOpt(args, "skills")).scope,
              mcp: parseScopeInput(strOpt(args, "mcp")).scope,
              tools: parseScopeInput(strOpt(args, "tools")).scope,
              subagents: boolOpt(args, "subagents"),
              browser: boolOpt(args, "browser"),
              ...(timeoutMs ? { timeoutMs } : {}),
            });
            if (conversations === true) job.conversations = true;
            if (alertAfterMs) job.alertAfterMs = alertAfterMs;
            await mutateJobs((jobs) => {
              jobs.push(job);
            });
            hooks.emit("cron:job:created", { jobId: job.id, jobName: job.name });
            return { success: true, output: ["Scheduled task created.", ...describeJob(job, scheduler, context)].join("\n") };
          }

          case "list": {
            const jobs = await loadJobs();
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
              lines.push(...describeJob(j, scheduler, context));
              const removed: string[] = [];
              if (j.model && !modelIds.includes(j.model) && !j.model.startsWith("tag:")) removed.push(`${j.model} (model)`);
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
            const skills = parseScopeInput(strOpt(args, "skills"));
            const mcp = parseScopeInput(strOpt(args, "mcp"));
            const tools = parseScopeInput(strOpt(args, "tools"));
            // Tri-state, like the scopes: absent means "don't touch", not "off".
            const subagents = boolOpt(args, "subagents");
            const browser = boolOpt(args, "browser");
            const conversations = boolOpt(args, "conversations");
            const timeoutMs = durationArg(args, "timeout");
            const alertAfterMs = durationArg(args, "alert");
            const workspaceArg = strOpt(args, "workspace");

            // Resolved before the write: creating a conversation must not happen inside the lock.
            const before = (await loadJobs()).find((j) => j.id === jobId);
            if (!before) return { success: false, output: `Job not found: ${jobId}` };
            const deliverInput = strOpt(args, "deliver");
            if (deliverInput?.toLowerCase() === "origin" && !before.origin) {
              return { success: false, output: "Cannot set deliver='origin' because the job has no origin chat." };
            }
            const deliver = await resolveDeliver(deliverInput, before.origin ?? origin, workspaceArg ?? before.workspace);

            const updated = await mutateJobs((jobs) => {
              const target = jobs.find((j) => j.id === jobId);
              if (!target) return null;
              // "inherit" means the field leaves the job, but updateJob reads undefined as "don't
              // touch": clearing has to happen before the update so the store's semantics stay.
              if (skills.present && skills.scope === undefined) delete target.skills;
              if (mcp.present && mcp.scope === undefined) delete target.mcp;
              if (tools.present && tools.scope === undefined) delete target.tools;
              if (conversations !== undefined) {
                if (conversations) target.conversations = true;
                else delete target.conversations;
              }
              if (alertAfterMs !== undefined) {
                if (alertAfterMs > 0) target.alertAfterMs = alertAfterMs;
                else delete target.alertAfterMs;
              }
              return updateJob(jobs, jobId, {
                name: strOpt(args, "name"),
                prompt,
                model: strOpt(args, "model"),
                schedule,
                deliver,
                workspace: workspaceArg,
                ...(skills.present && skills.scope !== undefined ? { skills: skills.scope } : {}),
                ...(mcp.present && mcp.scope !== undefined ? { mcp: mcp.scope } : {}),
                ...(tools.present && tools.scope !== undefined ? { tools: tools.scope } : {}),
                ...(subagents === undefined ? {} : { subagents }),
                ...(browser === undefined ? {} : { browser }),
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
              });
            });
            if (!updated) return { success: false, output: `Job not found: ${jobId}` };
            hooks.emit("cron:job:updated", { jobId });
            return { success: true, output: [`Updated job ${jobId}.`, ...describeJob(updated, scheduler, context)].join("\n") };
          }

          case "pause": {
            const jobId = str(args, "job_id");
            if (!jobId) return { success: false, output: "Missing 'job_id' for pause." };
            const job = await mutateJobs((jobs) => {
              const target = jobs.find((j) => j.id === jobId);
              if (!target) return null;
              target.enabled = false;
              target.state = "paused";
              target.pausedReason = strOpt(args, "reason") ?? undefined;
              return target;
            });
            if (!job) return { success: false, output: `Job not found: ${jobId}` };
            hooks.emit("cron:job:paused", { jobId });
            const running = scheduler.runningOf(jobId);
            const note = running ? " Its current run is not stopped: it finishes, and no new one starts." : "";
            return { success: true, output: `Paused job ${jobId}: ${job.name}.${note}` };
          }

          case "resume": {
            const jobId = str(args, "job_id");
            if (!jobId) return { success: false, output: "Missing 'job_id' for resume." };
            const job = await mutateJobs((jobs) => {
              const target = jobs.find((j) => j.id === jobId);
              if (!target) return null;
              target.enabled = true;
              target.state = "scheduled";
              target.pausedReason = undefined;
              target.nextRunAt = computeNextRun(target.schedule, target.lastRunAt ?? undefined);
              return target;
            });
            if (!job) return { success: false, output: `Job not found: ${jobId}` };
            hooks.emit("cron:job:resumed", { jobId });
            return { success: true, output: `Resumed job ${jobId}: ${job.name}. Next run: ${job.nextRunAt ?? "none"}` };
          }

          case "remove": {
            const jobId = str(args, "job_id");
            if (!jobId) return { success: false, output: "Missing 'job_id' for remove." };
            const removed = await mutateJobs((jobs) => removeJob(jobs, jobId));
            if (!removed) return { success: false, output: `Job not found: ${jobId}` };
            hooks.emit("cron:job:removed", { jobId });
            return { success: true, output: `Removed job ${jobId}.` };
          }

          case "trigger": {
            const jobId = str(args, "job_id");
            if (!jobId) return { success: false, output: "Missing 'job_id' for trigger." };
            const running = scheduler.runningOf(jobId);
            if (running) {
              return {
                success: false,
                output: `Job ${jobId} is already running (since ${when(new Date(running.startedAt).toISOString())}). A job never runs twice at once: wait for this run to end.`,
              };
            }
            const job = await mutateJobs((jobs) => {
              const target = jobs.find((j) => j.id === jobId);
              if (!target) return null;
              if (!target.enabled) {
                target.enabled = true;
                target.state = "scheduled";
              }
              target.nextRunAt = new Date().toISOString();
              return target;
            });
            if (!job) return { success: false, output: `Job not found: ${jobId}` };
            hooks.emit("cron:job:triggered", { jobId });
            void scheduler.tick();
            return { success: true, output: `Triggered job ${jobId}: ${job.name}. It starts now; cron list shows it running.` };
          }

          default:
            return { success: false, output: `Unknown action: ${action}. Use create, list, update, pause, resume, remove, trigger.` };
        }
      } catch (err) {
        return { success: false, output: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
