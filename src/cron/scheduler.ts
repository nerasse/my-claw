import type { ChannelAdapter, UnifiedMessage } from "../channels/types.ts";
import type { MyClawConfig } from "../core/config.ts";
import { resolveAgentWorkspace } from "../core/config.ts";
import type { MessageRouter, RouteResult } from "../core/router.ts";
import type { SessionManager } from "../sessions/manager.ts";
import {
  getDueJobs,
  advanceNextRun,
  markJobRun,
  saveJobOutput,
  mutateJobs,
  recoverInterruptedRuns,
  cleanupOrphanJobTemps,
} from "./store.ts";
import type { CronJob, CronDeliveryTarget, CronRunStatus } from "./types.ts";
import { withRunContext } from "../utils/run-context.ts";
import { log } from "../utils/logger.ts";
import { hooks } from "../hooks/index.ts";
import { cleanupGeneratedTempFiles } from "../utils/media.ts";
import { runRegistry } from "../core/run-registry.ts";
import { getTreeModelUsage, getSessionModelUsage, type SessionModelRow } from "../analytics/usage-db.ts";
import { parseDurationMs } from "../utils/duration.ts";
import { sessionLogOf } from "../sessions/log-access.ts";
import type { CronDelivery } from "../sessions/log.ts";
import { continuable } from "../sessions/resume.ts";

const SILENT_MARKER = "[SILENT]";

/**
 * No wall by default: a long run is announced, and the owner stops it. A thirty-minute wall killed
 * the weekly research of 2026-09-27 with six sub-agents mid-pass; a longer one would only move the
 * loss. Jobs no longer hold each other up, so a long one costs its own tokens and nothing else. A
 * wall stays available, per install (`cron.timeoutMs`) or per job (`timeout`). docs/cron.md.
 */
export const DEFAULT_ALERT_AFTER_MS = 60 * 60_000;
export const DEFAULT_ALERT_EVERY_MS = 60 * 60_000;

function durationOr(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  try {
    const ms = parseDurationMs(value);
    return ms > 0 ? ms : fallback;
  } catch {
    return fallback;
  }
}

/**
 * How long before the wall a run is told to finish. A tenth of its limit, between one and ten
 * minutes: enough for a parent to collect what its sub-agents return and write it down, short
 * enough that a thirty-minute job still spends most of its time working. Never more than half the
 * limit, or a short job would be told to stop before it had started.
 */
export function wrapUpLeadMs(timeoutMs: number): number {
  return Math.min(10 * 60_000, Math.max(60_000, Math.round(timeoutMs / 10)), Math.round(timeoutMs / 2));
}

/** A job referenced a workspace key that left the config: it must pause, not run elsewhere. */
class CronWorkspaceMissingError extends Error {
  constructor(readonly key: string) {
    super(`workspace "${key}" is not in config.workspaces`);
  }
}

/** A run that did not end on its own. Not the agent failing: the limit, or the server. */
class CronInterruptedError extends Error {}

/** Where a delivered result is written so the conversation keeps it: see `journal`. */
export type CronDeliveryJournal = (
  target: CronDeliveryTarget,
  text: string,
  delivery: CronDelivery,
) => Promise<void>;

/** Hands a report to a conversation as its next turn; false when the channel could not take it. */
export type CronHandOver = (target: CronDeliveryTarget, text: string) => Promise<boolean>;

/** What a follow-up turn asks when its job says nothing of its own. */
export const DEFAULT_FOLLOW_UP =
  "Act on this report in this conversation's workspace: update what it calls for, and do what it says is ready to be done.";

/** The turn a follow-up hands over: the report, then what to do with it. */
export function followUpTurn(job: Pick<CronJob, "name" | "followUpPrompt">, result: string): string {
  return `[Cron: ${job.name}]\n\n${result}\n\n---\n${job.followUpPrompt ?? DEFAULT_FOLLOW_UP}`;
}

interface RunningJob {
  sessionId: string;
  startedAt: number;
  name: string;
  workspace?: string;
}

/** What a run cost and ran on, read back from the analytics the calls already wrote. */
export interface RunUsage {
  model?: string;
  costUsd?: number;
  costPartial?: boolean;
}

