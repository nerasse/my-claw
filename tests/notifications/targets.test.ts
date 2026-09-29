/**
 * Every notification's tap lands where it is about -- docs/notifications.md.
 *
 * A cron run's end used to be announced twice: by the job, linked to the jobs page, and by the
 * generic run hook, linked to `myclaw://thread/default` because a cron message has no thread --
 * an empty conversation. The targets are typed and derived from the session now; these tests run
 * the real hooks and read the link each notification carries.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { hooks } from "../../src/hooks/index.ts";
import { registerRunNotifications } from "../../src/notifications/run-notifications.ts";
import { buildPushPayload, type PushNotification } from "../../src/notifications/push.ts";
import { linkOf, targetOfSession } from "../../src/notifications/target.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

const RUN = "cron/0123456789ab/1790658020173";
const sent: PushNotification[] = [];
let off: () => void;
beforeEach(() => {
  sent.length = 0;
  off = registerRunNotifications({
    titleOf: async (_s, fallback) => fallback || "t",
    publish: async (n) => { sent.push(n); return { delivered: 1, rang: false }; },
    isForegroundOn: async () => false,
  });
});
afterEach(() => off());

const settle = () => new Promise((r) => setTimeout(r, 0));
const linkOfSent = (n: PushNotification | undefined) => JSON.parse(buildPushPayload(n!)).url as string | undefined;
const message = (platform: UnifiedMessage["platform"], threadId?: string): UnifiedMessage => ({
  id: "m", platform, userId: "neras", chatId: "neras", chatType: "dm", text: "veille", attachments: [], isForwarded: false, raw: {},
  ...(threadId ? { threadId } : {}),
});

test("a session names its place: a conversation, a cron run, or nothing a screen shows", () => {
  expect(targetOfSession("my-claw-app/thread/neras/4d5775e7-d5ac")).toEqual({ kind: "thread", threadId: "4d5775e7-d5ac" });
  expect(targetOfSession(RUN)).toEqual({ kind: "thread", threadId: "cron-0123456789ab-1790658020173" });
  expect(targetOfSession("subagent/veille-L3-e88b")).toBeUndefined();
  expect(targetOfSession("my-claw-app/dm/neras")).toBeUndefined();
  expect(linkOf({ kind: "thread", threadId: "cron-0123456789ab-1" })).toBe("myclaw://thread/cron-0123456789ab-1");
});

test("a cron run's end is announced once, by the job, and its tap opens the run", async () => {
  hooks.emit("message:route:complete", { message: message("cron"), sessionId: RUN, response: "Veille du 29/09", durationMs: 1000 });
  hooks.emit("cron:job:end", { jobId: "0123456789ab", jobName: "veille", sessionId: RUN, success: true, silent: false, durationMs: 1000 });
  await settle();
  expect(sent).toHaveLength(1);
  expect(linkOfSent(sent[0])).toBe("myclaw://thread/cron-0123456789ab-1790658020173");
  expect(sent.map(linkOfSent)).not.toContain("myclaw://thread/default");
});

test("a failed job and a long one open the run too", async () => {
  hooks.emit("cron:job:error", { jobId: "0123456789ab", jobName: "veille", sessionId: RUN, error: new Error("x"), silent: false });
  hooks.emit("cron:job:long", { jobId: "0123456789ab", jobName: "veille", sessionId: RUN, runningMs: 3 * 3_600_000, working: 2, depth: 2 });
  await settle();
  expect(sent.map(linkOfSent)).toEqual(["myclaw://thread/cron-0123456789ab-1790658020173", "myclaw://thread/cron-0123456789ab-1790658020173"]);
});

test("a conversation's run opens that conversation", async () => {
  hooks.emit("message:route:complete", { message: message("my-claw-app", "t-9"), sessionId: "my-claw-app/thread/neras/t-9", response: "ok", durationMs: 5 });
  hooks.emit("message:route:error", { message: message("my-claw-app", "t-9"), sessionId: "my-claw-app/thread/neras/t-9", error: new Error("boom"), durationMs: 5 });
  await settle();
  expect(sent.map(linkOfSent)).toEqual(["myclaw://thread/t-9", "myclaw://thread/t-9"]);
});
