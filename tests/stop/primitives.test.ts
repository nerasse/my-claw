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

test("isAbort: with a signal, only that signal decides", () => {
  // The three shapes a failure arrives in while the run is perfectly alive: a tool's own wall, a
  // socket that died, and a sub-agent stopped on its own. Reading any of them as a user stop is
  // what ended a run nobody had stopped (2026-09-21).
  const run = new AbortController();
  assert.equal(isAbort(new AbortedError(), run.signal), false);
  assert.equal(isAbort(new DOMException("timed out", "TimeoutError"), run.signal), false);
  assert.equal(isAbort(new DOMException("aborted", "AbortError"), run.signal), false);
  assert.equal(isAbort(new Error("socket closed"), run.signal), false);

  run.abort();
  assert.equal(isAbort(new Error("anything at all"), run.signal), true, "the aborted signal is the authority");
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

  assert.equal(runRegistry.stop("sess-A"), "stopped");
  assert.equal(signal.aborted, true);

  end();
  assert.equal(runRegistry.isRunning("sess-A"), false);
  assert.equal(runRegistry.stop("sess-A"), "idle");
  runRegistry.clear();
});

test("run-registry: stop targets only the requested session", () => {
  runRegistry.clear();
  const a = runRegistry.startRoot("sess-A");
  const b = runRegistry.startRoot("sess-B");

  assert.equal(runRegistry.stop("sess-A"), "stopped");
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);

  a.end();
  b.end();
  runRegistry.clear();
});

test("run-registry: live view groups main + sub-agents by shared signal", () => {
  runRegistry.clear();
  const { signal, end } = runRegistry.startRoot("sess-A");

  const main = runRegistry.enter(signal, "main", 0, "sess-A", "alpha-1");
  const sub1 = runRegistry.enter(signal, "researcher", 1, "sess-B");
  const sub2 = runRegistry.enter(signal, "coder", 1, "sess-C");

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
  const handle = runRegistry.enter(new AbortController().signal, "x", 0, "sess-X");
  assert.equal(handle, undefined);
  runRegistry.clear();
});

test("run-registry: a node names its session and the model it is calling now", () => {
  runRegistry.clear();
  const { signal, end } = runRegistry.startRoot("sess-root");
  const child = runRegistry.enter(signal, "researcher", 1, "subagent/child", "anthropic/opus-5");
  assert.equal(runRegistry.liveModelOf("subagent/child"), "anthropic/opus-5", "the model is known from the first call");

  // A run that walks its route moves the node it already owns: no second node, no stale model.
  child?.setModel("claude-2/opus-5");
  assert.equal(runRegistry.liveModelOf("subagent/child"), "claude-2/opus-5");
  assert.equal(runRegistry.list("sess-root").length, 1);

  child?.exit();
  assert.equal(runRegistry.liveModelOf("subagent/child"), undefined, "a finished run has no live model");
  end();
  runRegistry.clear();
});

test("run-registry: two agents with the same display name are still told apart by session", () => {
  runRegistry.clear();
  const { signal, end } = runRegistry.startRoot("sess-root");
  runRegistry.enter(signal, "worker", 1, "subagent/first", "alpha-1");
  runRegistry.enter(signal, "worker", 1, "subagent/second", "beta-1");
  assert.equal(runRegistry.liveModelOf("subagent/first"), "alpha-1");
  assert.equal(runRegistry.liveModelOf("subagent/second"), "beta-1");
  assert.equal(runRegistry.liveModelOf("subagent/third"), undefined);
  end();
  runRegistry.clear();
});
