import { test } from "bun:test";
import assert from "node:assert/strict";
import { runRegistry, RerouteSignal, FoldedRunError, MAX_INJECTIONS_PER_RUN } from "../../src/core/run-registry.ts";
import { AbortedError } from "../../src/core/aborted.ts";
import { IterationBudget } from "../../src/agent/iteration-budget.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

function msg(id: string): UnifiedMessage {
  return { id, platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text: id, attachments: [], isForwarded: false, raw: {} };
}

test("enqueueInjection returns null when no run is active", () => {
  runRegistry.clear();
  assert.equal(runRegistry.enqueueInjection("s1", msg("a")), null);
});

test("enqueue while running returns a promise that resolves at run end", async () => {
  runRegistry.clear();
  const { end } = runRegistry.startRoot("s1");
  const p = runRegistry.enqueueInjection("s1", msg("a"));
  assert.ok(p);

  assert.deepEqual(runRegistry.drainInjections("s1").map((m) => m.id), ["a"]);

  let resolved = false;
  void p!.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false); // stays pending until the run settles

  runRegistry.settleMailbox("s1", "resolve");
  await p; // resolves now
  end();
  runRegistry.clear();
});

test("drainInjections moves pending to claimed and keeps the mailbox open", () => {
  runRegistry.clear();
  runRegistry.startRoot("s1");
  void runRegistry.enqueueInjection("s1", msg("a"));
  assert.deepEqual(runRegistry.drainInjections("s1").map((m) => m.id), ["a"]);
  assert.deepEqual(runRegistry.drainInjections("s1"), []); // drained
  assert.ok(runRegistry.enqueueInjection("s1", msg("b"))); // still accepting
  runRegistry.clear();
});

test("drainOrClose closes the mailbox when nothing is pending", () => {
  runRegistry.clear();
  runRegistry.startRoot("s1");
  assert.deepEqual(runRegistry.drainOrClose("s1"), []);
  // closed -> late arrivals fall back to a new run
  assert.equal(runRegistry.enqueueInjection("s1", msg("late")), null);
  runRegistry.clear();
});

test("drainOrClose keeps the mailbox open when there are pending items", () => {
  runRegistry.clear();
  runRegistry.startRoot("s1");
  void runRegistry.enqueueInjection("s1", msg("a"));
  assert.deepEqual(runRegistry.drainOrClose("s1").map((m) => m.id), ["a"]);
  assert.ok(runRegistry.enqueueInjection("s1", msg("b"))); // still accepting
  runRegistry.clear();
});

test("settleMailbox reject rejects the claimed injection promise", async () => {
  runRegistry.clear();
  runRegistry.startRoot("s1");
  const p = runRegistry.enqueueInjection("s1", msg("a"))!;
  runRegistry.drainInjections("s1");
  runRegistry.settleMailbox("s1", "reject", new Error("boom"));
  await assert.rejects(p, /boom/);
  runRegistry.clear();
});

test("a claimed injection learns the run's error as a folded one, not as its own to report", async () => {
  // The folded message was answered in the run that died, so it must fail too -- but its handler
  // journalled a second failure entry and painted a second error bubble when it got the raw error.
  runRegistry.clear();
  runRegistry.startRoot("s1");
  const p = runRegistry.enqueueInjection("s1", msg("a"))!;
  runRegistry.drainInjections("s1");
  const cause = new Error("provider said 500");
  runRegistry.settleMailbox("s1", "reject", cause);
  const err = await p.then(() => null, (e: unknown) => e);
  assert.ok(err instanceof FoldedRunError);
  assert.equal(err.cause, cause);
  assert.equal(err.message, "provider said 500");
  runRegistry.clear();
});

test("an abort reaches a claimed injection unwrapped: the stop is the owner's on every message it cut", async () => {
  runRegistry.clear();
  runRegistry.startRoot("s1");
  const p = runRegistry.enqueueInjection("s1", msg("a"))!;
  runRegistry.drainInjections("s1");
  runRegistry.settleMailbox("s1", "reject", new AbortedError());
  const err = await p.then(() => null, (e: unknown) => e);
  assert.ok(err instanceof AbortedError);
  runRegistry.clear();
});

test("settleMailbox resolve reroutes a pending-but-undrained injection", async () => {
  runRegistry.clear();
  runRegistry.startRoot("s1");
  const p = runRegistry.enqueueInjection("s1", msg("late"))!;
  // never drained -> a successful run end must reroute it (not silently resolve)
  runRegistry.settleMailbox("s1", "resolve");
  await assert.rejects(p, (e: unknown) => e instanceof RerouteSignal && e.injected.id === "late");
  runRegistry.clear();
});

// A message the run never read is still owed its own attempt: the run died for its own reasons.
// It used to inherit that failure and vanish, which read as a send silently dropped.
test("settleMailbox reject reroutes a pending-but-unread injection", async () => {
  runRegistry.clear();
  runRegistry.startRoot("s1");
  const p = runRegistry.enqueueInjection("s1", msg("unread"))!;
  runRegistry.settleMailbox("s1", "reject", new Error("boom"));
  await assert.rejects(p, (e: unknown) => e instanceof RerouteSignal && e.injected.id === "unread");
  runRegistry.clear();
});

// The exception: the owner asked for the stop, so reviving the message they interrupted would
// defeat it.
test("an aborted run does not revive its unread injections", async () => {
  runRegistry.clear();
  runRegistry.startRoot("s1");
  const p = runRegistry.enqueueInjection("s1", msg("unread"))!;
  runRegistry.settleMailbox("s1", "reject", new AbortedError());
  await assert.rejects(p, (e: unknown) => e instanceof AbortedError);
  runRegistry.clear();
});

test("injection cap: beyond MAX_INJECTIONS_PER_RUN, enqueue falls back", () => {
  runRegistry.clear();
  runRegistry.startRoot("s1");
  for (let i = 0; i < MAX_INJECTIONS_PER_RUN; i++) {
    assert.ok(runRegistry.enqueueInjection("s1", msg(`m${i}`)));
  }
  assert.equal(runRegistry.enqueueInjection("s1", msg("overflow")), null);
  runRegistry.clear();
});

test("the mailbox is per-session (a run for s1 does not accept s2 injections)", () => {
  runRegistry.clear();
  runRegistry.startRoot("s1");
  assert.equal(runRegistry.enqueueInjection("s2", msg("a")), null);
  runRegistry.clear();
});

test("IterationBudget.grant extends the budget", () => {
  const b = new IterationBudget(1);
  assert.equal(b.consume(), true);
  assert.equal(b.consume(), false); // exhausted
  b.grant(2);
  assert.equal(b.consume(), true);
  assert.equal(b.consume(), true);
  assert.equal(b.consume(), false);
});
