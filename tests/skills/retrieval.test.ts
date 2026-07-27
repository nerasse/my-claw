import { test, expect, afterEach } from "bun:test";
import type { SkillInfo } from "../../src/skills/types.ts";
import {
  dynamicTopK,
  selectRelevantSkills,
  resetSkillVectorCache,
  skillVectorCacheSize,
} from "../../src/skills/retrieval.ts";
import { warmupEmbedding, resetEmbeddingState } from "../../src/memory/embedding.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

let mock: { restore(): void } | undefined;

afterEach(() => {
  mock?.restore();
  mock = undefined;
  resetEmbeddingState();
  resetSkillVectorCache();
});

function skill(name: string, description: string): SkillInfo {
  return { name, description, source: "built-in", path: `/skills/${name}` };
}

const SKILLS: SkillInfo[] = [
  skill("video", "convert and edit video files"),
  skill("media", "process media assets"),
  skill("email", "send emails to contacts"),
];

// Map each embedding request to a deterministic 2D vector by keyword in the input text, so cosine
// ranking against a "video" query is predictable: video is colinear, media close, email orthogonal.
function mockEmbeddings(): void {
  mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
    const input = String((JSON.parse(String(init?.body)) as { input: string }).input).toLowerCase();
    let vec = [0, 0.0001];
    if (input.includes("video")) vec = [1, 0];
    else if (input.includes("media")) vec = [0.9, 0.436];
    else if (input.includes("email")) vec = [0, 1];
    return new Response(JSON.stringify({ data: [{ embedding: vec }] }), { status: 200 });
  });
}

const EMBED_CFG = { backend: "http" as const, model: "m", baseUrl: "http://host/v1" };

test("dynamicTopK scales with registry size, floor 5, cap 15", () => {
  expect(dynamicTopK(5)).toBe(5);
  expect(dynamicTopK(10)).toBe(5);
  expect(dynamicTopK(12)).toBe(6);
  expect(dynamicTopK(16)).toBe(8);
  expect(dynamicTopK(20)).toBe(10);
  expect(dynamicTopK(30)).toBe(15);
  expect(dynamicTopK(40)).toBe(15);
});

test("disabled returns nothing", async () => {
  const out = await selectRelevantSkills(SKILLS, "convert video files", undefined, { enabled: false });
  expect(out).toEqual([]);
});

test("empty query returns nothing", async () => {
  expect(await selectRelevantSkills(SKILLS, "   ", undefined, undefined)).toEqual([]);
});

test("empty registry returns nothing", async () => {
  expect(await selectRelevantSkills([], "convert video files", undefined, undefined)).toEqual([]);
});

test("keyword fallback ranks matching skills when no embedding model", async () => {
  const out = await selectRelevantSkills(SKILLS, "convert video files", undefined, undefined);
  expect(out.length).toBeGreaterThan(0);
  expect(out[0]!.name).toBe("video");
  expect(out.map((s) => s.name)).not.toContain("email");
});

test("embedding ranking orders by similarity and drops below minScore", async () => {
  mockEmbeddings();
  await warmupEmbedding(EMBED_CFG);
  const out = await selectRelevantSkills(SKILLS, "convert my video", EMBED_CFG, undefined);
  expect(out.map((s) => s.name)).toEqual(["video", "media"]);
});

test("embedding runtime failure falls back to keyword", async () => {
  mock = mockFetch(async () => new Response("nope", { status: 500 }));
  await warmupEmbedding(EMBED_CFG);
  const out = await selectRelevantSkills(SKILLS, "convert video files", EMBED_CFG, undefined);
  expect(out[0]!.name).toBe("video");
});

test("explicit topK overrides the dynamic curve", async () => {
  const out = await selectRelevantSkills(SKILLS, "convert video files", undefined, { topK: 1 });
  expect(out.length).toBe(1);
  expect(out[0]!.name).toBe("video");
});

test("custom minScore filters more aggressively (embedding mode)", async () => {
  mockEmbeddings();
  await warmupEmbedding(EMBED_CFG);
  // media scores ~0.9, video 1.0; a 0.95 floor keeps only video.
  const out = await selectRelevantSkills(SKILLS, "convert my video", EMBED_CFG, { minScore: 0.95 });
  expect(out.map((s) => s.name)).toEqual(["video"]);
});

test("cache stays bounded to the current registry: edits/removals are evicted", async () => {
  mockEmbeddings();
  await warmupEmbedding(EMBED_CFG);

  await selectRelevantSkills(SKILLS, "convert my video", EMBED_CFG, undefined);
  expect(skillVectorCacheSize()).toBe(3);

  // Edit one description and drop another: an edited skill yields a new key (re-embed), the removed
  // one disappears. The cache must shrink to exactly the new registry, not accumulate stale vectors.
  const changed: SkillInfo[] = [
    skill("video", "handle video and audio media"),
    skill("media", "process media assets"),
  ];
  await selectRelevantSkills(changed, "convert my video", EMBED_CFG, undefined);
  expect(skillVectorCacheSize()).toBe(2);
});
