import { describe, expect, test } from "bun:test";
import { applyRunLimits, deliverOfSave, deliveryThreadOf, runLimitsOfJob } from "../../../src/channels/my-claw-app/job-fields.ts";
import type { CronJob } from "../../../src/cron/types.ts";

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: "j1", name: "n", prompt: "p", schedule: { kind: "cron", expr: "0 8 * * *", display: "0 8 * * *" },
    repeat: null, completedRuns: 0, enabled: true, state: "scheduled", origin: null, deliver: "local",
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null, createdAt: "2026-10-05T00:00:00.000Z",
    ...over,
  } as CronJob;
}

describe("the delivery a save asks for", () => {
  const threads: Array<[string, string, string | undefined]> = [];
  const ensure = async (owner: string, title: string, workspace?: string) => {
    threads.push([owner, title, workspace]);
    return "t-1";
  };

  test("absent leaves the job's own, local is local", async () => {
    expect(await deliverOfSave(undefined, job(), "neras", undefined, ensure)).toBeUndefined();
    expect(await deliverOfSave({ kind: "local" }, job(), "neras", undefined, ensure)).toBe("local");
  });

  test("a conversation by its title, made in the job's workspace, for the owner who saved", async () => {
    threads.length = 0;
    const deliver = await deliverOfSave({ kind: "thread", title: "  Crons career " }, job({ workspace: "career" }), "neras", undefined, ensure);
    expect(deliver).toBe("my-claw-app:neras:t-1");
    expect(threads).toEqual([["neras", "Crons career", "career"]]);
    // The workspace the save names wins over the job's: the job is moving with it.
    await deliverOfSave({ kind: "thread", title: "x" }, job({ workspace: "career" }), "neras", "dev", ensure);
    expect(threads.at(-1)?.[2]).toBe("dev");
  });

  test("origin needs a conversation of origin, a thread needs a name", async () => {
    await expect(deliverOfSave({ kind: "origin" }, job(), "neras", undefined, ensure)).rejects.toThrow("no conversation of origin");
    expect(await deliverOfSave({ kind: "origin" }, job({ origin: { platform: "my-claw-app", chatId: "neras" } }), "neras", undefined, ensure)).toBe("origin");
    await expect(deliverOfSave({ kind: "thread", title: " " }, job(), "neras", undefined, ensure)).rejects.toThrow("name is required");
  });
});

describe("the alert, the limit and the archive", () => {
  test("absent leaves, a value sets, zero and false clear back to the install's", () => {
    const j = job({ alertAfterMs: 3_600_000, timeoutMs: 7_200_000, conversations: true });
    applyRunLimits(j, {});
    expect([j.alertAfterMs, j.timeoutMs, j.conversations]).toEqual([3_600_000, 7_200_000, true]);
    applyRunLimits(j, { alertAfterMs: 600_000, timeoutMs: 0, conversations: false });
    expect(j.alertAfterMs).toBe(600_000);
    expect("timeoutMs" in j).toBe(false);
    expect("conversations" in j).toBe(false);
    applyRunLimits(j, { alertAfterMs: 0, timeoutMs: 60_000, conversations: true });
    expect("alertAfterMs" in j).toBe(false);
    expect([j.timeoutMs, j.conversations]).toEqual([60_000, true]);
  });

  test("the listing says which delivery the editor shows, and the install's defaults beside the job's", () => {
    const thread = job({ deliver: { platform: "my-claw-app", chatId: "neras", threadId: "t-1" }, alertAfterMs: 10_800_000 });
    expect(runLimitsOfJob(thread, "Crons career", { alertAfterMs: 3_600_000 })).toEqual({
      alertAfterMs: 10_800_000,
      defaultAlertAfterMs: 3_600_000,
      conversations: false,
      hasOrigin: false,
      deliverKind: "thread",
      deliverThread: "Crons career",
    });
    // An address that is no conversation of the owner's is shown, never turned into one.
    expect(runLimitsOfJob(job({ deliver: { platform: "my-claw-app", chatId: "neras" } }), undefined, { alertAfterMs: 1, timeoutMs: 5 }).deliverKind).toBe("target");
    expect(runLimitsOfJob(job({ deliver: "origin", origin: { platform: "my-claw-app", chatId: "neras" } }), undefined, { alertAfterMs: 1, timeoutMs: 5 })).toMatchObject({ deliverKind: "origin", hasOrigin: true, defaultTimeoutMs: 5 });
    expect(deliveryThreadOf({ platform: "my-claw-app", chatId: "neras", threadId: "t-1" })).toBe("my-claw-app/thread/neras/t-1");
    expect(deliveryThreadOf("local")).toBeUndefined();
  });
});
