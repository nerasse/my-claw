/**
 * One stop per cycle (docs/stop.md): the registry answers `stopped` on the first stop, `stopping`
 * while that abort is still in flight, `idle` when there is nothing to stop. The `stopping` state
 * has to be lifted exactly where the cycle ends -- the run's `end()`, the hold's `release()` --
 * because a flag that outlived its cycle would swallow the next cycle's first stop.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { runRegistry } from "../../src/core/run-registry.ts";

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
