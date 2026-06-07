import { test } from "bun:test";
import assert from "node:assert/strict";
import { AbortedError, isAbort, rethrowIfAborted } from "../../src/core/aborted.ts";
import { runRegistry } from "../../src/core/run-registry.ts";

test("isAbort: detects AbortedError, aborted signal, and DOM AbortError", () => {
  assert.equal(isAbort(new AbortedError()), true);

  const c = new AbortController();
  c.abort();
  assert.equal(isAbort(new Error("x"), c.signal), true);

  assert.equal(isAbort(new DOMException("aborted", "AbortError")), true);

  assert.equal(isAbort(new Error("nope")), false);
  assert.equal(isAbort(undefined, new AbortController().signal), false);
});

test("rethrowIfAborted: throws AbortedError on abort, no-op otherwise", () => {
  assert.throws(() => rethrowIfAborted(new DOMException("a", "AbortError")), AbortedError);
  const c = new AbortController();
  c.abort();
  assert.throws(() => rethrowIfAborted(undefined, c.signal), AbortedError);
  // no throw
  rethrowIfAborted(new Error("regular"), new AbortController().signal);
});

test("run-registry: startRoot tracks a controller, stop aborts it once", () => {
  runRegistry.clear();
  const { signal, end } = runRegistry.startRoot("sess-A");
  assert.equal(signal.aborted, false);
  assert.equal(runRegistry.isRunning("sess-A"), true);

  assert.equal(runRegistry.stop("sess-A"), true);
  assert.equal(signal.aborted, true);

  end();
  assert.equal(runRegistry.isRunning("sess-A"), false);
  assert.equal(runRegistry.stop("sess-A"), false);
  runRegistry.clear();
});

test("run-registry: stop targets only the requested session", () => {
  runRegistry.clear();
  const a = runRegistry.startRoot("sess-A");
  const b = runRegistry.startRoot("sess-B");

  assert.equal(runRegistry.stop("sess-A"), true);
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);

  a.end();
  b.end();
  runRegistry.clear();
});

test("run-registry: live view groups main + sub-agents by shared signal", () => {
  runRegistry.clear();
  const { signal, end } = runRegistry.startRoot("sess-A");

  const main = runRegistry.enter(signal, "main", 0);
  const sub1 = runRegistry.enter(signal, "researcher", 1);
  const sub2 = runRegistry.enter(signal, "coder", 1);

  let live = runRegistry.list("sess-A");
  assert.equal(live.length, 3);
  assert.deepEqual(live.map((n) => `${n.label}:${n.depth}`), ["main:0", "researcher:1", "coder:1"]);

  sub1?.exit();
  live = runRegistry.list("sess-A");
  assert.equal(live.length, 2);

  main?.exit();
  sub2?.exit();
  end();
  assert.deepEqual(runRegistry.list("sess-A"), []);
  runRegistry.clear();
});

test("run-registry: enter is a no-op for an untracked signal", () => {
  runRegistry.clear();
  const handle = runRegistry.enter(new AbortController().signal, "x", 0);
  assert.equal(handle, undefined);
  runRegistry.clear();
});
