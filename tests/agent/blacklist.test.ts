import { test } from "bun:test";
import assert from "node:assert/strict";
import { ActionBlacklist } from "../../src/agent/blacklist.ts";

test("requiresConfirmation returns true for blacklisted action", () => {
  const bl = new ActionBlacklist(["bash"]);
  assert.equal(bl.requiresConfirmation("bash"), true);
});

test("requiresConfirmation returns false for non-blacklisted action", () => {
  const bl = new ActionBlacklist(["bash"]);
  assert.equal(bl.requiresConfirmation("read"), false);
});

test("add() adds action, then requiresConfirmation returns true", () => {
  const bl = new ActionBlacklist([]);
  assert.equal(bl.requiresConfirmation("write"), false);
  bl.add("write");
  assert.equal(bl.requiresConfirmation("write"), true);
});

test("add() is idempotent", () => {
  const bl = new ActionBlacklist(["bash"]);
  bl.add("bash");
  bl.add("bash");
  bl.remove("bash");
  assert.equal(bl.requiresConfirmation("bash"), false);
});

test("remove() removes action, then requiresConfirmation returns false", () => {
  const bl = new ActionBlacklist(["bash", "write"]);
  bl.remove("bash");
  assert.equal(bl.requiresConfirmation("bash"), false);
  assert.equal(bl.requiresConfirmation("write"), true);
});

test("remove() on non-existent action is a no-op", () => {
  const bl = new ActionBlacklist(["bash"]);
  bl.remove("read");
  assert.equal(bl.requiresConfirmation("bash"), true);
});

test("empty blacklist: everything returns false", () => {
  const bl = new ActionBlacklist([]);
  assert.equal(bl.requiresConfirmation("bash"), false);
  assert.equal(bl.requiresConfirmation("write"), false);
  assert.equal(bl.requiresConfirmation("read"), false);
});

test("multiple actions in constructor all work", () => {
  const bl = new ActionBlacklist(["bash", "write", "fetch"]);
  assert.equal(bl.requiresConfirmation("bash"), true);
  assert.equal(bl.requiresConfirmation("write"), true);
  assert.equal(bl.requiresConfirmation("fetch"), true);
  assert.equal(bl.requiresConfirmation("read"), false);
});
