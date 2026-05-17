import { test } from "bun:test";
import assert from "node:assert/strict";
import { userFacingError } from "../../src/channels/telegram/errors.ts";
import { matrixUserFacingError } from "../../src/channels/matrix/errors.ts";

// --- Telegram userFacingError ---

test("Telegram: rate_limit gives rate limit message", () => {
  const msg = userFacingError("rate_limit");
  assert.ok(msg.toLowerCase().includes("rate limit"));
});

test("Telegram: network_error gives network message", () => {
  const msg = userFacingError("network_error");
  assert.ok(msg.toLowerCase().includes("network"));
});

test("Telegram: network_ECONNREFUSED gives network message", () => {
  const msg = userFacingError("network_ECONNREFUSED");
  assert.ok(msg.toLowerCase().includes("network"));
});

test("Telegram: agent_error gives processing message", () => {
  const msg = userFacingError("agent_error");
  assert.ok(msg.toLowerCase().includes("something went wrong"));
});

test("Telegram: parse_error gives format message", () => {
  const msg = userFacingError("parse_error");
  assert.ok(msg.toLowerCase().includes("format"));
});

test("Telegram: telegram_403 gives telegram error with code", () => {
  const msg = userFacingError("telegram_403");
  assert.ok(msg.includes("403"));
});

test("Telegram: unknown gives generic message", () => {
  const msg = userFacingError("unknown");
  assert.ok(msg.toLowerCase().includes("unexpected"));
});

test("Telegram: unrecognized key falls back to unknown", () => {
  const msg = userFacingError("some_weird_key");
  assert.ok(msg.toLowerCase().includes("unexpected"));
});

// --- Matrix matrixUserFacingError ---

test("Matrix: rate_limit gives rate limit message", () => {
  const msg = matrixUserFacingError("rate_limit");
  assert.ok(msg.toLowerCase().includes("rate limit"));
});

test("Matrix: network_error gives network message", () => {
  const msg = matrixUserFacingError("network_error");
  assert.ok(msg.toLowerCase().includes("network"));
});

test("Matrix: matrix_forbidden gives permission message", () => {
  const msg = matrixUserFacingError("matrix_forbidden");
  assert.ok(msg.toLowerCase().includes("permission"));
});

test("Matrix: matrix_error gives processing message", () => {
  const msg = matrixUserFacingError("matrix_error");
  assert.ok(msg.toLowerCase().includes("something went wrong"));
});

test("Matrix: unknown gives generic message", () => {
  const msg = matrixUserFacingError("unknown");
  assert.ok(msg.toLowerCase().includes("unexpected"));
});

// --- No message is the old generic ---

test("Telegram: no error key produces the old generic message", () => {
  const keys = ["rate_limit", "network_error", "agent_error", "parse_error", "unknown", "telegram_400"];
  for (const key of keys) {
    const msg = userFacingError(key);
    assert.notEqual(msg, "An error occurred while processing your message.", `key "${key}" should not use old generic`);
  }
});

test("Matrix: no error key produces the old generic message", () => {
  const keys = ["rate_limit", "network_error", "matrix_forbidden", "matrix_error", "unknown"];
  for (const key of keys) {
    const msg = matrixUserFacingError(key);
    assert.notEqual(msg, "An error occurred while processing your message.", `key "${key}" should not use old generic`);
  }
});
