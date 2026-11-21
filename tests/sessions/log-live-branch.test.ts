/**
 * The branch a run holds is the branch it appends to.
 *
 * A session with a compaction boundary rebuilds its context on every read, and a second handle on
 * the same conversation (a runner's marker, a cron delivery) makes the next read rebuild it into a
 * new array. The run kept the array it took at its start, so its own user turn -- appended after
 * both -- landed on the newer array. The prompt it built was its own branch without the question,
 * while the thread showed it: the owner sent a message the model never saw (measured in production
 * on 2026-11-21, thread 4d5775e7, message ff4ca8dd: four calls, all answering the previous turn).
 */

import { describe, expect, test, afterEach } from "bun:test";
import { setupSessionLog } from "../helpers/session-log.ts";
import { promptOf } from "../../src/sessions/projection.ts";
import { RunRecorder } from "../../src/agent/run-recorder.ts";
import { openSessionLog, type UserEntry } from "../../src/sessions/log.ts";

const SESSION_ID = "test/live-branch";
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** One owner turn, one answer, and a boundary that keeps the answer: a compacted session. */
async function compactedSession() {
  const setup = await setupSessionLog(SESSION_ID);
  cleanup = setup.cleanup;
  const { log } = setup;
  log.append<UserEntry>({ type: "user", prompt: true, text: "premier" });
  const answer = log.append({ type: "phase", prompt: true, text: "réponse", runId: "run-1" });
  log.append({
    type: "compaction",
    prompt: true,
    summary: "## Goal\n- premier",
    firstKeptEntryId: answer.id,
    tokensBefore: 1200,
    count: 1,
  });
  await log.flush();
  return { log };
}

describe("the context a run holds", () => {
  test("a second handle's write does not take the run's branch away", async () => {
    const { log } = await compactedSession();
    const run = await log.context();

    // Another part of the server holds its own handle on this conversation and files something.
    const other = await openSessionLog(SESSION_ID);
    other.append({ type: "command", prompt: false, input: "/status", output: "filed" });
    await other.flush();

    // A status report reads the same log while the run is still building its prompt.
    await log.context();

    new RunRecorder(log).user({ id: "question", text: "et ensuite ?", promptText: "<context/>\n\net ensuite ?" });
    await log.flush();

    const prompt = promptOf(run, run[run.length - 1]?.id ?? null);
    expect(prompt[prompt.length - 1]).toEqual({ role: "user", content: "<context/>\n\net ensuite ?" });
  });

  test("the run's array is the one a later read hands out", async () => {
    const { log } = await compactedSession();
    const run = await log.context();
    new RunRecorder(log).user({ id: "question-2", text: "deuxième" });
    const next = await log.context();
    expect(next).toBe(run);
    expect(next[next.length - 1]?.id).toBe("question-2");
    await log.flush();
  });
});