export function usageOfRun(sessionId: string): RunUsage {
  const own = getSessionModelUsage(sessionId, "own");
  const delegated = getTreeModelUsage(sessionId);
  const rows: SessionModelRow[] = [...own, ...delegated];
  const main = [...own].sort((a, b) => b.calls - a.calls)[0];
  let cost = 0;
  let priced = 0;
  for (const row of rows) {
    if (row.pinnedCost) {
      cost += row.pinnedCost.usd;
      priced++;
    }
  }
  return {
    ...(main ? { model: main.model } : {}),
    ...(priced > 0 ? { costUsd: cost } : {}),
    ...(priced > 0 && priced < rows.length ? { costPartial: true } : {}),
  };
}

export class CronScheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Only the dispatch is exclusive; the runs it starts go on without holding the next tick up. */
  private dispatching = false;
  private recovered = false;
  /** jobId -> its run in flight. A job is never started twice at once. */
  private readonly running = new Map<string, RunningJob>();
  /** session -> the sub-agent sessions it started, for the runs of a cron tree only. */
  private readonly children = new Map<string, Set<string>>();
  adapters = new Map<string, ChannelAdapter>();
  /**
   * Writes a delivered result into the target conversation's history. Without it a delivery was a
   * frame to whichever device happened to be connected: gone on reload, and never there at all
   * when the phone was asleep -- which is when a morning job delivers (docs/cron.md).
   */
  journal?: CronDeliveryJournal;
  /** Opens a turn in the target conversation for a job with `followUp` (docs/cron.md). */
  handOver?: CronHandOver;

  constructor(
    private router: MessageRouter,
    private sessionManager: SessionManager,
    private config: MyClawConfig,
    private readonly usage: (sessionId: string) => RunUsage = usageOfRun,
  ) {
    hooks.on("subagent:spawn", ({ id, parentSessionId }) => {
      if (!this.inCronTree(parentSessionId)) return;
      let set = this.children.get(parentSessionId);
      if (!set) {
        set = new Set();
        this.children.set(parentSessionId, set);
      }
      set.add(id);
    });
    const settled = ({ id, parentSessionId }: { id: string; parentSessionId: string }): void => {
      this.children.get(parentSessionId)?.delete(id);
    };
    hooks.on("subagent:complete", settled);
    hooks.on("subagent:error", settled);
    hooks.on("subagent:aborted", settled);
  }

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
  // (both are captured at start(); timeoutMs is already read live per run). Safe to call
  // repeatedly: stop() clears any existing timer first.
  restart(): void {
    this.stop();
    this.start();
  }

  /** The run in flight for a job, if any: `cron list` and `trigger` read it. */
  runningOf(jobId: string): { sessionId: string; startedAt: number } | undefined {
    const run = this.running.get(jobId);
    return run ? { sessionId: run.sessionId, startedAt: run.startedAt } : undefined;
  }

  /**
   * Starts every due job that is not already running, and resolves once the runs it started have
   * ended. The number is how many of them completed.
   *
   * Jobs run side by side. They used to run one after the other inside the tick, so a long job held
   * every other one up: a thirty-minute research delayed the evening mail check, and raising its
   * limit to hours would have skipped the check outright once it fell outside its grace window.
   * What stays exclusive is a job with itself: a run still going when its next time comes makes
   * that occurrence skip, it never starts a second copy.
   */
  async tick(): Promise<number> {
    if (this.dispatching) return 0;
    this.dispatching = true;
    let started: Array<Promise<boolean>> = [];
    try {
      if (!this.recovered) {
        this.recovered = true;
        const lost = await recoverInterruptedRuns();
        if (lost.length > 0) void log("warn", "cron runs lost to a server stop", { jobIds: lost });
        const removed = await cleanupOrphanJobTemps();
        if (removed > 0) void log("info", "cron orphan temp files removed", { removed });
      }

      let total = 0;
      const due = await mutateJobs((jobs) => {
        total = jobs.length;
        const dueNow = getDueJobs(jobs);
        const runnable: CronJob[] = [];
        for (const job of dueNow) {
          if (job.schedule.kind !== "once") {
            // An expression the parser refuses used to throw out of the whole tick, before a single
            // job had run: one hand-edited jobs.json line froze every schedule, silently.
            try {
              advanceNextRun(job);
            } catch (err) {
              job.enabled = false;
              job.state = "paused";
              job.pausedReason = `unreadable schedule: ${err instanceof Error ? err.message : String(err)}`;
              job.nextRunAt = null;
              void log("error", "cron job paused: unreadable schedule", {
                jobId: job.id, jobName: job.name, error: String(err),
              });
              continue;
            }
          }
          const inFlight = this.running.get(job.id);
          if (inFlight) {
            void log("warn", "cron job skipped: its previous run is still going", {
              jobId: job.id,
              jobName: job.name,
              runningSince: new Date(inFlight.startedAt).toISOString(),
              nextRunAt: job.nextRunAt,
            });
            continue;
          }
          runnable.push(structuredClone(job));
        }
        return runnable;
      });
      if (due.length === 0) return 0;

      hooks.emit("cron:tick", { dueCount: due.length, totalJobs: total });
      void log("info", "cron tick", { dueCount: due.length, totalJobs: total });
      started = due.map((job) => this.runJob(job));
    } catch (err) {
      void log("error", "cron tick failed", { error: String(err) });
      return 0;
    } finally {
      this.dispatching = false;
    }
    const results = await Promise.all(started);
    return results.filter(Boolean).length;
  }

  /** One run of one job, from its start mark to the fields it leaves on the job. */
  private async runJob(job: CronJob): Promise<boolean> {
    const startedAt = Date.now();
    const sessionId = `cron/${job.id}/${startedAt}`;
    const workspace = job.workspace ?? resolveAgentWorkspace(this.config, "cron");
    // Set before the first await: a tick running meanwhile must already see it.
    this.running.set(job.id, { sessionId, startedAt, name: job.name, ...(workspace ? { workspace } : {}) });

    let status: CronRunStatus = "ok";
    let error: string | undefined;
    let paused: string | undefined;
    try {
      await mutateJobs((jobs) => {
        const target = jobs.find((j) => j.id === job.id);
        if (target) target.runningSince = new Date(startedAt).toISOString();
      });
      await this.processJob(job, sessionId, startedAt, workspace);
    } catch (err) {
      if (err instanceof CronWorkspaceMissingError) {
        paused = err.message;
        void log("warn", "cron job paused: workspace missing", { jobId: job.id, jobName: job.name, workspace: err.key });
      } else {
        status = err instanceof CronInterruptedError ? "interrupted" : "error";
        error = err instanceof Error ? err.message : String(err);
        void log("error", status === "interrupted" ? "cron job interrupted" : "cron job failed", {
          jobId: job.id, jobName: job.name, error,
        });
      }
    } finally {
      this.running.delete(job.id);
      this.children.delete(sessionId);
    }

    const usage = paused ? {} : this.usage(sessionId);
    await mutateJobs((jobs) => {
      const target = jobs.find((j) => j.id === job.id);
      if (!target) return;
      if (paused) {
        // The workspace left the config: pausing is the only honest state. A scheduled job would
        // otherwise tick forever, failing at every run. Not a run, so no run fields move.
        target.state = "paused";
        target.pausedReason = paused;
        target.enabled = false;
        delete target.runningSince;
        return;
      }
      markJobRun(target, status, error);
      target.lastStartedAt = new Date(startedAt).toISOString();
      target.lastDurationMs = Date.now() - startedAt;
      if (usage.model) target.lastModel = usage.model;
      else delete target.lastModel;
      if (usage.costUsd !== undefined) target.lastCostUsd = usage.costUsd;
      else delete target.lastCostUsd;
      if (usage.costPartial) target.lastCostPartial = true;
      else delete target.lastCostPartial;
    }).catch((err) => {
      void log("error", "cron run result could not be saved", { jobId: job.id, error: String(err) });
    });

    // A run's session stays on disk (the app opens it as a chat and can answer on it),
    // so the per-job retention is what stops it from growing without bound.
    await this.pruneSessions(job.id);
    return !paused && status === "ok";
  }

  private async processJob(job: CronJob, sessionId: string, jobStartedAt: number, workspace: string | undefined): Promise<void> {
    const gate = await hooks.check("gate:cron:job:before", { jobId: job.id, jobName: job.name });
    if (!gate.allowed) {
      void log("info", "cron job blocked by gate", { jobId: job.id, reason: gate.reason });
      return;
    }

    hooks.emit("cron:job:start", { jobId: job.id, jobName: job.name });
    void log("info", "cron job started", { jobId: job.id, jobName: job.name });

    try {
      // The job's own key wins over the cron agent's configured workspace, which wins over the
      // default. An unknown key would silently run the job in the default workspace — the
      // opposite of what the owner configured. The job pauses loudly instead.
      if (workspace && !this.config.workspaces?.[workspace]) {
        throw new CronWorkspaceMissingError(workspace);
      }

      const timeoutMs = job.timeoutMs ?? this.config.cron?.timeoutMs;
      const prompt = this.buildCronPrompt(job, timeoutMs, workspace);
      const synthMessage = this.buildSyntheticMessage(job, prompt);

      const session = await this.sessionManager.getOrCreateWithMeta(
        sessionId,
        synthMessage.platform,
        synthMessage.chatType,
        workspace,
      );
      // The session outlives the run (the app lists a job's runs and can reopen one to chat
      // on it), so it deserves a name: the job's own, with the run time, not the raw prompt.
      session.title = `${job.name} · ${new Date(jobStartedAt).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })}`;
      session.modelOverride = job.model || undefined;
      // The job's own effort pin, the sibling of the model override: it slots above the cron
      // agent's config entry but stays under a tag's pin and the session's /effort. It lives on
      // the session rather than in effortOverride for exactly that reason — effortOverride is the
      // session level and would outrank the tag.
      session.scopeEffort = job.effort || undefined;
      // Job-level scope, slotted above the cron agent's config entry exactly like the model
      // override above: the job's own choices win, an absent field inherits agents.cron.
      session.scopeOverride = {
        ...(job.skills ? { skills: job.skills } : {}),
        ...(job.mcp ? { mcp: job.mcp } : {}),
        ...(job.tools ? { tools: job.tools } : {}),
      };
      // The job's capability switches, resolved at the one place a run's tools are built. Absent
      // fields mean granted, so a job made before the switches keeps what it had. docs/cron.md.
      session.scopeCapabilities = { subagents: job.subagents, browser: job.browser, conversations: job.conversations === true };

      // Told before it is stopped: a run killed at the wall loses everything it had not written,
      // its sub-agents' work included. The weekly research of 2026-09-27 lost six passes that way.
      // Only when a wall was asked for.
      const lead = timeoutMs !== undefined ? wrapUpLeadMs(timeoutMs) : 0;
      let timedOut = false;
      const wrapUp = timeoutMs !== undefined ? setTimeout(() => this.wrapUp(sessionId, lead), Math.max(0, timeoutMs - lead)) : undefined;
      if (wrapUp?.unref) wrapUp.unref();
      const wall = timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            this.router.stop(sessionId);
          }, timeoutMs)
        : undefined;
      if (wall?.unref) wall.unref();
      // Announced while it goes, never stopped for it: the owner decides (the tap opens the run,
      // and its Stop). First at the job's alert time, then again at every interval.
      const alertAfter = job.alertAfterMs ?? durationOr(this.config.cron?.alertAfter, DEFAULT_ALERT_AFTER_MS);
      const alertEvery = durationOr(this.config.cron?.alertEvery, DEFAULT_ALERT_EVERY_MS);
      let alertTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleAlert = (delay: number): void => {
        alertTimer = setTimeout(() => {
          // What the run is doing, not only how long: a job busy with four sub-agents reads as one,
          // and a tree that keeps growing reads as the anomaly it is.
          const tree = this.liveTreeOf(sessionId);
          const usage = this.usage(sessionId);
          hooks.emit("cron:job:long", {
            jobId: job.id, jobName: job.name, sessionId, runningMs: Date.now() - jobStartedAt,
            working: tree.working, depth: tree.depth,
            ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
          });
          scheduleAlert(alertEvery);
        }, delay);
        if (alertTimer.unref) alertTimer.unref();
      };
      scheduleAlert(alertAfter);

      let result: RouteResult | undefined;
      try {
        // Opened here rather than in the router so the job id rides along: a notification sent
        // from inside the run points its tap at the job. The router reuses this context instead
        // of nesting a second one.
        result = await withRunContext(
          { platform: synthMessage.platform, sessionId, jobId: job.id },
          () => this.router.routeCron(synthMessage, sessionId),
        );
      } finally {
        clearTimeout(wrapUp);
        clearTimeout(wall);
        clearTimeout(alertTimer);
      }
      if (timedOut && timeoutMs !== undefined) {
        const limit = job.timeoutMs !== undefined ? "the job's timeout" : "cron.timeoutMs";
        throw new CronInterruptedError(
          `Timed out after ${formatMinutes(timeoutMs)} (${limit}); it had been told to finish ${formatMinutes(lead)} before.`,
        );
      }
      // Stopped from the app: the run's own log says so, and a stop is not a failure. Read off the
      // log rather than flagged by whoever stopped it, so every door that can stop a run agrees.
      if (await this.endedStopped(sessionId)) {
        throw new CronInterruptedError("Stopped before it finished; Continue picks it up from its thread.");
      }
      const responseText = result?.text ?? "";
      const attachments = result?.attachments ?? [];

      await saveJobOutput(job.id, responseText).catch((err) => {
        void log("warn", "cron output save failed", { jobId: job.id, error: String(err) });
      });

      const silent = responseText.startsWith(SILENT_MARKER);
      if (silent) {
        hooks.emit("cron:job:end", { jobId: job.id, jobName: job.name, sessionId, success: true, silent: true, durationMs: Date.now() - jobStartedAt });
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
      // `job.silent` suppresses the notification only: the result is still delivered and still
      // saved. That is the difference with SILENT_MARKER above, which means the run had nothing
      // to say at all and therefore returns before delivery.
      hooks.emit("cron:job:end", { jobId: job.id, jobName: job.name, sessionId, success: true, silent: job.silent === true, durationMs: Date.now() - jobStartedAt });
      if (delivered) {
        hooks.emit("cron:job:delivered", { jobId: job.id, platform: delivered.platform, chatId: delivered.chatId });
      }
      void log("info", "cron job completed", { jobId: job.id, jobName: job.name });
    } catch (err) {
      if (!(err instanceof CronWorkspaceMissingError)) {
        hooks.emit("cron:job:error", { jobId: job.id, jobName: job.name, sessionId, error: err, silent: job.silent === true });
      }
      throw err;
    }
  }

  /** Whether a session is a cron run or one of the sub-agents a cron run started. */
  private inCronTree(sessionId: string): boolean {
    if (sessionId.startsWith("cron/")) return true;
    for (const set of this.children.values()) if (set.has(sessionId)) return true;
    return false;
  }

  /** Whether the last run of this session ended on a Stop. */
  private async endedStopped(sessionId: string): Promise<boolean> {
    try {
      const entries = await sessionLogOf(sessionId);
      const ended = continuable(await entries.context(), entries.leaf());
      return ended.ok && ended.ended === "aborted";
    } catch {
      return false;
    }
  }

  /** How many sub-agents under a run are working now, and the deepest level they reach. */
  private liveTreeOf(sessionId: string): { working: number; depth: number } {
    let working = 0;
    let depth = 0;
    const stack: Array<[string, number]> = [[sessionId, 0]];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const [id, level] = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (level > 0) working++;
      if (level > depth) depth = level;
      for (const child of this.children.get(id) ?? []) stack.push([child, level + 1]);
    }
    return { working, depth };
  }

  /** The run and every sub-agent under it that is still working. */
  private treeOf(sessionId: string): string[] {
    const out: string[] = [];
    const stack = [sessionId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      out.push(id);
      for (const child of this.children.get(id) ?? []) stack.push(child);
    }
    return out;
  }

  /**
   * Tells the run and each of its live sub-agents to finish. Through the injection mailbox, the
   * same way the owner steers a run: each reads it at its next step. A parent waiting on its
   * sub-agents only reads it once they return, which is why they are told too -- they are the ones
   * who can hand back what they have.
   */
  private wrapUp(sessionId: string, leadMs: number): void {
    const minutes = formatMinutes(leadMs);
    for (const target of this.treeOf(sessionId)) {
      const root = target === sessionId;
      const text = root
        ? `[Scheduler] This scheduled run reaches its time limit in about ${minutes}. Start nothing new. Your sub-agents have been told the same and will answer with what they have. Write down what you have now (the files the task updates, then your report) and give your final answer before the limit: a run still working at the limit is stopped, and whatever is not written is lost.`
        : `[Scheduler] The scheduled job you work for reaches its time limit in about ${minutes}. Start nothing new: answer now with what you have found so far, and say what you did not get to. A partial answer is worth far more than none.`;
      const message: UnifiedMessage = {
        id: `cron-wrapup-${target}-${Date.now()}`,
        platform: "cron",
        userId: "cron",
        chatId: `cron-wrapup`,
        chatType: "dm",
        text,
        attachments: [],
        isForwarded: false,
        raw: null,
      };
      const queued = runRegistry.enqueueInjection(target, message);
      // Settles when the run ends, however it ends: nothing waits on it here.
      if (queued) queued.catch(() => undefined);
    }
    void log("info", "cron run told to wrap up", { sessionId, leadMs, runs: this.treeOf(sessionId).length });
  }

  private async pruneSessions(jobId: string, keep = 25): Promise<void> {
    const ids = await this.sessionManager.listSessions(`cron/${jobId}/`, 100);
    for (const id of ids.slice(keep)) {
      await this.sessionManager.deleteSession(id).catch(() => {});
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

  private buildCronPrompt(job: CronJob, timeoutMs: number | undefined, workspace: string | undefined): string {
    const header = [
      "You are executing a scheduled task. Your response will be automatically delivered.",
      "",
      "If you have nothing useful to report, start your response with [SILENT] and the delivery will be suppressed (the output is still saved locally).",
      "",
      "Do not ask clarifying questions -- there is no user present to answer.",
    ];
    if (timeoutMs !== undefined) {
      header.push("", `Time limit: ${formatMinutes(timeoutMs)}. You will be told when to wrap up; plan so that what matters is written down early.`);
    }
    // Two jobs of one workspace can run at the same time now. Neither can see the other's edits
    // coming, so each is told the other exists: re-reading a file right before changing it is
    // what keeps one from writing over the other.
    const neighbours = [...this.running.entries()]
      .filter(([id, run]) => id !== job.id && run.workspace === workspace)
      .map(([, run]) => run.name);
    if (neighbours.length > 0) {
      header.push(
        "",
        `Running in this workspace at the same time: ${neighbours.join(", ")}. Re-read a file right before you change it, and change it with a targeted edit rather than a full rewrite.`,
      );
    }
    header.push("", "---", "");
    return header.join("\n") + job.prompt;
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

    // The report as the conversation's next turn: one bubble, which its agent then answers. The
    // turn is written to the log by the run it opens, so no note goes with it. Refused, it falls
    // back to the note below rather than lose the report.
    if (job.followUp && this.handOver) {
      const handed = await this.handOver(target, followUpTurn(job, result)).catch((err) => {
        void log("warn", "cron follow-up could not be handed over", { jobId: job.id, error: String(err) });
        return false;
      });
      if (handed) {
        // A turn carries text only: pictures the run produced still go out as before.
        if (attachments.length > 0) await adapter.send(target.chatId, { text: `[Cron: ${job.name}]`, threadId: target.threadId, attachments });
        return target;
      }
    }

    const text = `[Cron: ${job.name}]\n\n${result}`;
    const delivery = { job: job.name, cadence: job.schedule.display, ...(job.lastError ? { status: "error" as const } : {}) };
    // Written first: the frame only reaches the devices connected right now, the history is what
    // a phone that was asleep reads when it wakes.
    if (this.journal) {
      await this.journal(target, text, delivery).catch((err) => {
        void log("warn", "cron delivery could not be written to the conversation", { jobId: job.id, error: String(err) });
      });
    }
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

function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
