import { describe, test, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  approvalStats,
  closeApprovalStore,
  listApprovals,
  recordApproval,
  serializeArgs,
  type ApprovalOutcome,
} from "../../src/approvals/store.ts";

const dbPath = join(tmpdir(), `approvals-test-${process.pid}.db`);
process.env["MY_CLAW_APPROVALS_DB"] = dbPath;

afterEach(() => {
  closeApprovalStore();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
});

let seq = 0;
function record(over: Partial<Parameters<typeof recordApproval>[0]> = {}) {
  seq += 1;
  const at = new Date(Date.UTC(2026, 7, 21, 10, 0, seq)).toISOString();
  return {
    id: `a${seq}`,
    owner: "neras",
    threadId: "t1",
    sessionId: "my-claw-app/thread/neras/t1",
    toolName: "bash",
    args: '{"command":"ls"}',
    outcome: "allow-once" as ApprovalOutcome,
    requestedAt: at,
    decidedAt: at,
    durationMs: 1200,
    auto: false,
    ...over,
  };
}

describe("approval journal", () => {
  test("a decision survives a round trip with its grant kind intact", () => {
    recordApproval(record({ outcome: "allow-session", toolName: "write" }));

    const [entry] = listApprovals({ owner: "neras" });
    expect(entry?.toolName).toBe("write");
    // allow-once and allow-session are the same click but not the same grant: the journal is
    // the only place that can tell them apart afterwards.
    expect(entry?.outcome).toBe("allow-session");
    expect(entry?.durationMs).toBe(1200);
  });

  test("newest first, so the history reads as a timeline", () => {
    recordApproval(record({ toolName: "first" }));
    recordApproval(record({ toolName: "second" }));

    expect(listApprovals({ owner: "neras" }).map((e) => e.toolName)).toEqual(["second", "first"]);
  });

  test("one owner never sees another owner's decisions", () => {
    recordApproval(record({ owner: "neras", toolName: "mine" }));
    recordApproval(record({ owner: "someone-else", toolName: "theirs" }));

    expect(listApprovals({ owner: "neras" }).map((e) => e.toolName)).toEqual(["mine"]);
  });

  test("a thread filter narrows to that conversation", () => {
    recordApproval(record({ threadId: "t1", toolName: "here" }));
    recordApproval(record({ threadId: "t2", toolName: "elsewhere" }));

    expect(listApprovals({ owner: "neras", threadId: "t2" }).map((e) => e.toolName)).toEqual(["elsewhere"]);
  });

  test("a device answering twice does not write the decision twice", () => {
    // Two windows, or a reconnect replaying its outbox: the same id must land once.
    recordApproval(record({ id: "same", outcome: "allow-once" }));
    recordApproval(record({ id: "same", outcome: "deny" }));

    const entries = listApprovals({ owner: "neras" });
    expect(entries).toHaveLength(1);
    // First write wins: the later frame is a duplicate, not a change of mind.
    expect(entries[0]?.outcome).toBe("allow-once");
  });

  test("paging with a cursor walks backwards without repeating an entry", () => {
    recordApproval(record({ toolName: "oldest" }));
    recordApproval(record({ toolName: "middle" }));
    recordApproval(record({ toolName: "newest" }));

    const firstPage = listApprovals({ owner: "neras", limit: 2 });
    expect(firstPage.map((e) => e.toolName)).toEqual(["newest", "middle"]);

    const next = listApprovals({ owner: "neras", before: firstPage[firstPage.length - 1]!.decidedAt });
    expect(next.map((e) => e.toolName)).toEqual(["oldest"]);
  });

  test("the stats count grants, refusals and unanswered prompts apart", () => {
    recordApproval(record({ outcome: "allow-once" }));
    recordApproval(record({ outcome: "allow-session" }));
    recordApproval(record({ outcome: "deny" }));
    recordApproval(record({ outcome: "expired" }));
    // A shutdown under an open prompt is not a refusal by the owner.
    recordApproval(record({ outcome: "cancelled" }));

    expect(approvalStats("neras")).toEqual({ total: 5, allowed: 2, denied: 1, expired: 2 });
  });

  test("an auto grant is recorded as such, since nothing was shown to anyone", () => {
    recordApproval(record({ outcome: "allow-session", auto: true }));
    expect(listApprovals({ owner: "neras" })[0]?.auto).toBe(true);
  });

  test("stats of an owner with no history are zero, not a crash", () => {
    expect(approvalStats("nobody")).toEqual({ total: 0, allowed: 0, denied: 0, expired: 0 });
  });

  test("a huge argument list is truncated, and says so", () => {
    const serialized = serializeArgs({ blob: "x".repeat(20_000) });
    expect(serialized.length).toBeLessThan(5000);
    expect(serialized).toContain("truncated");
  });

  test("an unserializable argument costs the value, never the audit line", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => serializeArgs(cyclic)).not.toThrow();
    expect(serializeArgs(cyclic)).toContain("unserializable");
  });

  test("the limit is capped so a device cannot ask for the whole table", () => {
    for (let i = 0; i < 5; i += 1) recordApproval(record());
    expect(listApprovals({ owner: "neras", limit: 100_000 }).length).toBe(5);
    expect(listApprovals({ owner: "neras", limit: 0 }).length).toBe(1);
  });
});
