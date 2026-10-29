/**
 * The handoff a blocked run leaves behind -- docs/provider-failures.md.
 *
 * A run can die with nothing left to answer: the provider that would write the summary is the one
 * that refused. So the summary is not written by a model at all. It is read off the run's own tool
 * entries -- what settled, what failed, how many -- which is the only evidence nobody has to be
 * paid for. The rule that matters: an empty log never becomes "nothing happened".
 */

import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { blockedReportOf, describeBlocked, handoffCallsIn } from "../../src/subagents/blocked.ts";
import { sessionLogOf } from "../../src/sessions/log-access.ts";
import { deleteSession } from "../../src/sessions/store.ts";
import type { ToolEntry } from "../../src/sessions/log.ts";

const ID = "subagent/handoff-a1b2";
const made: string[] = [];

afterEach(async () => {
  for (const id of made.splice(0)) await deleteSession(id);
});

/** A fresh log with a question, a run start, and whatever tools the test wants. */
async function logWith(tools: Array<Partial<ToolEntry> & { name: string; ok: boolean }>): Promise<void> {
  made.push(ID);
  await deleteSession(ID);
  const log = await sessionLogOf(ID);
  log.append({ type: "user", prompt: true, text: "ship it" });
  log.append({ type: "run_start", prompt: false });
  tools.forEach((tool, i) => {
    log.append<ToolEntry>({
      type: "tool", prompt: true, callId: `c${i}`, args: {}, output: "…",
      truncated: false, runId: "t1", ...tool,
    });
  });
  await log.flush();
}

test("the calls the run settled are read off its log, in order, with their real exit state", async () => {
  await logWith([
    { name: "read", ok: true, durationMs: 12 },
    { name: "apply_patch", ok: true },
    { name: "bash", ok: false },
  ]);
  const calls = await handoffCallsIn(ID);
  assert.deepEqual(calls.map((c) => c.name), ["read", "apply_patch", "bash"]);
  assert.deepEqual(calls.map((c) => c.ok), [true, true, false]);
  assert.equal(calls[0]?.durationMs, 12);
});

/** Only the unanswered turn counts: an earlier turn's tools are not this run's work. */
test("calls from before the last question are not part of the handoff", async () => {
  made.push(ID);
  await deleteSession(ID);
  const log = await sessionLogOf(ID);
  log.append({ type: "user", prompt: true, text: "first" });
  log.append<ToolEntry>({ type: "tool", prompt: true, callId: "old", name: "read", args: {}, output: "", truncated: false, ok: true, runId: "t0" });
  log.append({ type: "run_start", prompt: false });
  log.append({ type: "run_end", prompt: false, reason: "done" });
  log.append({ type: "user", prompt: true, text: "second" });
  log.append({ type: "run_start", prompt: false });
  log.append<ToolEntry>({ type: "tool", prompt: true, callId: "new", name: "bash", args: {}, output: "x", truncated: false, ok: false, runId: "t1" });
  await log.flush();

  const calls = await handoffCallsIn(ID);
  assert.deepEqual(calls.map((c) => c.name), ["bash"], "the first turn's read is not this run's");
});

/** A call the run died under is `uncertain`, never silently counted as settled. */
test("an interrupted call is reported as uncertain, not as a success or a failure", async () => {
  await logWith([{ name: "bash", ok: true, interrupted: true }]);
  const [call] = await handoffCallsIn(ID);
  assert.equal(call?.uncertain, true);
});

test("a run that settled nothing hands off nothing, so the report keeps saying unknown", async () => {
  await logWith([]);
  assert.deepEqual(await handoffCallsIn(ID), []);
  const report = blockedReportOf({
    agentId: ID,
    err: Object.assign(new Error("usage_limit_reached"), { status: 429 }),
    toolsRan: false,
    calls: [],
  });
  assert.equal(report.handoff, undefined);
  assert.equal(report.partialWork, "unknown");
});

test("the report carries what got done and points at the failure, in fields", () => {
  const report = blockedReportOf({
    agentId: ID,
    err: Object.assign(new Error("usage_limit_reached"), { status: 429 }),
    toolsRan: true,
    calls: [{ name: "read", ok: true }, { name: "bash", ok: false }],
  });
  assert.equal(report.partialWork, "possible");
  assert.equal(report.handoff?.callCount, 2);
  assert.equal(report.handoff?.lastFailure?.name, "bash");
  const text = describeBlocked(report, "quota");
  assert.match(text, /It got through 2 tool calls: read, bash \(failed\)/);
  assert.match(text, /The last one to fail was bash/);
});

/** A cap keeps the receipt readable; the count still admits what it left out. */
test("a long run is capped, and the count says how much was left out", () => {
  const calls = Array.from({ length: 20 }, (_, i) => ({ name: `tool-${i}`, ok: true }));
  const report = blockedReportOf({
    agentId: ID,
    err: Object.assign(new Error("usage_limit_reached"), { status: 429 }),
    toolsRan: true,
    calls,
  });
  assert.equal(report.handoff?.calls.length, 12);
  assert.equal(report.handoff?.callCount, 20);
  assert.match(describeBlocked(report, "quota"), /and 8 earlier/);
});
