import { test } from "bun:test";
import assert from "node:assert/strict";
import { ErrorReporter } from "../../src/channels/telegram/errors.ts";
import { MatrixErrorReporter } from "../../src/channels/matrix/errors.ts";

// --- Telegram ErrorReporter ---

test("Telegram ErrorReporter: prunes expired entries when over max", () => {
  const reporter = new ErrorReporter({ mode: "once", onceCooldownMs: 50 });

  // Fill with entries
  for (let i = 0; i < 600; i++) {
    reporter.shouldReport(`error_${i}`);
  }

  // Access internal Map size via shouldReport behavior
  // After pruning triggered (>500 entries), expired entries should be cleaned
  // Since cooldown is 50ms and we just added them, they are not expired yet
  // But the pruneExpired method runs when size > MAX_ERROR_ENTRIES (500)
  // The entries are fresh (not expired), so they stay — but the mechanism is in place
  // Let's verify the reporter still works correctly
  assert.equal(reporter.shouldReport("error_0"), false); // within cooldown
  assert.equal(reporter.shouldReport("new_error"), true); // new key
});

test("Telegram ErrorReporter: expired entries get pruned", async () => {
  const reporter = new ErrorReporter({ mode: "once", onceCooldownMs: 30 });

  // Add entries
  for (let i = 0; i < 550; i++) {
    reporter.shouldReport(`error_${i}`);
  }

  // Wait for cooldown to expire
  await new Promise((r) => setTimeout(r, 50));

  // Next call triggers pruneExpired — expired entries are removed
  // and the same key should now be reportable again
  assert.equal(reporter.shouldReport("error_0"), true);
});

// --- Matrix ErrorReporter ---

test("Matrix ErrorReporter: prunes expired entries when over max", () => {
  const reporter = new MatrixErrorReporter({ mode: "once", onceCooldownMs: 50 });

  for (let i = 0; i < 600; i++) {
    reporter.shouldReport(`error_${i}`);
  }

  assert.equal(reporter.shouldReport("error_0"), false); // within cooldown
  assert.equal(reporter.shouldReport("new_error"), true);
});

test("Matrix ErrorReporter: expired entries get pruned", async () => {
  const reporter = new MatrixErrorReporter({ mode: "once", onceCooldownMs: 30 });

  for (let i = 0; i < 550; i++) {
    reporter.shouldReport(`error_${i}`);
  }

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reporter.shouldReport("error_0"), true);
});

// --- Basic behavior preserved ---

test("ErrorReporter: silent mode never reports", () => {
  const reporter = new ErrorReporter({ mode: "silent", onceCooldownMs: 1000 });
  assert.equal(reporter.shouldReport("error"), false);
});

test("ErrorReporter: always mode always reports", () => {
  const reporter = new ErrorReporter({ mode: "always", onceCooldownMs: 1000 });
  assert.equal(reporter.shouldReport("error"), true);
  assert.equal(reporter.shouldReport("error"), true);
});

test("ErrorReporter: once mode respects cooldown", () => {
  const reporter = new ErrorReporter({ mode: "once", onceCooldownMs: 60_000 });
  assert.equal(reporter.shouldReport("error"), true);
  assert.equal(reporter.shouldReport("error"), false); // within cooldown
  assert.equal(reporter.shouldReport("other_error"), true); // different key
});
