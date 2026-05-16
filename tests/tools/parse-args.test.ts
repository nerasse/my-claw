import { test } from "bun:test";
import assert from "node:assert/strict";
import { str, strOpt, num, bool } from "../../src/tools/types.ts";

// --- str ---

test("str: returns string value as-is", () => {
  assert.equal(str({ a: "hello" }, "a"), "hello");
});

test("str: returns empty string for missing key", () => {
  assert.equal(str({}, "a"), "");
});

test("str: returns empty string for null", () => {
  assert.equal(str({ a: null }, "a"), "");
});

test("str: returns empty string for undefined", () => {
  assert.equal(str({ a: undefined }, "a"), "");
});

test("str: coerces number to string", () => {
  assert.equal(str({ a: 42 }, "a"), "42");
});

test("str: coerces boolean to string", () => {
  assert.equal(str({ a: true }, "a"), "true");
});

test("str: coerces object to string", () => {
  const result = str({ a: { foo: "bar" } }, "a");
  assert.equal(typeof result, "string");
});

// --- strOpt ---

test("strOpt: returns string value as-is", () => {
  assert.equal(strOpt({ a: "hello" }, "a"), "hello");
});

test("strOpt: returns undefined for missing key", () => {
  assert.equal(strOpt({}, "a"), undefined);
});

test("strOpt: returns undefined for null", () => {
  assert.equal(strOpt({ a: null }, "a"), undefined);
});

test("strOpt: returns undefined for undefined", () => {
  assert.equal(strOpt({ a: undefined }, "a"), undefined);
});

test("strOpt: coerces number to string", () => {
  assert.equal(strOpt({ a: 42 }, "a"), "42");
});

// --- num ---

test("num: returns number value as-is", () => {
  assert.equal(num({ a: 42 }, "a", 0), 42);
});

test("num: returns fallback for missing key", () => {
  assert.equal(num({}, "a", 5), 5);
});

test("num: returns fallback for null", () => {
  assert.equal(num({ a: null }, "a", 5), 5);
});

test("num: parses numeric string", () => {
  assert.equal(num({ a: "42" }, "a", 0), 42);
});

test("num: returns fallback for non-numeric string", () => {
  assert.equal(num({ a: "hello" }, "a", 5), 5);
});

test("num: returns fallback for NaN", () => {
  assert.equal(num({ a: NaN }, "a", 5), 5);
});

test("num: returns fallback for Infinity", () => {
  assert.equal(num({ a: Infinity }, "a", 5), 5);
});

test("num: handles zero correctly", () => {
  assert.equal(num({ a: 0 }, "a", 5), 0);
});

test("num: handles negative numbers", () => {
  assert.equal(num({ a: -3 }, "a", 0), -3);
});

test("num: parses float string", () => {
  assert.equal(num({ a: "3.14" }, "a", 0), 3.14);
});

// --- bool ---

test("bool: returns boolean value as-is", () => {
  assert.equal(bool({ a: true }, "a", false), true);
  assert.equal(bool({ a: false }, "a", true), false);
});

test("bool: returns fallback for missing key", () => {
  assert.equal(bool({}, "a", true), true);
  assert.equal(bool({}, "a", false), false);
});

test("bool: parses string 'true'", () => {
  assert.equal(bool({ a: "true" }, "a", false), true);
});

test("bool: parses string 'false'", () => {
  assert.equal(bool({ a: "false" }, "a", true), false);
});

test("bool: returns fallback for other strings", () => {
  assert.equal(bool({ a: "yes" }, "a", false), false);
  assert.equal(bool({ a: "1" }, "a", false), false);
});

test("bool: returns fallback for null", () => {
  assert.equal(bool({ a: null }, "a", true), true);
});

test("bool: returns fallback for number", () => {
  assert.equal(bool({ a: 1 }, "a", false), false);
  assert.equal(bool({ a: 0 }, "a", true), true);
});

// --- Edge cases: LLM sends wrong types ---

test("str handles LLM sending number where string expected", () => {
  // LLM might send {"path": 123} instead of {"path": "/some/path"}
  assert.equal(str({ path: 123 }, "path"), "123");
});

test("num handles LLM sending string where number expected", () => {
  // LLM might send {"count": "5"} instead of {"count": 5}
  assert.equal(num({ count: "5" }, "count", 10), 5);
});

test("bool handles LLM sending string where boolean expected", () => {
  // LLM might send {"recursive": "true"} instead of {"recursive": true}
  assert.equal(bool({ recursive: "true" }, "recursive", false), true);
});

test("str handles LLM sending empty object", () => {
  assert.equal(str({ path: {} }, "path"), "[object Object]");
});

test("str handles LLM sending array", () => {
  const result = str({ path: ["a", "b"] }, "path");
  assert.equal(typeof result, "string");
  assert.ok(result.includes("a"));
});
