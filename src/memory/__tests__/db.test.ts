import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import {
  addEntry,
  getEntry,
  getByHash,
  getAllActive,
  getActiveByCategory,
  countActive,
  searchFts,
  supersedeEntry,
  updateEntry,
  incrementAccess,
  purgeSuperseded,
  toFtsQuery,
  closeMemoryDb,
  clearAllEntries,
  setEmbedding,
  getActiveNeedingEmbedding,
} from "../db.ts";

const DB = join(tmpdir(), `mc-memdb-${process.pid}-${Date.now()}.db`);

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

test("addEntry returns an id and stores content", () => {
  const id = addEntry("hello world", "lesson", {}, "h1");
  expect(id).toBeGreaterThan(0);
  const e = getEntry(id);
  expect(e?.content).toBe("hello world");
  expect(e?.category).toBe("lesson");
  expect(e?.supersededBy).toBeNull();
});

test("embedding round-trips as Float32Array", () => {
  const vec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const id = addEntry("vec entry", "user", { m: vec }, "hv");
  const e = getEntry(id);
  expect(e?.embeddings["m"]).not.toBeNull();
  expect(Array.from(e!.embeddings["m"]!)).toEqual([
    Math.fround(0.1),
    Math.fround(0.2),
    Math.fround(0.3),
    Math.fround(0.4),
  ]);
});

test("two models, two spaces: a vector in one is invisible to the other", () => {
  // A model is a vector space. Two consumers on different models must not read each other's
  // vectors, and the backfill asks per space, so it re-embeds one without touching the other.
  const id = addEntry("shared fact", "user", { gemini: new Float32Array([1, 0]) }, "h2m");
  setEmbedding(id, new Float32Array([0, 1]), "nomic");

  const entry = getEntry(id);
  expect(Array.from(entry!.embeddings["gemini"]!)).toEqual([1, 0]);
  expect(Array.from(entry!.embeddings["nomic"]!)).toEqual([0, 1]);

  // Every entry is missing a third space; nothing is missing either of the two stored ones.
  expect(getActiveNeedingEmbedding("gemini")).toHaveLength(0);
  expect(getActiveNeedingEmbedding("nomic")).toHaveLength(0);
  expect(getActiveNeedingEmbedding("other").map((e) => e.id)).toEqual([id]);
});

test("getByHash finds active entry only", () => {
  const id = addEntry("dup target", "lesson", {}, "dh");
  expect(getByHash("dh")?.id).toBe(id);
  supersedeEntry(id, null);
  expect(getByHash("dh")).toBeNull();
});

test("getAllActive excludes superseded", () => {
  const a = addEntry("a", "lesson", {}, "a");
  addEntry("b", "lesson", {}, "b");
  supersedeEntry(a, null);
  const active = getAllActive();
  expect(active.map((e) => e.content).sort()).toEqual(["b"]);
});

test("getActiveByCategory filters", () => {
  addEntry("u1", "user", {}, "u1");
  addEntry("p1", "project", {}, "p1");
  expect(getActiveByCategory("user").map((e) => e.content)).toEqual(["u1"]);
});

test("countActive reflects soft-deletes", () => {
  const a = addEntry("x", "lesson", {}, "x");
  addEntry("y", "lesson", {}, "y");
  expect(countActive()).toBe(2);
  supersedeEntry(a, null);
  expect(countActive()).toBe(1);
});

test("searchFts matches keywords and excludes superseded", () => {
  addEntry("the deployment uses kubernetes", "project", {}, "k1");
  const sup = addEntry("kubernetes secret token", "project", {}, "k2");
  let hits = searchFts("kubernetes", 10);
  expect(hits.length).toBe(2);
  supersedeEntry(sup, null);
  hits = searchFts("kubernetes", 10);
  expect(hits.length).toBe(1);
  expect(hits[0]!.entry.content).toContain("deployment");
});

test("searchFts returns empty for non-matching query", () => {
  addEntry("apple banana", "lesson", {}, "ab");
  expect(searchFts("zebra", 10)).toEqual([]);
});

test("updateEntry replaces content and FTS", () => {
  const id = addEntry("old content here", "lesson", {}, "o1");
  updateEntry(id, "new content here", {}, "n1");
  expect(getEntry(id)?.content).toBe("new content here");
  expect(searchFts("old", 10).length).toBe(0);
  expect(searchFts("new", 10).length).toBe(1);
});

test("incrementAccess bumps count", () => {
  const id = addEntry("track me", "lesson", {}, "t1");
  incrementAccess(id);
  incrementAccess(id);
  expect(getEntry(id)?.accessCount).toBe(2);
});

test("purgeSuperseded only removes old superseded rows", () => {
  const recent = addEntry("recent", "lesson", {}, "r1");
  supersedeEntry(recent, null);
  // recent superseded just now -> not purged by a 365-day window
  expect(purgeSuperseded(365)).toBe(0);
  // negative window => cutoff in the future => purges everything superseded
  expect(purgeSuperseded(-1)).toBe(1);
  expect(getEntry(recent)).toBeNull();
});

test("toFtsQuery builds OR of quoted tokens and drops junk", () => {
  expect(toFtsQuery("hello world")).toBe('"hello" OR "world"');
  expect(toFtsQuery("a")).toBe("");
  expect(toFtsQuery("  !!!  ")).toBe("");
  expect(toFtsQuery('quote" inject')).toBe('"quote" OR "inject"');
});
