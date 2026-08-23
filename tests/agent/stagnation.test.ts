import { test } from "bun:test";
import assert from "node:assert/strict";
import { StagnationMeter } from "../../src/agent/stagnation.ts";

function meter(results: string[]): StagnationMeter {
  const m = new StagnationMeter();
  for (const r of results) m.observe(r);
  return m;
}

test("stagnation: a run of distinct useful results scores clean", () => {
  const r = meter(Array.from({ length: 30 }, (_, i) => `line ${i}: some real content here`)).report();
  assert.equal(r.toolResults, 30);
  assert.equal(r.distinctResults, 30);
  assert.equal(r.maxRepeatInWindow, 1);
  assert.equal(r.maxBarrenInWindow, 0);
  assert.equal(r.topRepeat, 1);
});

test("stagnation: identical results are counted across the run and inside the window", () => {
  const r = meter(["same", "same", "same", "other"]).report();
  assert.equal(r.distinctResults, 2);
  assert.equal(r.topRepeat, 3);
  assert.equal(r.maxRepeatInWindow, 3);
});

test("stagnation: the window is bounded, so an old repeat stops counting", () => {
  // Two hits, then eleven others: the pair can never share a ten-wide window again.
  const r = meter(["x", "x", ...Array.from({ length: 11 }, (_, i) => `filler ${i}`), "x"]).report();
  assert.equal(r.topRepeat, 3, "the run total still sees all three");
  assert.equal(r.maxRepeatInWindow, 2, "but the window only ever held two");
});

test("stagnation: barren results are recognised in their several shapes", () => {
  const r = meter([
    "No matches for \"foo\" in /tmp",
    "Error: grep failed (exit 2)",
    "   ",
    "File not found: /tmp/x",
    "No files matching \"*.zz\" under /tmp",
  ]).report();
  assert.equal(r.maxBarrenInWindow, 5);
});

test("stagnation: a real result is not mistaken for a barren one", () => {
  // "not found" as part of an answer, rather than as the whole answer.
  const r = meter(["src/a.ts:12: if (!found) return;\nsrc/b.ts:44: // the value was found"]).report();
  assert.equal(r.maxBarrenInWindow, 0);
});

test("stagnation: an empty run reports zeroes rather than throwing", () => {
  assert.deepEqual(new StagnationMeter().report(), {
    toolResults: 0,
    distinctResults: 0,
    maxRepeatInWindow: 0,
    maxBarrenInWindow: 0,
    topRepeat: 0,
  });
});

/** The shape the corpus study scored, kept as a worked example of what the log is collecting. */
test("stagnation: the measured pathology scores high on both axes", () => {
  const r = meter(Array.from({ length: 40 }, () => "No matches found")).report();
  assert.equal(r.distinctResults, 1);
  assert.equal(r.topRepeat, 40);
  assert.equal(r.maxRepeatInWindow, 10);
  assert.equal(r.maxBarrenInWindow, 10);
});
