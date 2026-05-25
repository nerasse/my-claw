import type { ChannelAdapter, UnifiedMessage } from "../channels/types.ts";
import type { MyClawConfig } from "../core/config.ts";
import type { MessageRouter } from "../core/router.ts";
import type { SessionManager } from "../sessions/manager.ts";
import {
  loadJobs,
  saveJobs,
  getDueJobs,
  advanceNextRun,
  markJobRun,
  saveJobOutput,
} from "./store.ts";
import type { CronJob, CronDeliveryTarget } from "./types.ts";
import { log } from "../utils/logger.ts";

const SILENT_MARKER = "[SILENT]";

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

  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const allJobs = await loadJobs();
      const due = getDueJobs(allJobs);
      if (due.length === 0) return 0;

      void log("info", "cron tick", { dueCount: due.length, totalJobs: allJobs.length });

      for (const job of due) {
        if (job.schedule.kind !== "once") {
          advanceNextRun(job);
        }
      }
      await saveJobs(allJobs);

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

      await saveJobs(allJobs);
      return executed;
    } catch (err) {
      void log("error", "cron tick failed", { error: String(err) });
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  private async processJob(job: CronJob): Promise<void> {
    void log("info", "cron job started", { jobId: job.id, jobName: job.name });

    const prompt = this.buildCronPrompt(job);
    const synthMessage = this.buildSyntheticMessage(job, prompt);
    const sessionId = `cron/${job.id}`;

    const result = await this.router.routeCron(synthMessage, sessionId);
    const responseText = result?.text ?? "";

    await saveJobOutput(job.id, responseText).catch((err) => {
      void log("warn", "cron output save failed", { jobId: job.id, error: String(err) });
    });

    if (responseText.startsWith(SILENT_MARKER)) {
      void log("info", "cron job silent", { jobId: job.id, jobName: job.name });
      return;
    }

    if (!responseText.trim()) {
      throw new Error("Agent returned empty response");
    }

    await this.deliverResult(job, responseText);
    void log("info", "cron job completed", { jobId: job.id, jobName: job.name });
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

  private async deliverResult(job: CronJob, result: string): Promise<void> {
    const target = this.resolveDeliveryTarget(job);
    if (!target) return;

    const adapter = this.adapters.get(target.platform);
    if (!adapter) {
      job.lastError = `No adapter for platform "${target.platform}"`;
      void log("warn", "cron delivery failed", { jobId: job.id, error: job.lastError });
      return;
    }

    const text = `[Cron: ${job.name}]\n\n${result}`;
    await adapter.send(target.chatId, { text, threadId: target.threadId });
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
