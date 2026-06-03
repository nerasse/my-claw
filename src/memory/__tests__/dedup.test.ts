import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { addEntry, closeMemoryDb, clearAllEntries } from "../db.ts";
import { classify, hashContent } from "../dedup.ts";

const DB = join(tmpdir(), `mc-dedup-${process.pid}-${Date.now()}.db`);

beforeAll(() => {
  process.env["MY_CLAW_MEMORY_DB"] = DB;
  closeMemoryDb();
});
afterAll(() => {
  closeMemoryDb();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
  delete process.env["MY_CLAW_MEMORY_DB"];
});
beforeEach(() => clearAllEntries());

function unit(cos: number): Float32Array {
  return new Float32Array([cos, Math.sqrt(Math.max(0, 1 - cos * cos))]);
}

test("hashContent normalizes whitespace and case", () => {
  expect(hashContent("Hello   World")).toBe(hashContent("hello world"));
  expect(hashContent(" foo ")).toBe(hashContent("foo"));
  expect(hashContent("a")).not.toBe(hashContent("b"));
});

test("exact hash duplicate yields skip", () => {
  const content = "user prefers dark mode";
  addEntry(content, "user", null, hashContent(content));
  const r = classify(content, null);
  expect(r.decision).toBe("skip");
  expect(r.reason).toBe("exact duplicate");
});

test("novel content without embedding yields add", () => {
  const r = classify("a completely new fact", null);
  expect(r.decision).toBe("add");
  expect(r.hash).toBe(hashContent("a completely new fact"));
});

const MODEL = "test-model";

test("near-duplicate by cosine yields skip", () => {
  const base = new Float32Array([1, 0]);
  addEntry("user likes strong coffee", "user", base, hashContent("user likes strong coffee"), MODEL);
  const r = classify("user likes coffee very strong", unit(0.95), MODEL);
  expect(r.decision).toBe("skip");
  expect(r.reason).toBe("near-duplicate");
});

test("related entry by cosine yields review", () => {
  const base = new Float32Array([1, 0]);
  addEntry("user likes strong coffee", "user", base, hashContent("user likes strong coffee"), MODEL);
  const r = classify("user likes coffee in the morning", unit(0.85), MODEL);
  expect(r.decision).toBe("review");
  expect(r.similar?.content).toContain("coffee");
});

test("low similarity yields add", () => {
  const base = new Float32Array([1, 0]);
  addEntry("user likes strong coffee", "user", base, hashContent("user likes strong coffee"), MODEL);
  const r = classify("user likes coffee but differently", unit(0.4), MODEL);
  expect(r.decision).toBe("add");
});

test("vectors from a different model are ignored (no false dedup)", () => {
  const base = new Float32Array([1, 0]);
  addEntry("user likes strong coffee", "user", base, hashContent("user likes strong coffee"), "old-model");
  // Same vector, but current model differs -> cannot be a semantic duplicate.
  const r = classify("user likes coffee very strong", unit(0.99), "new-model");
  expect(r.decision).toBe("add");
});
