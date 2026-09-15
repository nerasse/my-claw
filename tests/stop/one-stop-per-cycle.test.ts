/**
 * One stop per cycle (docs/stop.md): the registry derives the answer from the work -- `stopped`
 * on the first stop of a cycle, `stopping` while that abort is in flight, `idle` when there is
 * nothing to stop. There is no flag to lift: the controller leaving the map at the end of the
 * cycle is the whole transition, so a state can neither outlive its cycle nor be forgotten.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { runRegistry } from "../../src/core/run-registry.ts";
import { stopOutcomeOf } from "../../src/core/stop.ts";

test("stopOutcomeOf: nothing to stop is idle, everything aborting is stopping, the rest is stopped", () => {
  assert.equal(stopOutcomeOf([]), "idle");

  const already = new AbortController();
  already.abort();
  assert.equal(stopOutcomeOf([already]), "stopping");

  const fresh = new AbortController();
  assert.equal(stopOutcomeOf([fresh]), "stopped");
  assert.equal(fresh.signal.aborted, true);
});

test("stopOutcomeOf aborts each pending controller exactly once", () => {
  const pending = new AbortController();
  const alsoPending = new AbortController();
  const aborted = new AbortController();
  aborted.abort();

  // One abort per pending controller is what makes "this call issued the abort" true; the one
  // already aborting is left alone, and counting the calls proves neither is aborted twice.
  let calls = 0;
  const counting = (controller: AbortController): AbortController => {
    const original = controller.abort.bind(controller);
    controller.abort = () => {
      calls += 1;
      original();
    };
    return controller;
  };
  counting(pending);
  counting(alsoPending);
  counting(aborted);

  assert.equal(stopOutcomeOf([pending, alsoPending, aborted]), "stopped");
  assert.equal(pending.signal.aborted, true);
  assert.equal(alsoPending.signal.aborted, true);
  assert.equal(calls, 2, "the already-aborted controller is not aborted again");

  // And a second derivation has nothing left to take: it is the same cycle, still travelling.
  assert.equal(stopOutcomeOf([pending, alsoPending, aborted]), "stopping");
  assert.equal(calls, 2, "a stopping cycle aborts nothing");
});

test("a run: first stop is stopped, a second is stopping, and the next run stops fresh", () => {
  runRegistry.clear();
  const first = runRegistry.startRoot("s-run");

  assert.equal(runRegistry.stop("s-run"), "stopped");
  assert.equal(first.signal.aborted, true);

  // The abort is in flight: a second request changes nothing, and says so.
  assert.equal(runRegistry.stop("s-run"), "stopping");
  assert.equal(runRegistry.stop("s-run"), "stopping");

  first.end();
  // The cycle is over and nothing else is on the session.
  assert.equal(runRegistry.stop("s-run"), "idle");

  // A new run gets a first stop of its own -- not a leftover "stopping".
  const second = runRegistry.startRoot("s-run");
  assert.equal(runRegistry.stop("s-run"), "stopped");
  second.end();
  runRegistry.clear();
});

test("a new cycle on the same session is seen for what it is, even before the old one unwinds", () => {
  runRegistry.clear();
  const first = runRegistry.startRoot("s-replaced");
  assert.equal(runRegistry.stop("s-replaced"), "stopped");
  assert.equal(runRegistry.stop("s-replaced"), "stopping");

  // The router's lock releases only after the run's `end()`, but nothing enforces that for every
  // caller: `startRoot` replaces the controller, and the derivation must see the new one -- a
  // stored flag would have answered "stopping" for a cycle it never described.
  const second = runRegistry.startRoot("s-replaced");
  assert.equal(runRegistry.stop("s-replaced"), "stopped", "the new controller is not the old cycle");
  assert.equal(second.signal.aborted, true);

  // The old run's `end()` still carries its identity guard: it must not forget the new cycle.
  first.end();
  assert.equal(runRegistry.isRunning("s-replaced"), true);
  assert.equal(runRegistry.stop("s-replaced"), "stopping");
  second.end();
  assert.equal(runRegistry.stop("s-replaced"), "idle");
  runRegistry.clear();
});

test("nothing running is idle, and the idle stop leaves no mark", () => {
  runRegistry.clear();
  assert.equal(runRegistry.stop("s-idle"), "idle");

  const { end } = runRegistry.startRoot("s-idle");
  assert.equal(runRegistry.stop("s-idle"), "stopped", "an idle stop must not stop() the next cycle's first one");
  end();
  runRegistry.clear();
});

test("a compaction: stopping until the hold is released, idle after, fresh on the next hold", () => {
  runRegistry.clear();
  const held = runRegistry.beginCompaction("s-comp");
  assert.notEqual(held, null);

  assert.equal(runRegistry.stop("s-comp"), "stopped");
  assert.equal(held!.signal.aborted, true);
  assert.equal(runRegistry.stop("s-comp"), "stopping");

  // The hold releases once the summarizer has answered the abort: the cycle ends exactly there.
  held!.release();
  assert.equal(runRegistry.isCompacting("s-comp"), false);
  assert.equal(runRegistry.stop("s-comp"), "idle");

  // A flag left over from the stopped compaction would read this call as "stopping" and swallow
  // it: the new hold must get a first stop of its own.
  const next = runRegistry.beginCompaction("s-comp");
  assert.notEqual(next, null);
  assert.equal(runRegistry.stop("s-comp"), "stopped");
  next!.release();
  runRegistry.clear();
});

test("the mark is per cycle, not per session: a run and a later hold both stop fresh", () => {
  runRegistry.clear();

  const { end } = runRegistry.startRoot("s-mixed");
  assert.equal(runRegistry.stop("s-mixed"), "stopped");
  assert.equal(runRegistry.stop("s-mixed"), "stopping");
  end();

  const held = runRegistry.beginCompaction("s-mixed");
  assert.notEqual(held, null);
  assert.equal(runRegistry.stop("s-mixed"), "stopped", "the run's stop must not leak into the hold");
  assert.equal(runRegistry.stop("s-mixed"), "stopping");
  held!.release();

  const { end: endAgain } = runRegistry.startRoot("s-mixed");
  assert.equal(runRegistry.stop("s-mixed"), "stopped", "the hold's stop must not leak into the run");
  endAgain();
  runRegistry.clear();
});

test("stopping one session never marks another", () => {
  runRegistry.clear();
  const a = runRegistry.startRoot("s-a");
  const b = runRegistry.startRoot("s-b");

  assert.equal(runRegistry.stop("s-a"), "stopped");
  assert.equal(runRegistry.stop("s-a"), "stopping");
  assert.equal(runRegistry.stop("s-b"), "stopped", "b's first stop is a first stop");
  assert.equal(b.signal.aborted, true);

  a.end();
  b.end();
  runRegistry.clear();
});
