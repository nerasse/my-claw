import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { addEntry, getEntry, closeMemoryDb, clearAllEntries } from "../db.ts";
import { clearRecallCache } from "../cache.ts";
import { recall } from "../recall.ts";
import { hashContent } from "../dedup.ts";
import { mockFetch } from "../../../tests/helpers/mock-fetch.ts";

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
  return addEntry(content, "lesson", embedding ? { m: embedding } : {}, hashContent(content));
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
  addEntry("project uses redis for queue and cache", "lesson", { m: new Float32Array([1, 0]) }, hashContent("project uses redis for queue and cache"));
  addEntry("project uses redis somewhere unrelated", "lesson", { m: new Float32Array([0, 1]) }, hashContent("project uses redis somewhere unrelated"));
  const cfg = { embedding: { backend: "http" as const, model: "m", baseUrl: "http://x" } };

  const mock = mockFetch(async () =>
    new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
      status: 200,
    }));
  try {
    const r = await recall("redis queue cache", cfg);
    expect(r.semantic).toBe(true);
    expect(r.hits[0]!.entry.content).toContain("queue and cache");
  } finally {
    mock.restore();
  }
});

// ---- Degradation: what happens the day there is no embedding at all -------------------------
//
// Every case below is the same promise: memory keeps working. A switched-off consumer, a provider
// that answers 500, a `from` naming a provider that was renamed or removed, a store written by a
// model nobody uses any more -- each one falls back to keywords, and none of them throws.

test("a consumer switched off recalls on keywords, and says it was not semantic", async () => {
  add("project uses redis for queue and cache");
  // The shape the Services page writes: the consumer carries nothing but the switch, and still
  // follows the default for the day it comes back.
  const r = await recall("redis queue", {
    embedding: { backend: "http", model: "m", baseUrl: "http://x" },
    embeddings: { recall: { enabled: false } },
  });
  expect(r.semantic).toBe(false);
  expect(r.hits.length).toBe(1);
});

test("the whole default switched off recalls on keywords", async () => {
  // `memory.embedding` removed is what the Services page writes for `off`: no consumer has a model.
  add("project uses redis for queue and cache");
  const r = await recall("redis queue", {});
  expect(r.semantic).toBe(false);
  expect(r.hits.length).toBe(1);
});

test("a provider that refuses the call degrades to keywords instead of throwing", async () => {
  add("the deploy pipeline runs on forgejo actions");
  const mock = mockFetch(async () => new Response("upstream is down", { status: 503 }));
  try {
    const r = await recall("deploy pipeline", { embedding: { backend: "http", model: "m", baseUrl: "http://x" } });
    expect(r.semantic).toBe(false);
    expect(r.hits.length).toBe(1);
  } finally {
    mock.restore();
  }
});

test("a `from` naming a provider that no longer exists recalls on keywords", async () => {
  // A provider renamed or removed leaves `from` dangling. The endpoint cannot be resolved, so the
  // query embeds to nothing -- and recall must not invent a URL or throw on the hot path.
  add("the mail server runs on mailcow");
  const r = await recall("mail server", { embedding: { backend: "http", model: "m", from: "gone" } });
  expect(r.semantic).toBe(false);
  expect(r.hits.length).toBe(1);
});

test("a store written by another model is not compared: cosine needs the same space", async () => {
  // The entry carries a vector for `old`; recall asks for `new`. No vector in the asked space means
  // keywords alone, rather than a cosine between two unrelated vector spaces.
  addEntry("alpha fact about widgets", "lesson", { old: new Float32Array([1, 0]) }, hashContent("alpha fact about widgets"));
  const mock = mockFetch(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 }));
  try {
    const r = await recall("alpha widgets", { embedding: { backend: "http", model: "new", baseUrl: "http://x" } });
    expect(r.semantic).toBe(true);
    expect(r.hits[0]!.cosine).toBeNull();
    expect(r.hits.length).toBe(1);
  } finally {
    mock.restore();
  }
});

test("an endpoint that answers rows misaligned with the ask yields no vectors, not wrong ones", async () => {
  // A misplaced vector indexes the wrong text for good. The response names its own indices, so a
  // hole means "refused", and recall stays on keywords rather than pairing a fact with a stranger.
  add("gamma knowledge about caching layers");
  const mock = mockFetch(async () =>
    new Response(JSON.stringify({ data: [{ index: 3, embedding: [1, 0] }] }), { status: 200 }));
  try {
    const r = await recall("gamma caching", { embedding: { backend: "http", model: "m", baseUrl: "http://x" } });
    expect(r.semantic).toBe(false);
    expect(r.hits.length).toBe(1);
  } finally {
    mock.restore();
  }
});
