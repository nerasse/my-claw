/**
 * A call that outlived its turn: the registry of background work -- docs/jobs.md.
 *
 * Three harnesses converged on the same shape, and this is that shape: a call that runs past its
 * yield stops being a call and becomes a job its session owns, its output keeps landing in a file,
 * and its end is *pushed* back into the conversation instead of being polled. OpenCode's `Job`
 * (`packages/core/src/job.ts`) and DeepSeek's `ctx.jobs` carry the same four facts: an id, an
 * owner, an output, and a notice.
 *
 * The alternative is what my-claw did until now: hold the run for the whole command, or let the
 * model write `setsid ... &` itself and lose the exit code. A 41-minute silent build then reads as
 * a frozen agent, because nothing between the spawn and the exit says anything at all.
 *
 * Records are one small JSON per job under the session, so a restart can still say what happened
 * instead of leaving a card spinning: a job whose process did not survive is `lost`, never
 * `running`.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SESSIONS_DIR, sessionDir } from "../sessions/paths.ts";
import { log } from "../utils/logger.ts";

export type JobStatus = "running" | "done" | "failed" | "killed" | "lost";

export interface JobRecord {
  id: string;
  /** The session that started it, and the only one that may read or kill it. */
  sessionId: string;
  tool: string;
  /** What the call was, for a reader: the command line of a bash call, a task otherwise. */
  label: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  lastOutputAt: number;
  status: JobStatus;
  exitCode?: number | null;
  signal?: string | null;
  outputPath: string;
  /** Chars written to `outputPath`. */
  chars: number;
  /** Why a job that never reported an exit ended, when there is a reason to give. */
  note?: string;
}

export interface JobStart {
  sessionId: string;
  tool: string;
  label: string;
  pid?: number;
  /** How to stop it. Absent for work that has no process of its own. */
  kill?: () => void;
}

export interface JobRead {
  text: string;
  /** Where the next read starts. */
  offset: number;
  record: JobRecord;
}

/** How long a `job output` waits for something new before saying nothing happened. */
const MAX_WAIT_MS = 60_000;

const JOB_ID_PATTERN = /^job-[0-9a-f]{8}$/;

function jobsDir(sessionId: string): string {
  return join(sessionDir(sessionId), "jobs");
}

export function jobLogPath(sessionId: string, id: string): string {
  return join(jobsDir(sessionId), `${id}.log`);
}

function jobRecordPath(sessionId: string, id: string): string {
  return join(jobsDir(sessionId), `${id}.json`);
}

/** Chars of a job's output kept in the notice. The rest is one `job output` away. */
export const NOTICE_TAIL_CHARS = 4_000;

/**
 * What one job's file may hold.
 *
 * A command that prints in a loop for hours is a mistake, not a build: without a ceiling it fills
 * the disk the sessions live on. Past this the file stops growing and says so once, and the call's
 * own buffer stays bounded as it always was.
 */
export const MAX_JOB_CHARS = 64 * 1024 * 1024;
const TRUNCATION_NOTE = "\n[job output truncated at 64 MiB]\n";

/** What a card says became of it. The app's three words, not five. */
export function jobNoticeStatus(record: JobRecord): "complete" | "error" | "stopped" {
  if (record.status === "done") return "complete";
  if (record.status === "killed") return "stopped";
  return "error";
}

/**
 * What the model reads when a job ends.
 *
 * A tag, like a sub-agent's return, so a notice is never mistaken for the owner talking, and one
 * line that says what to do with it: collect, do not wait. The tail is bounded because a notice is
 * a message in the prompt, not a build log.
 */
