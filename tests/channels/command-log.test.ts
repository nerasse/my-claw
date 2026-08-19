import { test } from "bun:test";
import assert from "node:assert/strict";
import { redactCommandArgs } from "../../src/channels/command-log.ts";

test("redactCommandArgs hides a set-token argument but keeps the subcommand", () => {
  // The token is a live credential: it must never appear in a log file.
  assert.equal(redactCommandArgs("claude", "set-token sk-ant-oat01-SECRET"), "set-token [redacted]");
  assert.equal(redactCommandArgs("claude", "token sk-ant-oat01-SECRET"), "token [redacted]");
  assert.equal(redactCommandArgs("claude", "SET-TOKEN sk-ant-oat01-SECRET"), "SET-TOKEN [redacted]");
  // A multi-word value must not leak its tail either.
  assert.equal(redactCommandArgs("claude", "set-token part1 part2"), "set-token [redacted]");
});

test("redactCommandArgs keeps arguments that carry no secret", () => {
  assert.equal(redactCommandArgs("claude", "status"), "status");
  assert.equal(redactCommandArgs("claude", "login"), "login");
  assert.equal(redactCommandArgs("claude", "set-token"), "set-token");
  assert.equal(redactCommandArgs("model", "claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(redactCommandArgs("effort", "max"), "max");
  // "token" only matters as the claude subcommand, not as arbitrary text elsewhere.
  assert.equal(redactCommandArgs("codex", "token whatever"), "token whatever");
  assert.equal(redactCommandArgs("claude", ""), "");
  assert.equal(redactCommandArgs("claude", "   "), "");
});

test("redactCommandArgs hides an OAuth code, which is exchangeable until it is spent", () => {
  assert.equal(redactCommandArgs("claude", "code Zm9vYmFy-authorization-code#state"), "code [redacted]");
  assert.equal(redactCommandArgs("claude", "code"), "code");
});
