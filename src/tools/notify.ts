import type { Tool, ToolResult } from "./types.ts";
import { bool, str, strOpt } from "./types.ts";
import { cleanNotificationText, publishNotification } from "../notifications/push.ts";
import { currentRun } from "../utils/run-context.ts";
import { targetOfSession, type NotificationTarget } from "../notifications/target.ts";

/**
 * Where the tap lands, from the run this call is part of: the session it runs in, which is the
 * root's for a sub-agent too (the run context carries it down). A cron run opens as its own thread,
 * where the agent that rang is -- the job page it used to open listed the job and none of what it
 * said. Outside a run there is no place to name, and the notification opens the app.
 */
export function notifyTarget(): NotificationTarget | undefined {
  const run = currentRun();
  if (!run) return undefined;
  const target = targetOfSession(run.sessionId);
  if (target) return target;
  if (run.jobId) return { kind: "job", jobId: run.jobId };
  if (run.threadId) return { kind: "thread", threadId: run.threadId };
  return undefined;
}

/**
 * A push notification to the owner's own devices, sent by the agent rather than by the run.
 *
 * The owner asked for this to shout at him when something needs him: the ordinary notification is
 * a banner, and `ring` is a longer, more insistent one. Both obey the phone's own mode -- a ring is
 * quiet in silent like any notification, which the owner was explicit about -- and both exist as
 * completion notifications already: this one is the agent's own voice in between, and the
 * description says so, because a tool that can ring a phone is a tool an agent will overuse.
 */
export function createNotifyTool(): Tool {
  return {
    name: "notify",
    description: [
      "Send a push notification to the owner's devices. Use it to reach him between runs: a job that found something he should act on, a run that has to wait for him.",
      "`ring` makes the phone ring instead of buzzing: a longer, more insistent sound, still under the phone's own silent and vibrate settings. Reserve it for something he must act on now, and say why in the body: it is rate-limited to one ring every ten minutes, and an ordinary notification is what later rings become.",
      "Do not use it to report a run's own result -- that notification is sent for you when the run ends.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "What to tell the owner. Plain text, one or two sentences." },
        title: { type: "string", description: "Notification title. Defaults to my-claw." },
        ring: { type: "boolean", description: "Ring the phone instead of a banner. For something he must act on now." },
      },
      required: ["body"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const body = cleanNotificationText(str(args, "body")).slice(0, 400);
      if (!body) return { success: false, output: "", error: "notify: body is required" };
      const title = cleanNotificationText(strOpt(args, "title") ?? "").slice(0, 120) || "my-claw";
      const ring = bool(args, "ring", false);
      const target = notifyTarget();

      const outcome = await publishNotification({ title, body, ring, ...(target ? { target } : {}) });
      if (outcome.delivered === 0) {
        return { success: false, output: "", error: "notify: no device is registered for push notifications" };
      }
      const asked = ring ? (outcome.rang ? ", and it rang" : ", but it rang recently so this one is ordinary") : "";
      return { success: true, output: `notified ${outcome.delivered} device(s)${asked}` };
    },
  };
}
