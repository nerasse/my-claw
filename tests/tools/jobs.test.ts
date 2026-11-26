import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bashTool } from "../../src/tools/bash.ts";
import { jobTool } from "../../src/tools/job.ts";
import { jobNoticeText, jobs, type JobRecord } from "../../src/core/jobs.ts";
import { SESSIONS_DIR } from "../../src/sessions/paths.ts";

const JOB_ID = /job-[0-9a-f]{8}/;

/** A session of its own per test: the registry and its files are keyed by it. */
function session(name: string): string {
  return `my-claw-app/thread/neras/${name}`;
}

/** The end of a job, as the conversation would be told about it. */
function settled(): { wait: Promise<JobRecord>; sink: (record: JobRecord) => void; seen: JobRecord[] } {
  const seen: JobRecord[] = [];
  let resolve: (record: JobRecord) => void = () => {};
  const wait = new Promise<JobRecord>((r) => {
    resolve = r;
  });
  return {
    wait,
    seen,
    sink: (record) => {
      seen.push(record);
      resolve(record);
    },
  };
}

describe("bash hands a long command to a job", () => {
  test("past its yield the call answers with a job, and the output keeps landing in a file", async () => {
    const s = session("handoff");
    const end = settled();
    jobs.setSink(end.sink);

    const result = await bashTool.execute({ command: "echo early; sleep 1; echo late", yieldMs: 250, __sessionId: s });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("background");
    const id = JOB_ID.exec(result.output)?.[0] ?? "";
    expect(id).not.toBe("");
    expect(result.output).toContain("Do not sleep, poll or duplicate");

    const record = await end.wait;
    expect(record.id).toBe(id);
    expect(record.status).toBe("done");
    expect(record.exitCode).toBe(0);
    expect(readFileSync(record.outputPath, "utf-8")).toContain("late");
  });

  test("background returns at once, while the command is still running", async () => {
    const s = session("background");
    const end = settled();
    jobs.setSink(end.sink);

    const started = Date.now();
    const result = await bashTool.execute({ command: "sleep 2; echo done", background: true, __sessionId: s });
    const elapsed = Date.now() - started;

    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(1500);
    const id = JOB_ID.exec(result.output)?.[0] ?? "";
    const listed = await jobs.list(s);
    expect(listed.map((r) => r.id)).toContain(id);
    expect(listed[0]?.status).toBe("running");

    const record = await end.wait;
    expect(record.status).toBe("done");
  });

  test("a stop takes the job with it, and says nothing to the conversation", async () => {
    const s = session("stop");
    const end = settled();
    jobs.setSink(end.sink);
    const controller = new AbortController();

    const started = await bashTool.execute({ command: "sleep 30", background: true, __sessionId: s, __signal: controller.signal });
    const id = JOB_ID.exec(started.output)?.[0] ?? "";
    controller.abort();

    // The end of the job is its own event: read waits on it rather than on a clock.
    const read = await jobs.output(s, id, { waitMs: 3000 });
    expect(read?.record.status).toBe("killed");
    // A stopped job must not report into the conversation: that notice would open a run nobody
    // asked for, right after the Stop.
    expect(end.seen).toHaveLength(0);
  });

  test("the wall still kills, and the record says which wall", async () => {
    const s = session("wall");
    const end = settled();
    jobs.setSink(end.sink);

    await bashTool.execute({ command: "sleep 30", background: true, timeout: 1000, __sessionId: s });
    const record = await end.wait;

    expect(record.status).toBe("failed");
    expect(record.note ?? "").toContain("wall");
  });

  test("a short command never becomes a job", async () => {
    const s = session("short");
    const result = await bashTool.execute({ command: "echo quick", yieldMs: 5000, __sessionId: s });
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe("quick");
    expect(result.outcome).toBeUndefined();
    expect(await jobs.list(s, { includeSettled: true })).toHaveLength(0);
  });
});

describe("the job tool reads and stops", () => {
  test("output reads from a cursor, then says nothing is new", async () => {
    const s = session("read");
    const end = settled();
    jobs.setSink(end.sink);
    const started = await bashTool.execute({ command: "printf 'one\\ntwo\\n'", background: true, __sessionId: s });
    const id = JOB_ID.exec(started.output)?.[0] ?? "";
    await end.wait;

    const first = await jobTool.execute({ action: "output", id, __sessionId: s });
    expect(first.success).toBe(true);
    expect(first.output).toContain("one");
    expect(first.output).toContain("two");
    const offset = /\[next offset: (\d+)\]/.exec(first.output)?.[1];
    expect(offset).toBeDefined();

    const again = await jobTool.execute({ action: "output", id, offset: Number(offset), __sessionId: s });
    expect(again.output).toContain("(no new output)");
    expect(again.output).toContain("done");
  });

  test("list names this conversation's jobs only", async () => {
    const mine = session("list-mine");
    const other = session("list-other");
    const end = settled();
    jobs.setSink(end.sink);
    const started = await bashTool.execute({ command: "echo hi", background: true, __sessionId: mine });
    const id = JOB_ID.exec(started.output)?.[0] ?? "";
    await end.wait;

    const listed = await jobTool.execute({ action: "list", __sessionId: mine });
    expect(listed.output).toContain(id);
    const theirs = await jobTool.execute({ action: "list", __sessionId: other });
    expect(theirs.output).not.toContain(id);
    expect((await jobTool.execute({ action: "list", __sessionId: other })).output).toBe("(no background jobs)");
  });

  test("another conversation cannot read or kill it", async () => {
    const mine = session("fence-mine");
    const other = session("fence-other");
    const end = settled();
    jobs.setSink(end.sink);
    const started = await bashTool.execute({ command: "echo secret", background: true, __sessionId: mine });
    const id = JOB_ID.exec(started.output)?.[0] ?? "";
    await end.wait;

    const read = await jobTool.execute({ action: "output", id, __sessionId: other });
    expect(read.success).toBe(false);
    const kill = await jobTool.execute({ action: "kill", id, __sessionId: other });
    expect(kill.success).toBe(false);
  });
});

describe("records survive a restart honestly", () => {
  test("a job still marked running after a restart is lost, never spinning", async () => {
    const s = session("restart");
    const id = "job-0a1b2c3d";
    const dir = join(SESSIONS_DIR, s, "jobs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      id,
      sessionId: s,
      tool: "bash",
      label: "make build",
      startedAt: Date.now() - 60_000,
      lastOutputAt: Date.now() - 60_000,
      status: "running",
      outputPath: join(dir, `${id}.log`),
      chars: 0,
    }));

    await jobs.reconcile();

    const record = await jobs.get(s, id);
    expect(record?.record.status).toBe("lost");
    expect(record?.record.note ?? "").toContain("restarted");
  });
});

describe("what the conversation reads", () => {
  test("a notice is a tag, the tail, and where to get the rest", () => {
    const record: JobRecord = {
      id: "job-0a1b2c3d",
      sessionId: "s",
      tool: "bash",
      label: "cargo test --workspace",
      startedAt: Date.now() - 300_000,
      lastOutputAt: Date.now(),
      status: "failed",
      exitCode: 101,
      outputPath: "/tmp/x.log",
      chars: 12,
    };
    const text = jobNoticeText(record, "error[E0308]: mismatched types");
    expect(text).toContain('<job id="job-0a1b2c3d" status="failed" exit="101"');
    expect(text).toContain("mismatched types");
    expect(text).toContain("job action=output id=job-0a1b2c3d");
    expect(text).toContain("not a message from the owner");
  });
});
