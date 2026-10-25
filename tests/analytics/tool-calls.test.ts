import { test, expect, beforeEach } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyticsDb } from "../../src/analytics/usage-db.ts";
import { backfillToolCalls, errorKind, recordToolCall, toolStats } from "../../src/analytics/tool-calls.ts";

/**
 * The tool telemetry: what the model was told about each call, ranked, with what it did next.
 * docs/tool-telemetry.md.
 */

beforeEach(() => {
  recordToolCall({ sessionId: "warm", caller: "orchestrator", tool: "warm", ok: true, durationMs: 0 });
  const d = analyticsDb();
  d.run("DELETE FROM tool_calls");
  d.run("DELETE FROM analytics_meta");
});

function at(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

test("a failure followed by the same tool is a retry, by another tool a switch", () => {
  recordToolCall({ sessionId: "a", caller: "orchestrator", tool: "apply_patch", ok: false, durationMs: 10, error: "Error: edits[0]: anchor not found in /x/y.ts", at: at(5) });
  recordToolCall({ sessionId: "a", caller: "orchestrator", tool: "apply_patch", ok: false, durationMs: 10, error: "Error: edits[0]: anchor not found in /x/z.ts", at: at(4) });
  recordToolCall({ sessionId: "a", caller: "orchestrator", tool: "bash", ok: true, durationMs: 30, at: at(3) });
  // Another conversation: its next call is not the answer to session a's failure.
  recordToolCall({ sessionId: "b", caller: "subagent", tool: "apply_patch", ok: false, durationMs: 10, error: "Error: other", at: at(2) });

  const patch = toolStats("7d").rows.find((r) => r.tool === "apply_patch")!;
  expect(patch.calls).toBe(3);
  expect(patch.failures).toBe(3);
  expect(patch.retried).toBe(1);
  expect(patch.switched).toBe(1);
  // Two files, one failure kind.
  expect(patch.topErrors[0]).toEqual({ kind: "edits[0]: anchor not found in <path>", count: 2 });
});

test("outcomes count the successes a tool read out of an exit 1", () => {
  recordToolCall({ sessionId: "a", caller: "orchestrator", tool: "bash", ok: true, durationMs: 5, outcome: "no-match" });
  recordToolCall({ sessionId: "a", caller: "orchestrator", tool: "bash", ok: true, durationMs: 5, outcome: "no-match" });
  recordToolCall({ sessionId: "a", caller: "orchestrator", tool: "bash", ok: true, durationMs: 5 });
  const bash = toolStats("7d").rows.find((r) => r.tool === "bash")!;
  expect(bash.failures).toBe(0);
  expect(bash.outcomes).toEqual({ "no-match": 2 });
});

test("the period and the conversation narrow the rows", () => {
  recordToolCall({ sessionId: "old", caller: "orchestrator", tool: "read", ok: true, durationMs: 1, at: at(60 * 24 * 10) });
  recordToolCall({ sessionId: "new", caller: "orchestrator", tool: "read", ok: true, durationMs: 1, at: at(1) });
  recordToolCall({ sessionId: "other", caller: "subagent", tool: "read", ok: true, durationMs: 1, at: at(1) });
  expect(toolStats("7d").rows[0]!.calls).toBe(2);
  expect(toolStats("all").rows[0]!.calls).toBe(3);
  expect(toolStats("all", { sessionId: "new" }).rows[0]!.calls).toBe(1);
  expect(toolStats("all", { caller: "subagent" }).rows[0]!.calls).toBe(1);
});

test("an error is stored as its kind: first line, no paths, no ids", () => {
  expect(errorKind("Error: Command failed with exit code 1.\n\nSTDERR: grep: secret contents")).toBe("Command failed with exit code 1.");
  expect(errorKind("Error: File not found: /home/neras/x.ts. Create it with write.")).toBe("File not found: <path> Create it with write.");
  expect(errorKind("Error: run 0fe89164d9 failed after 12345 ms")).toBe("run <id> failed after <n> ms");
  expect(errorKind("Error: Error: HTTP 404 from https://x.dev/a?b=1. Check the URL.")).toBe("HTTP 404 from <url> Check the URL.");
});

test("the backfill reads the logs older than the table, once", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-backfill-"));
  const dir = join(root, "my-claw-app", "thread", "neras", "t1");
  await mkdir(dir, { recursive: true });
  // The cutoff is fixed by the first touch of the table (beforeEach): a log entry after it is the
  // live recorder's, and must not be read twice.
  const old = Date.now() - 60_000;
  const lines = [
    { type: "user", text: "hi", ts: old },
    { type: "tool", name: "bash", ok: false, durationMs: 40, output: "Error: Command failed with exit code 1.", ts: old },
    { type: "tool", name: "read", ok: true, durationMs: 3, output: "secret file contents", ts: old },
    { type: "tool", name: "read", ok: true, durationMs: 3, output: "after the cutoff", ts: Date.now() + 60_000 },
  ];
  // The imported logs carry a space after the colon; both spellings are read.
  const body = lines.map((l, i) => (i === 2 ? JSON.stringify(l, null, 0).replace('"type":"tool"', '"type": "tool"') : JSON.stringify(l))).join("\n");
  await writeFile(join(dir, "entries.jsonl"), `${body}\n`);

  expect(await backfillToolCalls(root)).toBe(2);
  expect(await backfillToolCalls(root)).toBe(0);

  const stats = toolStats("all");
  expect(stats.backfilled).toBe(true);
  const rows = analyticsDb().query("SELECT session_id, caller, tool, ok, error FROM tool_calls ORDER BY tool").all();
  expect(rows).toEqual([
    { session_id: "my-claw-app/thread/neras/t1", caller: "orchestrator", tool: "bash", ok: 0, error: "Command failed with exit code 1." },
    { session_id: "my-claw-app/thread/neras/t1", caller: "orchestrator", tool: "read", ok: 1, error: null },
  ]);
});
