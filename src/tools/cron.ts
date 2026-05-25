import type { Tool, ToolResult } from "../tools/types.ts";
import { str, strOpt, bool } from "../tools/types.ts";
import { scanForInjection } from "../agent/prompt/anti-injection.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import { createJob, loadJobs, saveJobs, updateJob, removeJob, parseDeliver, computeNextRun } from "../cron/store.ts";
import type { CronOrigin } from "../cron/types.ts";
import type { CronScheduler } from "../cron/scheduler.ts";
import { hooks } from "../hooks/index.ts";

export function createCronTool(scheduler: CronScheduler): Tool {
  return {
    name: "cron",
    description: "Manage scheduled tasks. Actions: create, list, update, pause, resume, remove, trigger. A scheduled task runs automatically at the specified interval and its output is delivered to a chat.",
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
        model: { type: "string", description: "Model override for this job (create/update)" },
        reason: { type: "string", description: "Pause reason (pause)" },
        enabled: { type: "boolean", description: "Include disabled jobs in list (list)" },
      },
      required: ["action"],
    },
    async execute(args): Promise<ToolResult> {
      const action = str(args, "action");
      const jobs = await loadJobs();

      const msg = (args.__message as UnifiedMessage | undefined) ?? null;
      const origin: CronOrigin | null = msg
        ? { platform: msg.platform as "telegram" | "matrix", chatId: msg.chatId, threadId: msg.threadId }
        : null;

      switch (action) {
        case "create": {
          const prompt = str(args, "prompt");
          if (!prompt) return { success: false, output: "Missing 'prompt' for create." };
          const schedule = str(args, "schedule");
          if (!schedule) return { success: false, output: "Missing 'schedule' for create." };

          const scanned = scanForInjection(prompt, "cron-prompt");
          if (scanned !== prompt) {
            return { success: false, output: `Prompt rejected: ${scanned}` };
          }

          const deliverInput = strOpt(args, "deliver") ?? "origin";
          if (deliverInput.toLowerCase() === "origin" && !origin) {
            return { success: false, output: "Cannot use 'origin' delivery without an origin chat. Specify a target: 'telegram:chatId' or 'matrix:roomId'." };
          }

          const job = createJob({
            name: strOpt(args, "name"),
            prompt,
            schedule,
            origin,
            deliver: deliverInput,
            model: strOpt(args, "model"),
          });
          jobs.push(job);
          await saveJobs(jobs);
          hooks.emit("cron:job:created", { jobId: job.id, jobName: job.name });
          return { success: true, output: `Scheduled task created.\nID: ${job.id}\nName: ${job.name}\nSchedule: ${job.schedule.display}\nNext run: ${job.nextRunAt ?? "none"}` };
        }

        case "list": {
          const includeDisabled = bool(args, "enabled", true);
          const visible = includeDisabled ? jobs : jobs.filter((j) => j.enabled);
          if (visible.length === 0) {
            return { success: true, output: "No scheduled tasks." };
          }
          const lines = visible.map((j) => {
            const status = j.enabled ? j.state : "paused";
            const next = j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : "-";
            return `${j.id} | ${j.name} | ${j.schedule.display} | ${status} | next: ${next}`;
          });
          return { success: true, output: lines.join("\n") };
        }

        case "update": {
          const jobId = str(args, "job_id");
          if (!jobId) return { success: false, output: "Missing 'job_id' for update." };

          const prompt = strOpt(args, "prompt");
          if (prompt) {
            const scanned = scanForInjection(prompt, "cron-prompt");
            if (scanned !== prompt) {
              return { success: false, output: `Prompt rejected: ${scanned}` };
            }
          }

          const schedule = strOpt(args, "schedule");
          const deliver = strOpt(args, "deliver");
          if (deliver?.toLowerCase() === "origin") {
            const job = jobs.find((j) => j.id === jobId);
            if (!job?.origin) {
              return { success: false, output: "Cannot set deliver='origin' because the job has no origin chat." };
            }
          }

          const updated = updateJob(jobs, jobId, {
            name: strOpt(args, "name"),
            prompt,
            model: strOpt(args, "model"),
            schedule,
            deliver,
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
