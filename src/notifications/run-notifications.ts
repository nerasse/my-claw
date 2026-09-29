/**
 * The notifications a run and a job send when they end, fail or run long -- docs/notifications.md.
 *
 * Each one names its tap as a typed target derived from the session it is about (`target.ts`).
 * Out of index.ts so the wiring is testable: which run notifies, and where its tap lands.
 */

import type { UnifiedMessage } from "../channels/types.ts";
import { hooks } from "../hooks/index.ts";
import { cleanNotificationText, type PublishOutcome, type PushNotification } from "./push.ts";
import { targetOfSession } from "./target.ts";

export interface RunNotificationDeps {
  titleOf: (sessionId: string, fallback: string) => Promise<string>;
  publish: (notification: PushNotification, options?: { skipDevice?: (deviceId: string) => Promise<boolean> }) => Promise<PublishOutcome>;
  isForegroundOn: (deviceId: string, threadId: string) => Promise<boolean>;
}

/** Registers the hooks; returns what unregisters them (tests). */
export function registerRunNotifications(deps: RunNotificationDeps): () => void {
  const { titleOf: threadTitle, publish: publishNotification, isForegroundOn } = deps;
  const offs: Array<() => void> = [];
  const on: typeof hooks.on = ((event: never, handler: never) => {
    hooks.on(event, handler);
    offs.push(() => hooks.off(event, handler));
  }) as typeof hooks.on;
  const formatDuration = (ms: number): string => {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  // A conversation's run only: a cron run goes through the router too, and this used to announce
  // it a second time, linked to `thread/default` -- its message has no thread -- which opened an
  // empty conversation. A job has its own notifications below, linked to its run.
  const conversationRun = (message: UnifiedMessage, sessionId: string): { threadId: string } | undefined => {
    if (message.platform !== "my-claw-app") return undefined;
    const target = targetOfSession(sessionId);
    return target?.kind === "thread" ? { threadId: target.threadId } : undefined;
  };
  on("message:route:complete", ({ message, sessionId, response, durationMs }) => {
    const run = conversationRun(message, sessionId);
    if (!run) return;
    void threadTitle(sessionId, message.text).then((title) =>
      publishNotification(
        {
          title,
          body: `Run finished in ${formatDuration(durationMs)}: ${cleanNotificationText(response).slice(0, 160)}`,
          target: { kind: "thread", threadId: run.threadId },
        },
        // The one case the user chose to stay silent: a device that is already looking at
        // the very thread that just finished (the stream is on screen).
        { skipDevice: (deviceId) => isForegroundOn(deviceId, run.threadId) },
      ),
    );
  });
  on("message:route:error", ({ message, sessionId, error, durationMs }) => {
    const run = conversationRun(message, sessionId);
    if (!run) return;
    void threadTitle(sessionId, message.text).then((title) =>
      publishNotification(
        {
          title,
          body: `Run failed after ${formatDuration(durationMs)}: ${cleanNotificationText(String(error)).slice(0, 200)}`,
          target: { kind: "thread", threadId: run.threadId },
        },
        { skipDevice: (deviceId) => isForegroundOn(deviceId, run.threadId) },
      ),
    );
  });
  // Silent jobs suppress their output by design; a completion notification would be just as
  // noisy, so it is skipped with the delivery.
  // The tap opens the run itself: its result, its tools, its Continue. The jobs page listed the
  // job and nothing of what it just did.
  on("cron:job:end", ({ jobId, jobName, sessionId, success, silent }) => {
    if (silent) return;
    void publishNotification({
      title: jobName,
      body: success ? "Job finished" : "Job failed",
      target: targetOfSession(sessionId) ?? { kind: "job", jobId },
    });
  });
  // A run still going past its alert time: announced every interval, whatever `silent` says --
  // a job that runs that long is the one the owner has to decide about. The tap opens the run
  // itself, where its Stop is. docs/cron.md.
  on("cron:job:long", ({ jobId, jobName, sessionId, runningMs, working, depth, costUsd }) => {
    const hours = Math.floor(runningMs / 3_600_000);
    const minutes = Math.round((runningMs % 3_600_000) / 60_000);
    const span = hours > 0 ? `${hours} h${minutes > 0 ? ` ${minutes} min` : ""}` : `${minutes} min`;
    const doing = working > 0 ? `${working} sub-agent${working > 1 ? "s" : ""} working, ${depth} level${depth > 1 ? "s" : ""} deep` : "no sub-agent working";
    const spent = costUsd !== undefined ? ` · $${costUsd.toFixed(2)}` : "";
    void publishNotification({
      title: jobName,
      body: `Still running after ${span} · ${doing}${spent}. Open it to follow it or stop it.`,
      target: targetOfSession(sessionId) ?? { kind: "job", jobId },
    });
  });
  // A silent job stays silent when it fails: it used to notify anyway, which made "silent"
  // useless for the failing job that needed it most.
  on("cron:job:error", ({ jobId, jobName, sessionId, error, silent }) => {
    if (silent) return;
    void publishNotification({
      title: jobName,
      body: `Job failed: ${cleanNotificationText(String(error)).slice(0, 200)}`,
      target: targetOfSession(sessionId) ?? { kind: "job", jobId },
    });
  });

  return () => {
    for (const off of offs.splice(0)) off();
  };
}
