import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { addEntry, getEntry, closeMemoryDb, clearAllEntries } from "../db.ts";
import { clearRecallCache } from "../cache.ts";
import { recall } from "../recall.ts";
import { hashContent } from "../dedup.ts";

const DB = join(tmpdir(), `mc-recall-${process.pid}-${Date.now()}.db`);

beforeAll(() => {
  process.env["MY_CLAW_MEMORY_DB"] = DB;
  closeMemoryDb();
});
afterAll(() => {
  closeMemoryDb();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
  delete process.env["MY_CLAW_MEMORY_DB"];
});
beforeEach(() => {
  clearAllEntries();
  clearRecallCache();
});

function add(content: string, embedding: Float32Array | null = null) {
  return addEntry(content, "lesson", embedding, hashContent(content));
}

test("trivial queries return empty", async () => {
  add("the server runs on port 8080");
  expect((await recall("/start")).hits).toEqual([]);
  expect((await recall("ok")).hits).toEqual([]);
});

test("fts-only recall finds matching entry", async () => {
  add("the deployment pipeline uses github actions");
  const r = await recall("how does the deployment pipeline work");
  expect(r.semantic).toBe(false);
  expect(r.hits.length).toBe(1);
  expect(r.text).toContain("deployment pipeline");
});

test("recall respects maxEntries", async () => {
  for (let i = 0; i < 10; i++) add(`alpha fact number ${i} about widgets`);
  const r = await recall("alpha widgets", { recallMaxEntries: 3 });
  expect(r.hits.length).toBe(3);
});

test("recall caps text length", async () => {
  for (let i = 0; i < 10; i++) add(`beta entry ${i} ${"x".repeat(100)}`);
  const r = await recall("beta entry", { recallMaxEntries: 10, recallMaxChars: 150 });
  expect(r.text.length).toBeLessThanOrEqual(160);
});

test("recall increments access count of returned hits", async () => {
  const id = add("gamma knowledge about caching layers");
  await recall("gamma caching");
  expect(getEntry(id)?.accessCount).toBe(1);
});

test("recall returns empty when nothing matches", async () => {
  add("totally unrelated content");
  const r = await recall("xyzzy nonexistent terms");
  expect(r.hits).toEqual([]);
  expect(r.text).toBe("");
});

test("recall caches identical queries", async () => {
  const id = add("delta entry about logging");
  await recall("delta logging");
  // Second call should be served from cache -> access count not bumped again.
  await recall("delta logging");
  expect(getEntry(id)?.accessCount).toBe(1);
});

test("hybrid recall blends cosine when embeddings present", async () => {
  // Two entries share keywords; embeddings decide ordering. Tagged with the query's model.
  addEntry("project uses redis for queue and cache", "lesson", new Float32Array([1, 0]), hashContent("project uses redis for queue and cache"), "m");
  addEntry("project uses redis somewhere unrelated", "lesson", new Float32Array([0, 1]), hashContent("project uses redis somewhere unrelated"), "m");
  const cfg = { embedding: { backend: "http" as const, model: "m", baseUrl: "http://x" } };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
      status: 200,
    })) as unknown as typeof fetch;
  try {
    const r = await recall("redis queue cache", cfg);
    expect(r.semantic).toBe(true);
    expect(r.hits[0]!.entry.content).toContain("queue and cache");
  } finally {
    globalThis.fetch = realFetch;
  }
});
