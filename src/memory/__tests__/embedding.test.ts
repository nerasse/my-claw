import { test, expect, afterEach } from "bun:test";
import {
  cosineSimilarity,
  isEmbeddingEnabled,
  isEmbeddingReady,
  warmupEmbedding,
  embed,
  resetEmbeddingState,
} from "../embedding.ts";
import { mockFetch } from "../../../tests/helpers/mock-fetch.ts";

let mock: { restore(): void } | undefined;

afterEach(() => {
  mock?.restore();
  mock = undefined;
  resetEmbeddingState();
});

test("cosineSimilarity of identical vectors is 1", () => {
  const v = new Float32Array([1, 2, 3]);
  expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
});

test("cosineSimilarity of orthogonal vectors is 0", () => {
  expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 5);
});

test("cosineSimilarity handles shape mismatch and zero vectors", () => {
  expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1, 2, 3]))).toBe(0);
  expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([0, 0]))).toBe(0);
});

test("isEmbeddingEnabled depends on model presence", () => {
  expect(isEmbeddingEnabled(undefined)).toBe(false);
  expect(isEmbeddingEnabled({})).toBe(false);
  expect(isEmbeddingEnabled({ model: "x" })).toBe(true);
});

test("warmup with no config marks ready immediately", async () => {
  await warmupEmbedding(undefined);
  expect(isEmbeddingReady()).toBe(true);
});

test("warmup with http backend marks ready without download", async () => {
  await warmupEmbedding({ backend: "http", model: "m", baseUrl: "http://x" });
  expect(isEmbeddingReady()).toBe(true);
});

test("local embeddings on a release without transformers.js start its install and stay on FTS5 meanwhile", async () => {
  let asked = 0;
  await warmupEmbedding({ backend: "local", model: "Xenova/all-MiniLM-L6-v2" }, { prepare: async () => (asked++, false) });
  expect(asked).toBe(1);
  expect(isEmbeddingReady()).toBe(false);
  expect(await embed("hello", { backend: "local", model: "Xenova/all-MiniLM-L6-v2" })).toBeNull();
});

test("embed returns null when no model configured", async () => {
  expect(await embed("hello", undefined)).toBeNull();
  expect(await embed("hello", {})).toBeNull();
});

test("embed http posts to /embeddings and parses response", async () => {
  let captured: { url: string; body: unknown } | null = null;
  mock = mockFetch(async (url?: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ data: [{ embedding: [0.6, 0.8] }] }), { status: 200 });
  });

  const vec = await embed("hi", { backend: "http", model: "m", baseUrl: "http://host/v1" });
  expect(captured!.url).toBe("http://host/v1/embeddings");
  expect((captured!.body as { model: string }).model).toBe("m");
  expect(Array.from(vec!)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
});

test("embed http returns null on http error", async () => {
  mock = mockFetch(async () => new Response("nope", { status: 500 }));
  const vec = await embed("hi", { backend: "http", model: "m", baseUrl: "http://host/v1" });
  expect(vec).toBeNull();
});

test("embed http truncates and renormalizes to requested dimensions", async () => {
  mock = mockFetch(async () =>
    new Response(JSON.stringify({ data: [{ embedding: [3, 4, 100, 100] }] }), {
      status: 200,
    }));
  const vec = await embed("hi", { backend: "http", model: "m", baseUrl: "http://h", dimensions: 2 });
  expect(vec!.length).toBe(2);
  // [3,4] normalized -> [0.6, 0.8]
  expect(Array.from(vec!)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
});

test("local embed returns null before warm-up", async () => {
  resetEmbeddingState();
  const vec = await embed("hi", { backend: "local", model: "Xenova/all-MiniLM-L6-v2" });
  expect(vec).toBeNull();
});
