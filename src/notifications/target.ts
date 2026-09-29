/**
 * Where a notification's tap lands -- docs/notifications.md.
 *
 * A place the app can open, typed: a thread (a conversation, or a cron run, which the app opens as
 * a chat) or a job. Never a string a caller assembles: each emitter used to build its own
 * `myclaw://...` by hand, and a cron run, which has no thread of its own on its message, built
 * `myclaw://thread/default` -- an empty conversation. The link is derived from the session the
 * notification is about, which is the one thing every emitter has.
 */

import { cronSessionToThread } from "../sessions/store.ts";

export type NotificationTarget =
  | { kind: "thread"; threadId: string }
  | { kind: "job"; jobId: string };

const APP_THREAD = /^my-claw-app\/thread\/[^/]+\/([A-Za-z0-9._-]{1,64})$/;
const CRON_JOB = /^cron\/([0-9a-f]{12})$/;

/**
 * The place a session is opened at, or undefined for one no screen shows (a sub-agent reached only
 * through its parent, a channel with no app thread). A notification without a target opens the
 * app as it is, which is honest; one aimed at a guess opens the wrong conversation.
 */
export function targetOfSession(sessionId: string | undefined): NotificationTarget | undefined {
  if (!sessionId) return undefined;
  const run = cronSessionToThread(sessionId);
  if (run) return { kind: "thread", threadId: run };
  const thread = APP_THREAD.exec(sessionId)?.[1];
  if (thread) return { kind: "thread", threadId: thread };
  const job = CRON_JOB.exec(sessionId)?.[1];
  if (job) return { kind: "job", jobId: job };
  return undefined;
}

/**
 * The wire form. A contract with the app's `parseNotificationLink`, and with its
 * `dismissThreadNotification`, which recomputes a thread's notification id from this very string.
 */
export function linkOf(target: NotificationTarget): string {
  switch (target.kind) {
    case "thread":
      return `myclaw://thread/${encodeURIComponent(target.threadId)}`;
    case "job":
      return `myclaw://job/${encodeURIComponent(target.jobId)}`;
  }
}
