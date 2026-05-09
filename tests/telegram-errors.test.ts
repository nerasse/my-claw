import test from "node:test";
import assert from "node:assert/strict";
import { GrammyError, HttpError } from "grammy";
import { ErrorReporter } from "../src/channels/telegram/errors.ts";

test("ErrorReporter handles always and silent modes", () => {
  const always = new ErrorReporter({ mode: "always", onceCooldownMs: 1000 });
  const silent = new ErrorReporter({ mode: "silent", onceCooldownMs: 1000 });

  assert.equal(always.shouldReport("x"), true);
  assert.equal(always.shouldReport("x"), true);
  assert.equal(silent.shouldReport("x"), false);
});

test("ErrorReporter deduplicates once mode within cooldown", async () => {
  const reporter = new ErrorReporter({ mode: "once", onceCooldownMs: 20 });

  assert.equal(reporter.shouldReport("rate_limit"), true);
  assert.equal(reporter.shouldReport("rate_limit"), false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(reporter.shouldReport("rate_limit"), true);
});

test("ErrorReporter classifies known error types", () => {
  const reporter = new ErrorReporter({ mode: "always", onceCooldownMs: 1000 });
  const rateLimit = new GrammyError(
    "429 Too Many Requests",
    { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } },
    "sendMessage",
    {},
  );
  const parseError = new GrammyError(
    "400 Bad Request",
    { ok: false, error_code: 400, description: "can't parse entities" },
    "sendMessage",
    {},
  );
  const telegramError = new GrammyError(
    "403 Forbidden",
    { ok: false, error_code: 403, description: "Forbidden" },
    "sendMessage",
    {},
  );
  const httpError = new HttpError("network failed", { code: "ECONNREFUSED" });

  assert.equal(reporter.errorKey(rateLimit), "rate_limit");
  assert.equal(reporter.errorKey(parseError), "parse_error");
  assert.equal(reporter.errorKey(telegramError), "telegram_403");
  assert.equal(reporter.errorKey(httpError), "network_ECONNREFUSED");
  assert.equal(reporter.errorKey(new Error("boom")), "agent_error");
  assert.equal(reporter.errorKey("boom"), "unknown");
});
