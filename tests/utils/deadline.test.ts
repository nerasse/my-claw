/**
 * The wall a tool arms for itself, and the Stop it must never be confused with.
 *
 * Both end a request as an abort, and they mean opposite things: one is "this host did not
 * answer", a failure result for the model; the other ends the run. Measured 2026-09-21, a `fetch`
 * whose 30s wall fired ended a research run as "run stopped by user" -- nobody had stopped
 * anything. docs/stop.md carries the incident.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { requestWall } from "../../src/utils/deadline.ts";
import { isAbort } from "../../src/core/aborted.ts";

test("our wall expiring is not a stop", async () => {
  const run = new AbortController();
  const wall = requestWall(run.signal, 10);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(wall.expired(), true, "the wall is what ended the request");
  assert.equal(wall.signal.aborted, true, "and the request did end");
  assert.equal(run.signal.aborted, false, "the run was never stopped");
  assert.equal(isAbort(new DOMException("timed out", "TimeoutError"), run.signal), false);
  wall.clear();
});

test("a Stop cuts the request without looking like our wall", () => {
  const run = new AbortController();
  const wall = requestWall(run.signal, 30_000);

  assert.equal(wall.signal.aborted, false);
  run.abort();
  assert.equal(wall.signal.aborted, true, "the composite carries the run's signal, so a Stop cuts it");
  assert.equal(wall.expired(), false, "and it is not our wall that fired");
  wall.clear();
});

test("without a run signal the wall stands alone", async () => {
  const wall = requestWall(undefined, 10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(wall.expired(), true);
  assert.equal(wall.signal.aborted, true);
  wall.clear();
});
