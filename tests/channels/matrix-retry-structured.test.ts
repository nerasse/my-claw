import { test } from "bun:test";
import assert from "node:assert/strict";
import { isMatrixRetryableError } from "../../src/channels/matrix/retry.ts";

test("httpStatus 429 is retryable", () => {
  assert.equal(isMatrixRetryableError({ httpStatus: 429 }), true);
});

test("httpStatus 503 is retryable", () => {
  assert.equal(isMatrixRetryableError({ httpStatus: 503 }), true);
});

test("httpStatus 403 is not retryable", () => {
  assert.equal(isMatrixRetryableError({ httpStatus: 403 }), false);
});

test("httpStatus 404 is not retryable", () => {
  assert.equal(isMatrixRetryableError({ httpStatus: 404 }), false);
});

test("statusCode 429 is retryable", () => {
  assert.equal(isMatrixRetryableError({ statusCode: 429 }), true);
});

test("statusCode 500 is retryable", () => {
  assert.equal(isMatrixRetryableError({ statusCode: 500 }), true);
});

test("errcode M_LIMIT_EXCEEDED is retryable", () => {
  assert.equal(isMatrixRetryableError({ errcode: "M_LIMIT_EXCEEDED" }), true);
});

test("errcode M_UNKNOWN is retryable", () => {
  assert.equal(isMatrixRetryableError({ errcode: "M_UNKNOWN" }), true);
});

test("errcode M_FORBIDDEN is not retryable", () => {
  assert.equal(isMatrixRetryableError({ errcode: "M_FORBIDDEN" }), false);
});

test("errcode M_NOT_FOUND is not retryable", () => {
  assert.equal(isMatrixRetryableError({ errcode: "M_NOT_FOUND" }), false);
});

test("both httpStatus 429 and errcode M_LIMIT_EXCEEDED is retryable", () => {
  assert.equal(isMatrixRetryableError({ httpStatus: 429, errcode: "M_LIMIT_EXCEEDED" }), true);
});

test("plain Error with timeout message is retryable", () => {
  assert.equal(isMatrixRetryableError(new Error("timeout something")), true);
});

test("plain Error with M_FORBIDDEN message is not retryable", () => {
  assert.equal(isMatrixRetryableError(new Error("M_FORBIDDEN access denied")), false);
});

test("plain Error with connection reset message is retryable", () => {
  assert.equal(isMatrixRetryableError(new Error("connection reset")), true);
});

test("null is not retryable", () => {
  assert.equal(isMatrixRetryableError(null), false);
});

test("undefined is not retryable", () => {
  assert.equal(isMatrixRetryableError(undefined), false);
});