export function jobNoticeText(record: JobRecord, tail: string): string {
  const exit = record.exitCode === undefined || record.exitCode === null ? "" : ` exit="${record.exitCode}"`;
  const command = record.label.replace(/\s+/g, " ").trim().slice(0, 300).replace(/"/g, "'");
  const body = tail.trim() || "(no output)";
  return [
    `<job id="${record.id}" status="${record.status}"${exit} command="${command}">`,
    body,
    "</job>",
    "",
    `This is the end of a background job you started, not a message from the owner. Read the rest with \`job action=output id=${record.id}\` when you need it.`,
  ].join("\n");
}

export class Job {
  readonly record: JobRecord;
  private readonly killWork?: () => void;
  private readonly waiters = new Set<() => void>();
  private appends: Promise<void> = Promise.resolve();
  private settled = false;
  private killedByRequest = false;
  private truncated = false;

  constructor(record: JobRecord, kill?: () => void) {
    this.record = record;
    this.killWork = kill;
  }

  get id(): string {
    return this.record.id;
  }

  get running(): boolean {
    return this.record.status === "running";
  }

  /** The reader's side of a write: the file is drained in order, and a reader wakes on it. */
  append(text: string): void {
    if (!text || this.settled) return;
    if (this.record.chars >= MAX_JOB_CHARS) {
      if (this.truncated) return;
      this.truncated = true;
      text = TRUNCATION_NOTE;
    }
    this.record.chars += text.length;
    this.record.lastOutputAt = Date.now();
    const path = this.record.outputPath;
    this.appends = this.appends.then(() => appendFile(path, text, "utf-8")).catch((err: unknown) => {
      void log("error", "job: could not append its output", { jobId: this.record.id, error: String(err) });
    });
    this.wake();
  }

  settle(input: { status: JobStatus; exitCode?: number | null; signal?: string | null; note?: string }): void {
    if (this.settled) return;
    this.settled = true;
    // A kill is the cause whichever way the process reports it: a shell that traps nothing still
    // exits with a signal, and reading that as a failure would announce work the owner stopped.
    this.record.status = this.killedByRequest ? "killed" : input.status;
    this.record.endedAt = Date.now();
    if (input.exitCode !== undefined) this.record.exitCode = input.exitCode;
    if (input.signal !== undefined) this.record.signal = input.signal;
    if (input.note) this.record.note = input.note;
    this.wake();
  }

  /** Waits for the writer to reach the disk, so a caller that reads right after settling sees it. */
  async drained(): Promise<void> {
    await this.appends;
  }

  /** Resolves on the next append or settle, whichever comes first. */
  changed(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
    });
  }

  kill(): boolean {
    if (!this.running || !this.killWork) return false;
    this.killedByRequest = true;
    this.killWork();
    return true;
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }
}

export class JobRegistry {
  private live = new Map<string, Job>();
  private settledRecords = new Map<string, JobRecord>();
  private sink?: (record: JobRecord) => void;

  /** Where a finished job's notice goes. Registered by the boot, absent in tests and on the CLI. */
  setSink(sink: (record: JobRecord) => void): void {
    this.sink = sink;
  }

