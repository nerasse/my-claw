import { test, expect, afterEach } from "bun:test";
import {
  cosineSimilarity,
  isEmbeddingEnabled,
  isEmbeddingReady,
  warmupEmbedding,
  embed,
  embedMany,
  resetEmbeddingState,
  setEmbeddingProviders,
} from "../embedding.ts";
import { mockFetch } from "../../../tests/helpers/mock-fetch.ts";

let mock: { restore(): void } | undefined;

afterEach(() => {
  mock?.restore();
  mock = undefined;
  resetEmbeddingState();
  setEmbeddingProviders(() => ({}));
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

test("embed comes from a provider by name: its URL and its key, not memory's own", async () => {
  const saved = process.env["TEST_GEMINI_KEY"];
  process.env["TEST_GEMINI_KEY"] = "k-123";
  setEmbeddingProviders(() => ({
    gemini: { baseUrl: "https://gemini.test/v1beta/openai", apiKeyEnv: "TEST_GEMINI_KEY" },
  }));
  const seen: Array<{ url: string; auth?: string }> = [];
  mock = mockFetch(async (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), auth: headers.get("authorization") ?? undefined });
    return Response.json({ data: [{ embedding: [1, 0] }] });
  });
  const vec = await embed("hi", { backend: "http", from: "gemini", model: "gemini-embedding-001" });
  expect(Array.from(vec!)).toEqual([1, 0]);
  expect(seen).toEqual([{ url: "https://gemini.test/v1beta/openai/embeddings", auth: "Bearer k-123" }]);
  if (saved === undefined) delete process.env["TEST_GEMINI_KEY"];
  else process.env["TEST_GEMINI_KEY"] = saved;
});

test("a provider that is gone resolves nothing, and the call degrades instead of throwing", async () => {
  setEmbeddingProviders(() => ({}));
  expect(await embed("hi", { backend: "http", from: "vanished", model: "m" })).toBeNull();
});

test("embedMany asks one call per batch, in order, and keeps the response's own indices", async () => {
  const bodies: Array<{ input: string[]; model: string }> = [];
  mock = mockFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[]; model: string };
    bodies.push(body);
    // Deliberately out of order, with explicit indices: providers do not promise sorted rows.
    return Response.json({
      data: body.input.map((_, i) => ({ index: i, embedding: [i + 1, 0] })).reverse(),
    });
  });
  const texts = Array.from({ length: 95 }, (_, i) => `text ${i}`);
  const vectors = await embedMany(texts, { backend: "http", model: "m", baseUrl: "http://h/v1" });
  // 95 texts, batches of 40: three calls, the last one short.
  expect(bodies.map((b) => b.input.length)).toEqual([40, 40, 15]);
  expect(vectors).toHaveLength(95);
  // Each vector belongs to its own text: the first row of batch one answers text 0.
  expect(Array.from(vectors[0]!)).toEqual([1, 0]);
  expect(Array.from(vectors[40]!)).toEqual([1, 0]);
  expect(Array.from(vectors[94]!)).toEqual([15, 0]);
});

test("embedMany falls back to one call per text when the endpoint refuses a batch", async () => {
  let calls = 0;
  mock = mockFetch(async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    if (body.input.length > 1) return new Response("too many", { status: 400 });
    return Response.json({ data: [{ embedding: [1, 0] }] });
  });
  const vectors = await embedMany(["a", "b", "c"], { backend: "http", model: "m", baseUrl: "http://h/v1" });
  expect(vectors.every((v) => v !== null)).toBe(true);
  expect(calls).toBe(4);
});

test("embedMany skips an empty text without shifting the ones after it", async () => {
  const seen: string[][] = [];
  mock = mockFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    seen.push(body.input);
    return Response.json({ data: body.input.map((_, i) => ({ index: i, embedding: [i + 1, 0] })) });
  });
  const vectors = await embedMany(["a", "", "c"], { backend: "http", model: "m", baseUrl: "http://h/v1" });
  expect(seen).toEqual([["a", "c"]]);
  expect(vectors[1]).toBeNull();
  expect(Array.from(vectors[0]!)).toEqual([1, 0]);
  expect(Array.from(vectors[2]!)).toEqual([2, 0]);
});
