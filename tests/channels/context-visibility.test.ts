import { test } from "bun:test";
import assert from "node:assert/strict";
import { shouldIncludeSupplementalContext } from "../../src/channels/context-visibility.ts";

test("mode=all kind=history senderAllowed=false -> true", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "all", kind: "history", senderAllowed: false }), true);
});

test("mode=all kind=thread senderAllowed=false -> true", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "all", kind: "thread", senderAllowed: false }), true);
});

test("mode=all kind=quote senderAllowed=false -> true", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "all", kind: "quote", senderAllowed: false }), true);
});

test("mode=all kind=history senderAllowed=true -> true", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "all", kind: "history", senderAllowed: true }), true);
});

test("mode=allowlist kind=history senderAllowed=true -> true", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "allowlist", kind: "history", senderAllowed: true }), true);
});

test("mode=allowlist kind=history senderAllowed=false -> false", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "allowlist", kind: "history", senderAllowed: false }), false);
});

test("mode=allowlist kind=thread senderAllowed=false -> false", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "allowlist", kind: "thread", senderAllowed: false }), false);
});

test("mode=allowlist kind=quote senderAllowed=false -> false", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "allowlist", kind: "quote", senderAllowed: false }), false);
});

test("mode=allowlist kind=quote senderAllowed=true -> true", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "allowlist", kind: "quote", senderAllowed: true }), true);
});

test("mode=allowlist_quote kind=history senderAllowed=false -> false", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "allowlist_quote", kind: "history", senderAllowed: false }), false);
});

test("mode=allowlist_quote kind=thread senderAllowed=false -> false", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "allowlist_quote", kind: "thread", senderAllowed: false }), false);
});

test("mode=allowlist_quote kind=quote senderAllowed=false -> true", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "allowlist_quote", kind: "quote", senderAllowed: false }), true);
});

test("mode=allowlist_quote kind=quote senderAllowed=true -> true", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "allowlist_quote", kind: "quote", senderAllowed: true }), true);
});

test("mode=allowlist_quote kind=history senderAllowed=true -> true", () => {
  assert.equal(shouldIncludeSupplementalContext({ mode: "allowlist_quote", kind: "history", senderAllowed: true }), true);
});
