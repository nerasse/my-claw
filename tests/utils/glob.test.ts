import { test, expect } from "bun:test";
import { globToRegExp, matchesAnyGlob } from "../../src/utils/glob.ts";

/** Shared by the CDP method allowlist and the context cap exemptions. */

test("a pattern is anchored, so a substring is not a match", () => {
  expect(globToRegExp("claude-*").test("claude-opus-5")).toBe(true);
  // Without anchoring, "claude-*" would match anything containing it, silently exempting more
  // models than the owner listed.
  expect(globToRegExp("claude-*").test("not-claude-opus-5")).toBe(false);
  expect(globToRegExp("opus").test("claude-opus-5")).toBe(false);
});

test("matching ignores case, because ids are spelled inconsistently across providers", () => {
  expect(globToRegExp("qwen3.6-*").test("QWEN3.6-35B")).toBe(true);
});

test("regex metacharacters in a pattern are literal, so a dot is a dot", () => {
  expect(globToRegExp("mimo-v2.5-pro").test("mimo-v2.5-pro")).toBe(true);
  // A live bug if the dot stayed a wildcard: this would match too.
  expect(globToRegExp("mimo-v2.5-pro").test("mimo-v2X5-pro")).toBe(false);
  expect(globToRegExp("a+b").test("a+b")).toBe(true);
  expect(globToRegExp("a(b)").test("a(b)")).toBe(true);
});

test("a question mark is literal rather than a single-character wildcard", () => {
  expect(globToRegExp("what?").test("what?")).toBe(true);
  expect(globToRegExp("what?").test("whatx")).toBe(false);
});

test("a bare star matches everything, which is how a cap gets disabled by pattern", () => {
  expect(globToRegExp("*").test("anything-at-all")).toBe(true);
});

test("an empty or absent pattern list matches nothing, so the default is to apply the policy", () => {
  expect(matchesAnyGlob("x", undefined)).toBe(false);
  expect(matchesAnyGlob("x", [])).toBe(false);
});

test("any one pattern matching is enough", () => {
  expect(matchesAnyGlob("Qwen3.6-35B", ["claude-*", "Qwen3.6-*"])).toBe(true);
  expect(matchesAnyGlob("mimo-v2.5-pro", ["claude-*", "Qwen3.6-*"])).toBe(false);
});
