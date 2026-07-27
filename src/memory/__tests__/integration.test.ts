import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, mkdtempSync } from "node:fs";
import {
  remember,
  recall,
  update,
  forget,
  list,
  count,
  consolidateMemory,
  backfillEmbeddings,
  closeMemoryDb,
  type LlmCaller,
} from "../index.ts";
import { clearAllEntries, getActiveNeedingEmbedding, addEntry } from "../db.ts";
import { hashContent } from "../dedup.ts";
import { mockFetch } from "../../../tests/helpers/mock-fetch.ts";

const DB = join(tmpdir(), `mc-integ-${process.pid}-${Date.now()}.db`);
let workspace: string;
let savedWs: string | undefined;
let savedDb: string | undefined;

beforeAll(() => {
  savedWs = process.env["MY_CLAW_WORKSPACE"];
  savedDb = process.env["MY_CLAW_MEMORY_DB"];
  process.env["MY_CLAW_MEMORY_DB"] = DB;
  workspace = mkdtempSync(join(tmpdir(), "mc-integ-ws-"));
  process.env["MY_CLAW_WORKSPACE"] = workspace;
  closeMemoryDb();
});
afterAll(() => {
  closeMemoryDb();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
  rmSync(workspace, { recursive: true, force: true });
  if (savedDb === undefined) delete process.env["MY_CLAW_MEMORY_DB"];
  else process.env["MY_CLAW_MEMORY_DB"] = savedDb;
  if (savedWs === undefined) delete process.env["MY_CLAW_WORKSPACE"];
  else process.env["MY_CLAW_WORKSPACE"] = savedWs;
});
beforeEach(() => clearAllEntries());

test("remember then recall round-trip", async () => {
  const r = await remember("User prefers concise answers", "user");
  expect(r.decision).toBe("add");
  const recalled = await recall("how does the user like answers");
  expect(recalled.text).toContain("concise answers");
});

test("remember skips exact duplicates", async () => {
  await remember("The CI runs on debian-bookworm", "environment");
  const dup = await remember("The CI runs on debian-bookworm", "environment");
  expect(dup.decision).toBe("skip");
  expect(count()).toBe(1);
});

test("update supersedes and recall reflects new value", async () => {
  await remember("API base url is http://old", "environment");
  await update("API base url is http://old", "API base url is http://new");
  const list1 = list();
  expect(list1.some((e) => e.content.includes("http://new"))).toBe(true);
  expect(list1.some((e) => e.content.includes("http://old"))).toBe(false);
});

test("forget soft-deletes", async () => {
  await remember("ephemeral note about widgets", "lesson");
  const f = forget("ephemeral note about widgets");
  expect(f.forgotten).toBe(true);
  expect(count()).toBe(0);
});

test("end-to-end: store many then consolidate", async () => {
  for (let i = 0; i < 6; i++) await remember(`lesson learned item ${i}`, "lesson");
  expect(count()).toBe(6);
  const caller: LlmCaller = async () => "Consolidated lesson one\nConsolidated lesson two";
  await consolidateMemory(caller);
  const active = list("lesson").map((e) => e.content).sort();
  expect(active).toEqual(["Consolidated lesson one", "Consolidated lesson two"]);
});

test("list by category isolates entries", async () => {
  await remember("user fact", "user");
  await remember("project fact", "project");
  expect(list("user").map((e) => e.content)).toEqual(["user fact"]);
  expect(list("project").map((e) => e.content)).toEqual(["project fact"]);
});

test("backfill embeds entries stored while FTS5-only", async () => {
  // Stored with no embedding configured -> embedding is NULL.
  await remember("fact stored before embeddings existed", "lesson");
  await remember("another older fact", "lesson");
  expect(getActiveNeedingEmbedding("m").length).toBe(2);

  const mock = mockFetch(async () =>
    new Response(JSON.stringify({ data: [{ embedding: [0.6, 0.8] }] }), {
      status: 200,
    }));
  try {
    const cfg = { embedding: { backend: "http" as const, model: "m", baseUrl: "http://x" } };
    const n = await backfillEmbeddings(cfg);
    expect(n).toBe(2);
    expect(getActiveNeedingEmbedding("m").length).toBe(0);
  } finally {
    mock.restore();
  }
});

test("backfill re-embeds entries from a different model", async () => {
  // Seed an entry already embedded by an "old" model.
  addEntry("fact embedded by old model", "lesson", new Float32Array([1, 0]), hashContent("fact embedded by old model"), "old-model");
  expect(getActiveNeedingEmbedding("new-model").length).toBe(1);

  const mock = mockFetch(async () =>
    new Response(JSON.stringify({ data: [{ embedding: [0.6, 0.8] }] }), {
      status: 200,
    }));
  try {
    const cfg = { embedding: { backend: "http" as const, model: "new-model", baseUrl: "http://x" } };
    expect(await backfillEmbeddings(cfg)).toBe(1);
    expect(getActiveNeedingEmbedding("new-model").length).toBe(0);
  } finally {
    mock.restore();
  }
});

test("backfill is a no-op when embeddings are disabled", async () => {
  await remember("a fact", "lesson");
  expect(await backfillEmbeddings({})).toBe(0);
  expect(getActiveNeedingEmbedding("m").length).toBe(1);
});
