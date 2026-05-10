import { test } from "bun:test";
import assert from "node:assert/strict";
import { isMatrixRetryableError, matrixRetryAfterMs, withMatrixRetry } from "../src/channels/matrix/retry.ts";

test("matrix retry classifies common transient errors", () => {
  assert.equal(isMatrixRetryableError(new Error("M_LIMIT_EXCEEDED 429")), true);
  assert.equal(isMatrixRetryableError(new Error("network timeout")), true);
  assert.equal(isMatrixRetryableError(new Error("M_FORBIDDEN")), false);
});

test("matrix retry extracts retry_after_ms", () => {
  assert.equal(matrixRetryAfterMs({ retry_after_ms: 1200 }), 1200);
  assert.equal(matrixRetryAfterMs({ data: { retry_after_ms: 900 } }), 900);
  assert.equal(matrixRetryAfterMs({ retry_after_ms: "900" }), undefined);
});

test("matrix retry retries retryable failures and succeeds", async () => {
  let attempts = 0;
  const result = await withMatrixRetry({
    attempts: 3,
    minDelayMs: 1,
    maxDelayMs: 1,
    jitter: 0,
    task: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("network timeout");
      }
      return "ok";
    },
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("matrix retry does not retry non-retryable failures", async () => {
  let attempts = 0;
  await assert.rejects(
    withMatrixRetry({
      attempts: 3,
      minDelayMs: 1,
      maxDelayMs: 1,
      jitter: 0,
      task: async () => {
        attempts += 1;
        throw new Error("M_FORBIDDEN");
      },
    }),
  );
  assert.equal(attempts, 1);
});