  async start(input: JobStart): Promise<Job> {
    const id = `job-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const dir = jobsDir(input.sessionId);
    await mkdir(dir, { recursive: true });
    const record: JobRecord = {
      id,
      sessionId: input.sessionId,
      tool: input.tool,
      label: input.label,
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      startedAt: Date.now(),
      lastOutputAt: Date.now(),
      status: "running",
      outputPath: jobLogPath(input.sessionId, id),
      chars: 0,
    };
    await writeFile(record.outputPath, "", "utf-8").catch(() => undefined);
    const job = new Job(record, input.kill);
    this.live.set(id, job);
    await this.persist(record);
    void log("info", "job started", {
      jobId: id,
      sessionId: input.sessionId,
      tool: input.tool,
      label: input.label.slice(0, 200),
      pid: input.pid,
    });
    return job;
  }

  /** The job, if it belongs to this session. Reading under someone else's id is never allowed. */
  async get(sessionId: string, id: string): Promise<Job | undefined> {
    const live = this.live.get(id);
    if (live) return live.record.sessionId === sessionId ? live : undefined;
    const known = this.settledRecords.get(id);
    if (known) return known.sessionId === sessionId ? this.hydrate(known) : undefined;
    const onDisk = await this.readRecord(sessionId, id);
    return onDisk ? this.hydrate(onDisk) : undefined;
  }

  /** This session's jobs, newest first: the live ones always, the settled ones when asked. */
  async list(sessionId: string, options: { includeSettled?: boolean } = {}): Promise<JobRecord[]> {
    if (options.includeSettled) await this.loadSettled(sessionId);
    const records = new Map<string, JobRecord>();
    for (const job of this.live.values()) {
      if (job.record.sessionId === sessionId) records.set(job.id, job.record);
    }
    if (options.includeSettled) {
      for (const record of this.settledRecords.values()) {
        if (record.sessionId === sessionId) records.set(record.id, record);
      }
    }
    return [...records.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  async output(
    sessionId: string,
    id: string,
    options: { offset?: number; maxChars?: number; waitMs?: number; signal?: AbortSignal } = {},
  ): Promise<JobRead | undefined> {
    const job = await this.get(sessionId, id);
    if (!job) return undefined;
    const offset = Math.max(0, options.offset ?? 0);
    const maxChars = Math.max(1, options.maxChars ?? 20_000);
    const deadline = Date.now() + Math.min(Math.max(0, options.waitMs ?? 0), MAX_WAIT_MS);
    for (;;) {
      await job.drained();
      const text = await this.readFrom(job.record, offset, maxChars);
      if (text.length > 0) return { text, offset: offset + text.length, record: job.record };
      if (!job.running) return { text: "", offset, record: job.record };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { text: "", offset, record: job.record };
      if (options.signal?.aborted) return { text: "", offset, record: job.record };
      await this.untilChanged(job, remaining, options.signal);
    }
  }

  async kill(sessionId: string, id: string): Promise<JobRecord | undefined> {
    const job = await this.get(sessionId, id);
    if (!job) return undefined;
    if (job.running && !job.kill()) {
      job.settle({ status: "killed", note: "nothing to signal: the job has no process of its own" });
      await this.finish(job);
      return job.record;
    }
    return job.record;
  }

  /** A Stop takes the conversation's work with it, backgrounded or not. */
  async killSession(sessionId: string): Promise<number> {
    let killed = 0;
    for (const job of [...this.live.values()]) {
      if (job.record.sessionId !== sessionId || !job.running) continue;
      killed += 1;
      if (job.kill()) continue;
      // Work with no process of its own has nothing to signal: it ends here, and its record must
      // say so or the conversation counts it as still running.
      job.settle({ status: "killed" });
      await this.finish(job);
    }
    return killed;
  }

  /** Live jobs of a session, for the surfaces that ask "is this conversation still working". */
  runningCount(sessionId: string): number {
    let count = 0;
    for (const job of this.live.values()) {
      if (job.record.sessionId === sessionId && job.running) count += 1;
    }
    return count;
  }

  /**
   * Ends a job and tells the conversation.
   *
   * The record and the notice are written before the entry that carries them, so a reader never
   * sees a job named by a message it cannot resolve.
   */
  async finish(job: Job): Promise<void> {
    if (!job.record.endedAt) job.settle({ status: job.record.status === "running" ? "done" : job.record.status });
    this.live.delete(job.id);
    this.settledRecords.set(job.id, job.record);
    await job.drained();
    await this.persist(job.record);
    void log("info", "job finished", {
      jobId: job.id,
      sessionId: job.record.sessionId,
      status: job.record.status,
      exitCode: job.record.exitCode,
      chars: job.record.chars,
      durationMs: (job.record.endedAt ?? Date.now()) - job.record.startedAt,
    });
    // A stopped job says nothing: the owner stopped it, or the run that killed it is the one that
    // would answer the notice -- and a stop that answers itself is a run nobody asked for. Its
    // output is on disk either way.
    if (job.record.status !== "killed") this.sink?.(job.record);
  }

  /** The tail of an output, for a notice that must not paste a build log into the prompt. */
  async tail(sessionId: string, id: string, chars = NOTICE_TAIL_CHARS): Promise<string> {
    const job = await this.get(sessionId, id);
    if (!job) return "";
    await job.drained();
    const text = await readFile(job.record.outputPath, "utf-8").catch(() => "");
    return text.length > chars ? `[... ${text.length - chars} chars elided ...]\n${text.slice(-chars)}` : text;
  }

  /**
   * After a restart, anything still marked running is not: our processes are gone with the server
   * that spawned them. Said once, at boot, so no card spins forever.
   */
  async reconcile(): Promise<number> {
    let lost = 0;
    // Sessions nest (`my-claw-app/thread/<owner>/<thread>`, `cron/<job>/<ts>`), so the tree is
    // walked rather than a flat list of ids being assumed.
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = join(dir, entry.name);
        if (entry.name === "jobs") {
          lost += await this.reconcileDir(child);
          continue;
        }
        await walk(child, depth + 1);
      }
    };
    await walk(SESSIONS_DIR, 0);
    if (lost > 0) void log("warn", "jobs: running ones found after a restart, marked lost", { lost });
    return lost;
  }

  private async reconcileDir(dir: string): Promise<number> {
    let lost = 0;
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const record = await this.parse(join(dir, file));
      if (!record || record.status !== "running") continue;
      record.status = "lost";
      record.endedAt = Date.now();
      record.note = "the server restarted while it was running; its output is what it wrote until then";
      await this.write(record);
      this.settledRecords.set(record.id, record);
      lost += 1;
    }
    return lost;
  }

  /** Test seam: forget everything without touching the disk. */
  clear(): void {
    this.live.clear();
    this.settledRecords.clear();
    this.sink = undefined;
  }

  private hydrate(record: JobRecord): Job {
    const job = new Job(record);
    if (record.status === "running") this.live.set(record.id, job);
    return job;
  }

  private async untilChanged(job: Job, remaining: number, signal?: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        resolve();
      };
      timer = setTimeout(done, remaining);
      timer.unref?.();
      if (signal) {
        onAbort = done;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      void job.changed().then(done);
    });
  }

  private async readFrom(record: JobRecord, offset: number, maxChars: number): Promise<string> {
    // The cursor counts chars, so the whole file is decoded: a byte window would split a multibyte
    // rune at the edge and hand back a replacement character in the middle of a log line. Job
    // outputs are build logs, not archives, and a read is rare.
    const whole = await readFile(record.outputPath, "utf-8").catch(() => "");
    if (offset >= whole.length) return "";
    return whole.slice(offset, offset + maxChars);
  }

  private async readRecord(sessionId: string, id: string): Promise<JobRecord | undefined> {
    if (!JOB_ID_PATTERN.test(id)) return undefined;
    return this.parse(jobRecordPath(sessionId, id));
  }

  private async loadSettled(sessionId: string): Promise<void> {
    const dir = jobsDir(sessionId);
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      if (this.settledRecords.has(id) || this.live.has(id)) continue;
      const record = await this.parse(join(dir, file));
      if (record && record.status !== "running") this.settledRecords.set(record.id, record);
    }
  }

  private async parse(path: string): Promise<JobRecord | undefined> {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as JobRecord;
      return typeof parsed?.id === "string" && typeof parsed?.sessionId === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async persist(record: JobRecord): Promise<void> {
    await mkdir(jobsDir(record.sessionId), { recursive: true }).catch(() => undefined);
    await this.write(record);
  }

  private async write(record: JobRecord): Promise<void> {
    try {
      await writeFile(jobRecordPath(record.sessionId, record.id), JSON.stringify(record, null, 1), "utf-8");
    } catch (err) {
      void log("error", "job: could not persist its record", { jobId: record.id, error: String(err) });
    }
  }
}

export const jobs = new JobRegistry();
