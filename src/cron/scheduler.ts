import type { ChannelAdapter, UnifiedMessage } from "../channels/types.ts";
import type { MyClawConfig } from "../core/config.ts";
import type { MessageRouter } from "../core/router.ts";
import type { SessionManager } from "../sessions/manager.ts";
import {
  loadJobs,
  getDueJobs,
  advanceNextRun,
  markJobRun,
  saveJobOutput,
  persistJobRunUpdates,
} from "./store.ts";
import type { CronJob, CronDeliveryTarget } from "./types.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { cleanupGeneratedTempFiles } from "../utils/media.ts";

const SILENT_MARKER = "[SILENT]";

// Safety net for runaway jobs, deliberately long so heavy/voluminous cron tasks
// (deep research, many sub-agents) can finish. Override per install via cron.timeoutMs.
const DEFAULT_CRON_TIMEOUT_MS = 30 * 60_000;

export class CronScheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  adapters = new Map<string, ChannelAdapter>();

  constructor(
    private router: MessageRouter,
    private sessionManager: SessionManager,
    private config: MyClawConfig,
  ) {}

  start(intervalMs?: number): void {
    if (this.config.cron?.enabled === false) return;
    const ms = this.config.cron?.tickIntervalMs ?? intervalMs ?? 60_000;
    this.tickTimer = setInterval(() => { void this.tick(); }, ms);
    if (this.tickTimer.unref) this.tickTimer.unref();
    void log("info", "cron scheduler started", { intervalMs: ms });
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // Re-arm the tick timer to pick up a hot-reloaded cron.enabled / cron.tickIntervalMs
  // (both are captured at start(); timeoutMs is already read live per tick). Safe to call
  // repeatedly: stop() clears any existing timer first.
  restart(): void {
    this.stop();
    this.start();
  }

  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const allJobs = await loadJobs();
      const due = getDueJobs(allJobs);
      // getDueJobs may skip-ahead overdue jobs' nextRunAt even when none are due; persist that so
      // it is not recomputed forever. Merge-by-id keeps concurrent tool edits intact.
      if (due.length === 0) {
        await persistJobRunUpdates(allJobs);
        return 0;
      }

      hooks.emit("cron:tick", { dueCount: due.length, totalJobs: allJobs.length });
      void log("info", "cron tick", { dueCount: due.length, totalJobs: allJobs.length });

      for (const job of due) {
        if (job.schedule.kind !== "once") {
          advanceNextRun(job);
        }
      }
      await persistJobRunUpdates(allJobs);

      let executed = 0;
      for (const job of due) {
        try {
          await this.processJob(job);
          markJobRun(job, true);
          executed++;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          markJobRun(job, false, errMsg);
          void log("error", "cron job failed", { jobId: job.id, jobName: job.name, error: errMsg });
        }
      }

      await persistJobRunUpdates(allJobs);
      return executed;
    } catch (err) {
      void log("error", "cron tick failed", { error: String(err) });
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  private async processJob(job: CronJob): Promise<void> {
    const gate = await hooks.check("gate:cron:job:before", { jobId: job.id, jobName: job.name });
    if (!gate.allowed) {
      void log("info", "cron job blocked by gate", { jobId: job.id, reason: gate.reason });
      return;
    }

    const jobStartedAt = Date.now();
    hooks.emit("cron:job:start", { jobId: job.id, jobName: job.name });
    void log("info", "cron job started", { jobId: job.id, jobName: job.name });

    try {
      const prompt = this.buildCronPrompt(job);
      const synthMessage = this.buildSyntheticMessage(job, prompt);
      const sessionId = `cron/${job.id}`;

      const session = await this.sessionManager.getOrCreate(sessionId, synthMessage);
      session.modelOverride = job.model || undefined;

      const timeoutMs = this.config.cron?.timeoutMs ?? DEFAULT_CRON_TIMEOUT_MS;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.router.stop(sessionId);
      }, timeoutMs);
      if (timer.unref) timer.unref();

      let result: Awaited<ReturnType<typeof this.router.routeCron>>;
      try {
        result = await this.router.routeCron(synthMessage, sessionId);
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) {
        throw new Error(`Cron job timed out after ${Math.round(timeoutMs / 1000)}s (cron.timeoutMs)`);
      }
      const responseText = result?.text ?? "";
      const attachments = result?.attachments ?? [];

      await saveJobOutput(job.id, responseText).catch((err) => {
        void log("warn", "cron output save failed", { jobId: job.id, error: String(err) });
      });

      const silent = responseText.startsWith(SILENT_MARKER);
      if (silent) {
        hooks.emit("cron:job:end", { jobId: job.id, jobName: job.name, success: true, silent: true, durationMs: Date.now() - jobStartedAt });
        void log("info", "cron job silent", { jobId: job.id, jobName: job.name });
        return;
      }

      if (!responseText.trim()) {
        throw new Error("Agent returned empty response");
      }

      let delivered: CronDeliveryTarget | null = null;
      try {
        delivered = await this.deliverResult(job, responseText, attachments);
      } finally {
        // Generated files (TTS/screenshots) are only cleaned by the channel send path on the
        // user-facing flow; the cron path owns its own cleanup regardless of delivery outcome.
        await cleanupGeneratedTempFiles(attachments).catch(() => {});
      }
      hooks.emit("cron:job:end", { jobId: job.id, jobName: job.name, success: true, silent: false, durationMs: Date.now() - jobStartedAt });
      if (delivered) {
        hooks.emit("cron:job:delivered", { jobId: job.id, platform: delivered.platform, chatId: delivered.chatId });
      }
      void log("info", "cron job completed", { jobId: job.id, jobName: job.name });
    } catch (err) {
      hooks.emit("cron:job:error", { jobId: job.id, jobName: job.name, error: err });
      throw err;
    }
  }

  private buildSyntheticMessage(job: CronJob, prompt: string): UnifiedMessage {
    return {
      id: `cron-${job.id}-${Date.now()}`,
      platform: "cron",
      userId: "cron",
      chatId: `cron-${job.id}`,
      chatType: "dm",
      text: prompt,
      attachments: [],
      isForwarded: false,
      raw: null,
    };
  }

  private buildCronPrompt(job: CronJob): string {
    const header = [
      "You are executing a scheduled task. Your response will be automatically delivered.",
      "",
      "If you have nothing useful to report, start your response with [SILENT] and the delivery will be suppressed (the output is still saved locally).",
      "",
      "Do not ask clarifying questions -- there is no user present to answer.",
      "",
      "---",
      "",
    ].join("\n");

    return header + job.prompt;
  }

  private async deliverResult(
    job: CronJob,
    result: string,
    attachments: NonNullable<import("../channels/types.ts").OutgoingMessage["attachments"]> = [],
  ): Promise<CronDeliveryTarget | null> {
    const target = this.resolveDeliveryTarget(job);
    if (!target) return null;

    const adapter = this.adapters.get(target.platform);
    if (!adapter) {
      job.lastError = `No adapter for platform "${target.platform}"`;
      void log("warn", "cron delivery failed", { jobId: job.id, error: job.lastError });
      return null;
    }

    const text = `[Cron: ${job.name}]\n\n${result}`;
    await adapter.send(target.chatId, { text, threadId: target.threadId, attachments: attachments.length > 0 ? attachments : undefined });
    return target;
  }

  private resolveDeliveryTarget(job: CronJob): CronDeliveryTarget | null {
    if (job.deliver === "local") return null;
    if (job.deliver === "origin") {
      if (!job.origin) {
        job.lastError = "deliver=origin but origin is null";
        return null;
      }
      return job.origin;
    }
    return job.deliver;
  }
}
