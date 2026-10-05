import type { CronDeliver, CronJob } from "../../cron/types.ts";
import type { MyClawAppJobEntry, MyClawAppJobSave } from "./types.ts";

/**
 * The job settings the app's editor sets beside the store's own update path: where the report
 * goes, the duration alert, the hard limit and the conversation archive -- docs/cron.md.
 */

/**
 * The delivery a save asks for, as the store's deliver string. Undefined leaves the job's as it
 * is. A thread is the owner's conversation of that title, created in the job's workspace if
 * missing (`ensureThread`, the same one `deliver: "thread:<title>"` uses in the cron tool).
 */
export async function deliverOfSave(
  wanted: MyClawAppJobSave["deliver"],
  job: Pick<CronJob, "origin" | "workspace"> | undefined,
  owner: string,
  workspace: string | undefined,
  ensureThread: (owner: string, title: string, workspace?: string) => Promise<string>,
): Promise<string | undefined> {
  if (wanted === undefined) return undefined;
  if (wanted.kind === "local") return "local";
  if (wanted.kind === "origin") {
    if (!job?.origin) throw new Error("this job has no conversation of origin to deliver to");
    return "origin";
  }
  const title = wanted.title.trim();
  if (!title) throw new Error("a conversation name is required");
  const threadId = await ensureThread(owner, title, workspace || job?.workspace);
  return `my-claw-app:${owner}:${threadId}`;
}

/** Absent: don't touch. 0 or false: back to the install's own. */
export function applyRunLimits(job: CronJob, fields: Pick<MyClawAppJobSave, "alertAfterMs" | "timeoutMs" | "conversations">): void {
  if (fields.alertAfterMs !== undefined) {
    if (fields.alertAfterMs > 0) job.alertAfterMs = fields.alertAfterMs;
    else delete job.alertAfterMs;
  }
  if (fields.timeoutMs !== undefined) {
    if (fields.timeoutMs > 0) job.timeoutMs = fields.timeoutMs;
    else delete job.timeoutMs;
  }
  if (fields.conversations !== undefined) {
    if (fields.conversations) job.conversations = true;
    else delete job.conversations;
  }
}

/**
 * The listing's half of the same fields. `threadTitle` is the title of the conversation a thread
 * delivery points at, when it is one of the owner's: a target that is not (another address) is
 * `target`, shown and left alone.
 */
export function runLimitsOfJob(
  job: CronJob,
  threadTitle: string | undefined,
  install: { alertAfterMs: number; timeoutMs?: number },
): Pick<MyClawAppJobEntry, "alertAfterMs" | "defaultAlertAfterMs" | "defaultTimeoutMs" | "conversations" | "hasOrigin" | "deliverKind" | "deliverThread"> {
  return {
    ...(job.alertAfterMs ? { alertAfterMs: job.alertAfterMs } : {}),
    defaultAlertAfterMs: install.alertAfterMs,
    ...(install.timeoutMs ? { defaultTimeoutMs: install.timeoutMs } : {}),
    conversations: job.conversations === true,
    hasOrigin: job.origin !== null,
    deliverKind: deliverKindOf(job.deliver, threadTitle),
    ...(threadTitle ? { deliverThread: threadTitle } : {}),
  };
}

function deliverKindOf(deliver: CronDeliver, threadTitle: string | undefined): NonNullable<MyClawAppJobEntry["deliverKind"]> {
  if (deliver === "origin" || deliver === "local") return deliver;
  return threadTitle ? "thread" : "target";
}

/** The owner's app conversation a delivery points at, or undefined for anything else. */
export function deliveryThreadOf(deliver: CronDeliver): string | undefined {
  if (typeof deliver === "string" || deliver.platform !== "my-claw-app" || !deliver.threadId) return undefined;
  return `my-claw-app/thread/${deliver.chatId}/${deliver.threadId}`;
}
