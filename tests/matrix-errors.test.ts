import test from "node:test";
import assert from "node:assert/strict";
import { MatrixErrorReporter } from "../src/channels/matrix/errors.ts";

test("MatrixErrorReporter handles always and silent modes", () => {
  const always = new MatrixErrorReporter({ mode: "always", onceCooldownMs: 1000 });
  const silent = new MatrixErrorReporter({ mode: "silent", onceCooldownMs: 1000 });

  assert.equal(always.shouldReport("x"), true);
  assert.equal(always.shouldReport("x"), true);
  assert.equal(silent.shouldReport("x"), false);
});

test("MatrixErrorReporter deduplicates once mode within cooldown", async () => {
  const reporter = new MatrixErrorReporter({ mode: "once", onceCooldownMs: 20 });

  assert.equal(reporter.shouldReport("rate_limit"), true);
  assert.equal(reporter.shouldReport("rate_limit"), false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(reporter.shouldReport("rate_limit"), true);
});

test("MatrixErrorReporter classifies common matrix errors", () => {
  const reporter = new MatrixErrorReporter({ mode: "always", onceCooldownMs: 1000 });

  assert.equal(reporter.errorKey(new Error("M_FORBIDDEN")), "matrix_forbidden");
  assert.equal(reporter.errorKey(new Error("M_LIMIT_EXCEEDED")), "rate_limit");
  assert.equal(reporter.errorKey(new Error("network timeout")), "network_error");
  assert.equal(reporter.errorKey(new Error("something else")), "matrix_error");
  assert.equal(reporter.errorKey("boom"), "unknown");
});
